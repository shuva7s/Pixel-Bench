//! Pre/post-processing for background removal (pure functions).

use serde::Deserialize;

use crate::models::ModelId;

const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Square RGBA → the model's normalised CHW float input. BiRefNet expects
/// x/255; U²-Net divides by the image maximum first (as in its reference
/// code). Both then apply ImageNet mean/std.
pub fn segment_input(rgba: &[u8], size: usize, model: ModelId) -> Vec<f32> {
    let plane = size * size;
    let mut out = vec![0.0f32; 3 * plane];
    let scale = if model == ModelId::U2Netp {
        let max = rgba
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .max()
            .unwrap_or(1)
            .max(1);
        1.0 / f32::from(max)
    } else {
        1.0 / 255.0
    };
    for (i, p) in rgba.chunks_exact(4).enumerate().take(plane) {
        for c in 0..3 {
            out[c * plane + i] = (f32::from(p[c]) * scale - MEAN[c]) / STD[c];
        }
    }
    out
}

/// Raw output → 8-bit mask (BiRefNet: logits → sigmoid; U²-Net: min-max).
pub fn segment_output(raw: &[f32], model: ModelId) -> Vec<u8> {
    if model == ModelId::U2Netp {
        let (min, max) = raw
            .iter()
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| {
                (lo.min(v), hi.max(v))
            });
        let range = (max - min).max(1e-6);
        raw.iter()
            .map(|&v| ((v - min) / range * 255.0).round() as u8)
            .collect()
    } else {
        raw.iter()
            .map(|&v| (255.0 / (1.0 + (-v).exp())).round() as u8)
            .collect()
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeSettings {
    /// 0 = the model's soft edge, 100 = a hard cut.
    pub hardness: f32,
    /// −50..50: negative trims the subject, positive grows it.
    pub shift: f32,
    /// 0..100: 100 blurs the edge by 1% of the image's long side.
    pub feather: f32,
}

/// Applies hardness/shift as a tone curve, then feathers by `feather_px`.
pub fn refine_mask(
    mask: &[u8],
    width: usize,
    height: usize,
    edges: EdgeSettings,
    feather_px: f32,
) -> Vec<u8> {
    let mut out = if edges.hardness == 0.0 && edges.shift == 0.0 {
        mask.to_vec()
    } else {
        let threshold = 0.5 - edges.shift / 100.0;
        let span = 1.0 - edges.hardness.clamp(0.0, 100.0) / 100.0 * 0.98;
        let lut: Vec<u8> = (0..256)
            .map(|v| {
                let a = (v as f32 / 255.0 - threshold) / span + 0.5;
                (a.clamp(0.0, 1.0) * 255.0).round() as u8
            })
            .collect();
        mask.iter().map(|&v| lut[usize::from(v)]).collect()
    };
    let radius = feather_px.round() as usize;
    if radius > 0 {
        out = box_blur(
            &box_blur(&out, width, height, radius),
            width,
            height,
            radius,
        );
    }
    out
}

/// Separable box blur of a single-channel image.
pub fn box_blur(src: &[u8], width: usize, height: usize, radius: usize) -> Vec<u8> {
    let mut tmp = vec![0u8; src.len()];
    let mut out = vec![0u8; src.len()];
    let pass =
        |from: &[u8], to: &mut [u8], len: usize, lines: usize, step: usize, line_step: usize| {
            let n = (2 * radius + 1) as u32;
            for l in 0..lines {
                let base = l * line_step;
                let at =
                    |i: isize| u32::from(from[base + i.clamp(0, len as isize - 1) as usize * step]);
                let r = radius as isize;
                let mut sum: u32 = (-r..=r).map(at).sum();
                for i in 0..len {
                    to[base + i * step] = ((sum + n / 2) / n) as u8;
                    sum = sum + at(i as isize + r + 1) - at(i as isize - r);
                }
            }
        };
    pass(src, &mut tmp, width, height, 1, width);
    pass(&tmp, &mut out, height, width, width, 1);
    out
}

/// What goes behind the masked subject.
pub enum Backdrop<'a> {
    Transparent,
    Color([u8; 3]),
    /// RGBA pixels of the same size as the foreground.
    Pixels(&'a [u8]),
}

/// Places the masked foreground over the backdrop. Returns new RGBA pixels.
pub fn composite(fg: &[u8], mask: &[u8], backdrop: &Backdrop<'_>) -> Vec<u8> {
    let mut out = vec![0u8; fg.len()];
    for (p, (o, f)) in out.chunks_exact_mut(4).zip(fg.chunks_exact(4)).enumerate() {
        let a = f32::from(mask[p]) * f32::from(f[3]) / 255.0;
        match backdrop {
            Backdrop::Transparent => {
                o[..3].copy_from_slice(&f[..3]);
                o[3] = a.round() as u8;
            }
            Backdrop::Color(c) => {
                let t = a / 255.0;
                for i in 0..3 {
                    o[i] = (f32::from(f[i]) * t + f32::from(c[i]) * (1.0 - t)).round() as u8;
                }
                o[3] = 255;
            }
            Backdrop::Pixels(bg) => {
                let t = a / 255.0;
                let b = &bg[p * 4..p * 4 + 4];
                for i in 0..3 {
                    o[i] = (f32::from(f[i]) * t + f32::from(b[i]) * (1.0 - t)).round() as u8;
                }
                o[3] = (a + f32::from(b[3]) * (1.0 - t)).round() as u8;
            }
        }
    }
    out
}

/// Bilinear resize of a single-channel mask.
pub fn resize_mask(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh];
    let (sx, sy) = (sw as f32 / dw as f32, sh as f32 / dh as f32);
    for y in 0..dh {
        let fy = ((y as f32 + 0.5) * sy - 0.5).max(0.0);
        let y0 = (fy.floor() as usize).min(sh - 1);
        let y1 = (y0 + 1).min(sh - 1);
        let wy = fy - y0 as f32;
        for x in 0..dw {
            let fx = ((x as f32 + 0.5) * sx - 0.5).max(0.0);
            let x0 = (fx.floor() as usize).min(sw - 1);
            let x1 = (x0 + 1).min(sw - 1);
            let wx = fx - x0 as f32;
            let at = |xx: usize, yy: usize| f32::from(src[yy * sw + xx]);
            let top = at(x0, y0) * (1.0 - wx) + at(x1, y0) * wx;
            let bottom = at(x0, y1) * (1.0 - wx) + at(x1, y1) * wx;
            out[y * dw + x] = (top * (1.0 - wy) + bottom * wy).round() as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_inputs_like_the_reference_code() {
        let rgba = [
            255, 0, 128, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
        ];
        let x = segment_input(&rgba, 2, ModelId::BiRefNetLite);
        assert!((x[0] - (1.0 - 0.485) / 0.229).abs() < 1e-5);
        assert!((x[4 + 1] - (1.0 - 0.456) / 0.224).abs() < 1e-5);
        let u = segment_input(&[100, 50, 0, 255], 1, ModelId::U2Netp);
        assert!((u[0] - (1.0 - 0.485) / 0.229).abs() < 1e-5);
        assert!((u[1] - (0.5 - 0.456) / 0.224).abs() < 1e-5);
    }

    #[test]
    fn maps_outputs_to_masks() {
        assert_eq!(
            segment_output(&[-20.0, 0.0, 20.0], ModelId::BiRefNetLite),
            [0, 128, 255]
        );
        assert_eq!(
            segment_output(&[0.2, 0.6, 1.0], ModelId::U2Netp),
            [0, 128, 255]
        );
    }

    #[test]
    fn refines_edges() {
        let ramp: Vec<u8> = (0..=255).collect();
        let e = |h, s| EdgeSettings {
            hardness: h,
            shift: s,
            feather: 0.0,
        };
        assert_eq!(refine_mask(&ramp, 256, 1, e(0.0, 0.0), 0.0), ramp);
        let hard = refine_mask(&ramp, 256, 1, e(100.0, 0.0), 0.0);
        assert_eq!((hard[100], hard[160]), (0, 255));
        assert_eq!(refine_mask(&ramp, 256, 1, e(100.0, 30.0), 0.0)[100], 255);
        assert_eq!(refine_mask(&ramp, 256, 1, e(100.0, -30.0), 0.0)[160], 0);
        let step: Vec<u8> = (0..20).map(|i| if i < 10 { 0 } else { 255 }).collect();
        let soft = box_blur(&step, 20, 1, 2);
        assert!(soft[0] == 0 && soft[19] == 255 && soft[9] > 0 && soft[10] < 255);
    }

    #[test]
    fn composites_onto_backdrops() {
        let fg = [200, 100, 50, 255, 10, 20, 30, 255];
        assert_eq!(
            composite(&fg, &[255, 0], &Backdrop::Transparent),
            [200, 100, 50, 255, 10, 20, 30, 0]
        );
        assert_eq!(
            composite(&fg, &[255, 0], &Backdrop::Color([0, 0, 255])),
            [200, 100, 50, 255, 0, 0, 255, 255]
        );
        let bg = [1, 2, 3, 255, 4, 5, 6, 255];
        assert_eq!(
            &composite(&fg, &[128, 0], &Backdrop::Pixels(&bg))[4..],
            [4, 5, 6, 255]
        );
        let m = resize_mask(&[0, 255], 2, 1, 4, 1);
        assert!(m[0] == 0 && m[3] == 255 && m[1] > 0);
    }
}
