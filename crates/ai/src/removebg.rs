//! Compositing a cut-out onto a new backdrop, for previews (on a cached
//! proxy) and full-resolution exports. Changing edges or the backdrop never
//! re-runs the model.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use image_core::{DEFAULT_LIMITS, Develop, Operation, ResizeFilter, ResizeMode, RgbaImage};
use serde::Deserialize;

use crate::error::Result;
use crate::mask::{Backdrop, EdgeSettings, composite, refine_mask, resize_mask};

/// What goes behind the cut-out subject.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BackdropSpec {
    Transparent,
    Color {
        color: [u8; 3],
    },
    /// The original photo, blurred (0..100, relative to the image size).
    Blur {
        amount: f32,
    },
    /// The registered backdrop image, scaled to cover.
    Image,
}

struct View {
    image: Arc<RgbaImage>,
    mask: Vec<u8>,
    blur: Option<(u32, Vec<u8>)>,
}

/// A segmented image: the model's mask plus cached preview views.
pub struct Cutout {
    mask: Vec<u8>,
    size: usize,
    /// Keyed by preview long side (0 = full resolution).
    views: Mutex<HashMap<u32, View>>,
}

impl Cutout {
    pub fn new(mask: Vec<u8>, size: usize) -> Self {
        Cutout {
            mask,
            size,
            views: Mutex::default(),
        }
    }

    /// Fraction of pixels kept (≥ 50%) in the raw mask.
    pub fn kept_fraction(&self) -> f64 {
        self.mask.iter().filter(|&&v| v >= 128).count() as f64 / self.mask.len().max(1) as f64
    }

    /// Composites `image` (full resolution) at `max_side` (None = full size).
    /// `mask_only` returns the refined mask as grey pixels.
    pub fn render(
        &self,
        image: &RgbaImage,
        max_side: Option<u32>,
        edges: EdgeSettings,
        backdrop: &BackdropSpec,
        backdrop_image: Option<&RgbaImage>,
        mask_only: bool,
    ) -> Result<RgbaImage> {
        let key = match max_side {
            Some(s) if s < image.width().max(image.height()) => s,
            _ => 0,
        };
        let mut views = self.views.lock().unwrap();
        let view = match views.entry(key) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => {
                let view_img = if key == 0 {
                    Arc::new(image.clone())
                } else {
                    Arc::new(image_core::thumbnail(image, key, &DEFAULT_LIMITS)?)
                };
                let mask = resize_mask(
                    &self.mask,
                    self.size,
                    self.size,
                    view_img.width() as usize,
                    view_img.height() as usize,
                );
                e.insert(View {
                    image: view_img,
                    mask,
                    blur: None,
                })
            }
        };
        let (w, h) = (view.image.width() as usize, view.image.height() as usize);
        // Feather 100 blurs the edge by 1% of the long side.
        let feather_px = edges.feather / 100.0 * 0.01 * w.max(h) as f32;
        let alpha = refine_mask(&view.mask, w, h, edges, feather_px);
        let pixels = if mask_only {
            alpha.iter().flat_map(|&a| [a, a, a, 255]).collect()
        } else {
            let cover;
            let bd = match backdrop {
                BackdropSpec::Transparent => Backdrop::Transparent,
                BackdropSpec::Color { color } => Backdrop::Color(*color),
                BackdropSpec::Blur { amount } => {
                    let amount = amount.round().clamp(0.0, 100.0) as u32;
                    if view.blur.as_ref().is_none_or(|(a, _)| *a != amount) {
                        let develop = Develop {
                            blur: amount as f32,
                            ..Develop::default()
                        };
                        let blurred = image_core::ops::apply(
                            (*view.image).clone(),
                            &Operation::Develop(Box::new(develop)),
                            &DEFAULT_LIMITS,
                        )?;
                        view.blur = Some((amount, blurred.into_raw()));
                    }
                    Backdrop::Pixels(&view.blur.as_ref().unwrap().1)
                }
                BackdropSpec::Image => match backdrop_image {
                    Some(bg) => {
                        cover = cover_resize(bg, w as u32, h as u32)?;
                        Backdrop::Pixels(cover.as_raw())
                    }
                    None => Backdrop::Transparent,
                },
            };
            composite(view.image.as_raw(), &alpha, &bd)
        };
        // Full-size views are large; don't keep them after an export.
        if key == 0 {
            views.remove(&0);
        }
        Ok(RgbaImage::from_raw(w as u32, h as u32, pixels).expect("sized buffer"))
    }
}

