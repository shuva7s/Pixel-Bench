//! Text and logo overlays (watermarks), drawn onto the output pixels. All
//! sizes are relative to the image, so previews (on a downscaled copy) and
//! exports (full resolution) look the same.

use std::collections::HashMap;
use std::sync::OnceLock;

use ab_glyph::{Font, FontArc, FontVec, PxScale, ScaleFont, point};
use image_core::RgbaImage;
use serde::Deserialize;
use tiny_skia::{FilterQuality, Pixmap, PixmapPaint, Transform};

use crate::settings::parse_hex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Anchor {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

impl Anchor {
    /// (column, row), each 0 = start, 1 = middle, 2 = end.
    fn cell(self) -> (u8, u8) {
        match self {
            Anchor::TopLeft => (0, 0),
            Anchor::Top => (1, 0),
            Anchor::TopRight => (2, 0),
            Anchor::Left => (0, 1),
            Anchor::Center => (1, 1),
            Anchor::Right => (2, 1),
            Anchor::BottomLeft => (0, 2),
            Anchor::Bottom => (1, 2),
            Anchor::BottomRight => (2, 2),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontFamily {
    Sans,
    Serif,
    Mono,
    Rounded,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOverlay {
    pub text: String,
    pub font: FontFamily,
    pub bold: bool,
    /// Font size as a percentage of the image's short side.
    pub size: f32,
    pub color: String,
    /// 0–100.
    pub opacity: f32,
    pub anchor: Anchor,
    /// Distance from the edges as a percentage of the short side.
    pub margin: f32,
    pub shadow: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOverlay {
    /// Key of a logo registered with the engine.
    pub image_id: String,
    /// Logo width as a percentage of the image width.
    pub width: f32,
    pub opacity: f32,
    pub anchor: Anchor,
    pub margin: f32,
    /// Repeat the logo diagonally across the whole image.
    pub tile: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Overlay {
    Text(TextOverlay),
    Image(ImageOverlay),
}

impl Overlay {
    /// True when the overlay would draw nothing.
    pub fn is_empty(&self) -> bool {
        match self {
            Overlay::Text(t) => t.text.trim().is_empty() || t.opacity <= 0.0,
            Overlay::Image(i) => i.opacity <= 0.0 || i.width <= 0.0,
        }
    }
}

/// Top-left corner for an `ow × oh` box anchored inside a `w × h` image.
pub fn place_box(anchor: Anchor, w: f32, h: f32, ow: f32, oh: f32, margin: f32) -> (f32, f32) {
    let (col, row) = anchor.cell();
    let pos = |cell: u8, outer: f32, inner: f32| match cell {
        0 => margin,
        2 => outer - inner - margin,
        _ => (outer - inner) / 2.0,
    };
    (pos(col, w, ow), pos(row, h, oh))
}

/// Draws every overlay in order onto `img`.
pub fn draw_overlays(
    img: &mut RgbaImage,
    overlays: &[Overlay],
    logos: &HashMap<String, RgbaImage>,
) {
    for o in overlays.iter().filter(|o| !o.is_empty()) {
        match o {
            Overlay::Text(t) => draw_text(img, t),
            Overlay::Image(i) => {
                if let Some(logo) = logos.get(&i.image_id) {
                    draw_logo(img, i, logo);
                }
            }
        }
    }
}

// ---------------------------------------------------------------- fonts

struct Fonts {
    /// [regular, bold] per family.
    sans: [FontArc; 2],
    mono: [FontArc; 2],
    serif: Option<[FontArc; 2]>,
    rounded: Option<[FontArc; 2]>,
}

fn bundled(bytes: &'static [u8]) -> FontArc {
    FontArc::try_from_slice(bytes).expect("bundled font is valid")
}

/// First installed system font matching one of `families` (regular, bold).
fn system_family(db: &fontdb::Database, families: &[&str]) -> Option<[FontArc; 2]> {
    let load = |weight: fontdb::Weight| -> Option<FontArc> {
        let names: Vec<fontdb::Family> = families.iter().map(|n| fontdb::Family::Name(n)).collect();
        let id = db.query(&fontdb::Query {
            families: &names,
            weight,
            ..fontdb::Query::default()
        })?;
        db.with_face_data(id, |data, index| {
            FontVec::try_from_vec_and_index(data.to_vec(), index).ok()
        })
        .flatten()
        .map(FontArc::new)
    };
    let regular = load(fontdb::Weight::NORMAL)?;
    let bold = load(fontdb::Weight::BOLD).unwrap_or_else(|| regular.clone());
    Some([regular, bold])
}

fn fonts() -> &'static Fonts {
    static FONTS: OnceLock<Fonts> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        Fonts {
            sans: [
                bundled(include_bytes!("../fonts/Geist-Regular.ttf")),
                bundled(include_bytes!("../fonts/Geist-Bold.ttf")),
            ],
            mono: [
                bundled(include_bytes!("../fonts/GeistMono-Regular.ttf")),
                bundled(include_bytes!("../fonts/GeistMono-Bold.ttf")),
            ],
            serif: system_family(
                &db,
                &[
                    "Georgia",
                    "Times New Roman",
                    "Times",
                    "DejaVu Serif",
                    "Liberation Serif",
                    "Noto Serif",
                ],
            ),
            rounded: system_family(
                &db,
                &[
                    "Arial Rounded MT Bold",
                    "Nunito",
                    "Varela Round",
                    "Quicksand",
                    "Comfortaa",
                ],
            ),
        }
    })
}

fn font_for(family: FontFamily, bold: bool) -> &'static FontArc {
    let f = fonts();
    let pair = match family {
        FontFamily::Sans => &f.sans,
        FontFamily::Mono => &f.mono,
        FontFamily::Serif => f.serif.as_ref().unwrap_or(&f.sans),
        FontFamily::Rounded => f.rounded.as_ref().unwrap_or(&f.sans),
    };
    &pair[usize::from(bold)]
}

// ---------------------------------------------------------------- text

/// Straight-alpha "source over" of a solid colour with coverage `a` (0–1).
fn blend_pixel(px: &mut [u8; 4], rgb: [u8; 3], a: f32) {
    if a <= 0.0 {
        return;
    }
    let da = f32::from(px[3]) / 255.0;
    let out_a = a + da * (1.0 - a);
    for c in 0..3 {
        let v = (f32::from(rgb[c]) * a + f32::from(px[c]) * da * (1.0 - a)) / out_a;
        px[c] = v.round().clamp(0.0, 255.0) as u8;
    }
    px[3] = (out_a * 255.0).round() as u8;
}

/// Three box blurs ≈ a Gaussian with standard deviation `sigma`.
fn blur(mask: &mut [f32], w: usize, h: usize, sigma: f32) {
    let r = ((sigma * sigma * 4.0 + 1.0).sqrt() / 2.0).round() as usize;
    if r == 0 {
        return;
    }
    let mut tmp = vec![0.0f32; mask.len()];
    let pass =
        |src: &[f32], dst: &mut [f32], len: usize, lines: usize, step: usize, line_step: usize| {
            let n = (2 * r + 1) as f32;
            for l in 0..lines {
                let base = l * line_step;
                let at = |i: isize| src[base + (i.clamp(0, len as isize - 1) as usize) * step];
                let mut sum: f32 = (-(r as isize)..=r as isize).map(at).sum();
                for i in 0..len {
                    dst[base + i * step] = sum / n;
                    sum += at(i as isize + r as isize + 1) - at(i as isize - r as isize);
                }
            }
        };
    for _ in 0..3 {
        pass(mask, &mut tmp, w, h, 1, w);
        pass(&tmp, mask, h, w, w, 1);
    }
}

fn draw_text(img: &mut RgbaImage, o: &TextOverlay) {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let short = w.min(h);
    let size = (o.size / 100.0 * short).max(1.0);
    let margin = o.margin / 100.0 * short;
    let font = font_for(o.font, o.bold);
    let scaled = font.as_scaled(PxScale::from(size));
    let lines: Vec<&str> = o.text.split('\n').collect();
    let line_height = size * 1.2;
    let width_of = |line: &str| {
        let mut x = 0.0;
        let mut prev = None;
        for c in line.chars() {
            let id = scaled.glyph_id(c);
            if let Some(p) = prev {
                x += scaled.kern(p, id);
            }
            x += scaled.h_advance(id);
            prev = Some(id);
        }
        x
    };
    let widths: Vec<f32> = lines.iter().map(|l| width_of(l)).collect();
    let box_w = widths.iter().copied().fold(0.0, f32::max);
    let box_h = line_height * lines.len() as f32 - (line_height - size);
    let (x0, y0) = place_box(o.anchor, w, h, box_w, box_h, margin);
    let align = match o.anchor.cell().0 {
        0 => 0.0,
        2 => 1.0,
        _ => 0.5,
    };

    // Coverage mask for the text box plus room for the shadow.
    let pad = if o.shadow { (size * 0.5).ceil() } else { 2.0 };
    let (mx, my) = ((x0 - pad).floor(), (y0 - pad).floor());
    let mw = (box_w + 2.0 * pad).ceil() as usize + 2;
    let mh = (box_h + 2.0 * pad).ceil() as usize + 2;
    let mut mask = vec![0.0f32; mw * mh];
    // Like canvas `textBaseline = "top"`: the em box's top edge sits at the line's y.
    let baseline = scaled.ascent() * size / (scaled.ascent() - scaled.descent());
    for (i, line) in lines.iter().enumerate() {
        let mut x = x0 + (box_w - widths[i]) * align - mx;
        let y = y0 + i as f32 * line_height + baseline - my;
        let mut prev = None;
        for c in line.chars() {
            let id = scaled.glyph_id(c);
            if let Some(p) = prev {
                x += scaled.kern(p, id);
            }
            let glyph = id.with_scale_and_position(PxScale::from(size), point(x, y));
            if let Some(outlined) = font.outline_glyph(glyph) {
                let b = outlined.px_bounds();
                outlined.draw(|gx, gy, cov| {
                    let px = b.min.x as i64 + i64::from(gx);
                    let py = b.min.y as i64 + i64::from(gy);
                    if px >= 0 && py >= 0 && (px as usize) < mw && (py as usize) < mh {
                        let m = &mut mask[py as usize * mw + px as usize];
                        *m = (*m + cov).min(1.0);
                    }
                });
            }
            x += scaled.h_advance(id);
            prev = Some(id);
        }
    }

    let opacity = (o.opacity / 100.0).clamp(0.0, 1.0);
    let colour = parse_hex(&o.color).unwrap_or([255, 255, 255]);
    let (iw, ih) = (img.width() as i64, img.height() as i64);
    let mut paint = |m: &[f32], dx: f32, dy: f32, rgb: [u8; 3], alpha: f32| {
        let (ox, oy) = ((mx + dx).round() as i64, (my + dy).round() as i64);
        for yy in 0..mh {
            let py = oy + yy as i64;
            if py < 0 || py >= ih {
                continue;
            }
            for xx in 0..mw {
                let px = ox + xx as i64;
                let cov = m[yy * mw + xx];
                if px < 0 || px >= iw || cov <= 0.0 {
                    continue;
                }
                let p = img.get_pixel_mut(px as u32, py as u32);
                blend_pixel(&mut p.0, rgb, cov * alpha);
            }
        }
    };
    if o.shadow {
        // Matches the canvas shadow (blur = 0.15 × size, offset 0.04 × size, 55% black).
        let mut shadow = mask.clone();
        blur(&mut shadow, mw, mh, size * 0.15 / 2.0);
        paint(&shadow, 0.0, size * 0.04, [0, 0, 0], 0.55 * opacity);
    }
    paint(&mask, 0.0, 0.0, colour, opacity);
}

// ---------------------------------------------------------------- logos

fn to_pixmap(img: &RgbaImage) -> Pixmap {
    let mut pm = Pixmap::new(img.width(), img.height()).expect("non-empty image");
    for (dst, src) in pm
        .data_mut()
        .chunks_exact_mut(4)
        .zip(img.as_raw().chunks_exact(4))
    {
        let a = u16::from(src[3]);
        for c in 0..3 {
            dst[c] = ((u16::from(src[c]) * a + 127) / 255) as u8;
        }
        dst[3] = src[3];
    }
    pm
}

fn from_pixmap(pm: &Pixmap, img: &mut RgbaImage) {
    for (dst, src) in img
        .as_mut()
        .chunks_exact_mut(4)
        .zip(pm.data().chunks_exact(4))
    {
        let a = src[3];
        if a == 0 {
            dst.copy_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        for c in 0..3 {
            dst[c] = ((u16::from(src[c]) * 255 + u16::from(a) / 2) / u16::from(a)).min(255) as u8;
        }
        dst[3] = a;
    }
}

fn draw_logo(img: &mut RgbaImage, o: &ImageOverlay, logo: &RgbaImage) {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let short = w.min(h);
    let ow = (o.width / 100.0 * w).max(1.0);
    let oh = ow * logo.height() as f32 / logo.width() as f32;
    // Resample the logo once to its final size with a high-quality filter.
    let Ok(scaled) = image_core::ops::apply(
        logo.clone(),
        &image_core::Operation::Resize {
            size: image_core::ResizeMode::Exact {
                width: ow.round().max(1.0) as u32,
                height: oh.round().max(1.0) as u32,
            },
            filter: image_core::ResizeFilter::Lanczos3,
        },
        &image_core::DEFAULT_LIMITS,
    ) else {
        return;
    };
    let logo_pm = to_pixmap(&scaled);
    let mut canvas = to_pixmap(img);
    let paint = PixmapPaint {
        opacity: (o.opacity / 100.0).clamp(0.0, 1.0),
        quality: FilterQuality::Bicubic,
        ..PixmapPaint::default()
    };
    if o.tile {
        // Diagonal repeating pattern across the whole image (rotated −30°).
        let (step_x, step_y) = (ow * 1.8, oh * 2.2);
        let reach = w.hypot(h);
        let base = Transform::from_translate(w / 2.0, h / 2.0).pre_rotate(-30.0);
        let mut yy = -reach;
        while yy < reach {
            let offset = ((yy / step_y).round() as i64).rem_euclid(2) as f32 * (step_x / 2.0);
            let mut xx = -reach;
            while xx < reach {
                canvas.draw_pixmap(
                    0,
                    0,
                    logo_pm.as_ref(),
                    &paint,
                    base.pre_translate(xx + offset, yy),
                    None,
                );
                xx += step_x;
            }
            yy += step_y;
        }
    } else {
        let (x, y) = place_box(
            o.anchor,
            w,
            h,
            scaled.width() as f32,
            scaled.height() as f32,
            o.margin / 100.0 * short,
        );
        canvas.draw_pixmap(
            x.round() as i32,
            y.round() as i32,
            logo_pm.as_ref(),
            &paint,
            Transform::identity(),
            None,
        );
    }
    from_pixmap(&canvas, img);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grey(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba([100, 100, 100, 255]))
    }

    fn text(t: &str, anchor: Anchor) -> Overlay {
        Overlay::Text(TextOverlay {
            text: t.into(),
            font: FontFamily::Sans,
            bold: true,
            size: 20.0,
            color: "#ffffff".into(),
            opacity: 100.0,
            anchor,
            margin: 3.0,
            shadow: false,
        })
    }

    fn bright_in(img: &RgbaImage, x0: u32, x1: u32, y0: u32, y1: u32) -> usize {
        (y0..y1)
            .flat_map(|y| (x0..x1).map(move |x| (x, y)))
            .filter(|&(x, y)| img.get_pixel(x, y).0[0] > 200)
            .count()
    }

    #[test]
    fn parses_overlays_from_the_ui() {
        let o: Vec<Overlay> = serde_json::from_str(
            r##"[{"kind":"text","text":"© me","font":"serif","bold":false,"size":6,"color":"#ffffff","opacity":85,"anchor":"bottom-right","margin":3,"shadow":true},
                {"kind":"image","imageId":"logo-1","width":20,"opacity":70,"anchor":"top-left","margin":3,"tile":false}]"##,
        )
        .unwrap();
        assert!(matches!(&o[0], Overlay::Text(t) if t.anchor == Anchor::BottomRight));
        assert!(matches!(&o[1], Overlay::Image(i) if i.image_id == "logo-1"));
    }

    #[test]
    fn text_is_drawn_at_its_anchor() {
        let mut img = grey(200, 100);
        draw_overlays(
            &mut img,
            &[text("Hi", Anchor::BottomRight)],
            &HashMap::new(),
        );
        assert!(
            bright_in(&img, 100, 200, 50, 100) > 50,
            "text in the bottom-right quarter"
        );
        assert_eq!(
            bright_in(&img, 0, 100, 0, 50),
            0,
            "nothing in the top-left quarter"
        );
        let mut left = grey(200, 100);
        draw_overlays(&mut left, &[text("Hi", Anchor::TopLeft)], &HashMap::new());
        assert!(bright_in(&left, 0, 100, 0, 50) > 50);
    }

    #[test]
    fn empty_or_invisible_overlays_draw_nothing() {
        let mut img = grey(64, 64);
        let mut hidden = text("Hi", Anchor::Center);
        if let Overlay::Text(t) = &mut hidden {
            t.opacity = 0.0;
        }
        draw_overlays(
            &mut img,
            &[text("  ", Anchor::Center), hidden],
            &HashMap::new(),
        );
        assert_eq!(img, grey(64, 64));
    }

    #[test]
    fn shadow_darkens_below_the_text() {
        let mut img = grey(200, 100);
        let mut o = text("Hi", Anchor::Center);
        if let Overlay::Text(t) = &mut o {
            t.shadow = true;
        }
        draw_overlays(&mut img, &[o], &HashMap::new());
        assert!(
            img.pixels().any(|p| p.0[0] < 90),
            "some pixels are darker than the background"
        );
    }

    #[test]
    fn logos_are_placed_tiled_and_keep_transparency() {
        let mut logo = RgbaImage::from_pixel(10, 10, image::Rgba([255, 0, 0, 255]));
        logo.put_pixel(0, 0, image::Rgba([0, 0, 0, 0]));
        let logos = HashMap::from([("l".to_string(), logo)]);
        let place = |tile: bool| {
            let mut img = grey(200, 100);
            let o = Overlay::Image(ImageOverlay {
                image_id: "l".into(),
                width: 10.0,
                opacity: 100.0,
                anchor: Anchor::TopLeft,
                margin: 0.0,
                tile,
            });
            draw_overlays(&mut img, &[o], &logos);
            img
        };
        let single = place(false);
        let red = |img: &RgbaImage| img.pixels().filter(|p| p.0[0] > 200 && p.0[1] < 60).count();
        assert!(single.get_pixel(10, 10).0[0] > 200);
        assert!(single.get_pixel(150, 80).0 == [100, 100, 100, 255]);
        assert!(
            (300..=420).contains(&red(&single)),
            "a 20×20 logo: {}",
            red(&single)
        );
        assert!(
            red(&place(true)) > 3 * red(&single),
            "tiled logos cover more of the image"
        );
    }

    #[test]
    fn anchors_place_boxes() {
        assert_eq!(
            place_box(Anchor::TopLeft, 100.0, 50.0, 10.0, 10.0, 5.0),
            (5.0, 5.0)
        );
        assert_eq!(
            place_box(Anchor::BottomRight, 100.0, 50.0, 10.0, 10.0, 5.0),
            (85.0, 35.0)
        );
        assert_eq!(
            place_box(Anchor::Center, 100.0, 50.0, 10.0, 10.0, 5.0),
            (45.0, 20.0)
        );
    }
}