/// Scales `bg` to cover `w × h` and crops the centre.
pub fn cover_resize(bg: &RgbaImage, w: u32, h: u32) -> Result<RgbaImage> {
    let s = (f64::from(w) / f64::from(bg.width())).max(f64::from(h) / f64::from(bg.height()));
    let (sw, sh) = (
        ((f64::from(bg.width()) * s).ceil() as u32).max(w),
        ((f64::from(bg.height()) * s).ceil() as u32).max(h),
    );
    let scaled = image_core::ops::apply(
        bg.clone(),
        &Operation::Resize {
            size: ResizeMode::Exact {
                width: sw,
                height: sh,
            },
            filter: ResizeFilter::Lanczos3,
        },
        &DEFAULT_LIMITS,
    )?;
    Ok(image::imageops::crop_imm(&scaled, (sw - w) / 2, (sh - h) / 2, w, h).to_image())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo() -> RgbaImage {
        RgbaImage::from_fn(80, 60, |x, y| {
            image::Rgba([(x * 3) as u8, (y * 4) as u8, 90, 255])
        })
    }

    /// Subject = left half of the image.
    fn cutout() -> Cutout {
        let size = 16;
        Cutout::new(
            (0..size * size)
                .map(|i| if i % size < size / 2 { 255 } else { 0 })
                .collect(),
            size,
        )
    }

    #[test]
    fn transparent_colour_and_mask_views() {
        let c = cutout();
        let img = photo();
        let t = c
            .render(
                &img,
                None,
                EdgeSettings::default(),
                &BackdropSpec::Transparent,
                None,
                false,
            )
            .unwrap();
        assert_eq!(t.get_pixel(5, 30).0[3], 255);
        assert_eq!(t.get_pixel(75, 30).0[3], 0);
        let col = c
            .render(
                &img,
                None,
                EdgeSettings::default(),
                &BackdropSpec::Color { color: [1, 2, 3] },
                None,
                false,
            )
            .unwrap();
        assert_eq!(col.get_pixel(75, 30).0, [1, 2, 3, 255]);
        let m = c
            .render(
                &img,
                Some(40),
                EdgeSettings::default(),
                &BackdropSpec::Transparent,
                None,
                true,
            )
            .unwrap();
        assert_eq!((m.width(), m.height()), (40, 30));
        assert_eq!(m.get_pixel(2, 10).0, [255, 255, 255, 255]);
        assert!((c.kept_fraction() - 0.5).abs() < 1e-9);
    }

    #[test]
    fn blur_and_image_backdrops() {
        let c = cutout();
        let img = photo();
        let blurred = c
            .render(
                &img,
                Some(40),
                EdgeSettings::default(),
                &BackdropSpec::Blur { amount: 60.0 },
                None,
                false,
            )
            .unwrap();
        assert_eq!(blurred.get_pixel(38, 15).0[3], 255);
        let bg = RgbaImage::from_pixel(10, 30, image::Rgba([9, 9, 9, 255]));
        let on = c
            .render(
                &img,
                None,
                EdgeSettings::default(),
                &BackdropSpec::Image,
                Some(&bg),
                false,
            )
            .unwrap();
        assert_eq!(on.get_pixel(75, 30).0, [9, 9, 9, 255]);
        let cover = cover_resize(&bg, 80, 60).unwrap();
        assert_eq!((cover.width(), cover.height()), (80, 60));
    }
}
