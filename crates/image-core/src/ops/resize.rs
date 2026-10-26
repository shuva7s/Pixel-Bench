use fast_image_resize as fr;
use image::RgbaImage;
use serde::Deserialize;

use crate::decode::is_opaque;
use crate::error::{EngineError, Result};
use crate::limits::Limits;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ResizeMode {
    /// Exact output size; the caller is responsible for aspect ratio.
    Exact { width: u32, height: u32 },
    /// Largest size that fits inside the box while keeping the aspect ratio.
    Fit {
        max_width: u32,
        max_height: u32,
        #[serde(default)]
        allow_upscale: bool,
    },
    /// Scale both sides by a percentage (keeps the aspect ratio).
    Percent { percent: f64 },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResizeFilter {
    Nearest,
    Bilinear,
    CatmullRom,
    #[default]
    Lanczos3,
}

fn scaled(side: u32, factor: f64) -> u32 {
    // Never collapse a side to zero; clamp before the float->int cast.
    (side as f64 * factor).round().clamp(1.0, u32::MAX as f64) as u32
}

/// Computes and validates the output size for `mode` on a `w x h` image.
pub fn resolve_resize(w: u32, h: u32, mode: &ResizeMode, limits: &Limits) -> Result<(u32, u32)> {
    let (nw, nh) = match *mode {
        ResizeMode::Exact { width, height } => (width, height),
        ResizeMode::Fit {
            max_width,
            max_height,
            allow_upscale,
        } => {
            if max_width == 0 || max_height == 0 {
                return Err(EngineError::InvalidDimensions(
                    "the bounding box must be at least 1x1 px".into(),
                ));
            }
            let mut factor = (max_width as f64 / w as f64).min(max_height as f64 / h as f64);
            if !allow_upscale {
                factor = factor.min(1.0);
            }
            (
                scaled(w, factor).min(max_width.max(1)),
                scaled(h, factor).min(max_height.max(1)),
            )
        }
        ResizeMode::Percent { percent } => {
            if !percent.is_finite() || percent <= 0.0 || percent > 1000.0 {
                return Err(EngineError::InvalidOptions(format!(
                    "percentage must be between 0 and 1000, got {percent}"
                )));
            }
            (scaled(w, percent / 100.0), scaled(h, percent / 100.0))
        }
    };
    limits.check_dimensions(nw, nh)?;
    Ok((nw, nh))
}

pub(super) fn resize(
    img: RgbaImage,
    mode: &ResizeMode,
    filter: ResizeFilter,
    limits: &Limits,
) -> Result<RgbaImage> {
    let (w, h) = img.dimensions();
    let (nw, nh) = resolve_resize(w, h, mode, limits)?;
    if (nw, nh) == (w, h) {
        return Ok(img);
    }
    let alg = match filter {
        ResizeFilter::Nearest => fr::ResizeAlg::Nearest,
        ResizeFilter::Bilinear => fr::ResizeAlg::Convolution(fr::FilterType::Bilinear),
        ResizeFilter::CatmullRom => fr::ResizeAlg::Convolution(fr::FilterType::CatmullRom),
        ResizeFilter::Lanczos3 => fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3),
    };
    let src = fr::images::ImageRef::new(w, h, img.as_raw(), fr::PixelType::U8x4)
        .map_err(|e| EngineError::InvalidDimensions(e.to_string()))?;
    let mut dst = fr::images::Image::new(nw, nh, fr::PixelType::U8x4);
    // Premultiplying alpha avoids dark fringes around transparent edges, but
    // costs two extra passes, so skip it for opaque images.
    let options = fr::ResizeOptions::new()
        .resize_alg(alg)
        .use_alpha(!is_opaque(&img));
    fr::Resizer::new()
        .resize(&src, &mut dst, &options)
        .map_err(|e| EngineError::InvalidOptions(format!("resize failed: {e}")))?;
    drop(img);
    RgbaImage::from_raw(nw, nh, dst.into_vec())
        .ok_or_else(|| EngineError::InvalidDimensions("resize produced a short buffer".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::DEFAULT_LIMITS;
    use image::Rgba;

    fn solid(w: u32, h: u32, c: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(c))
    }

    #[test]
    fn exact_resize_produces_requested_size() {
        for filter in [
            ResizeFilter::Nearest,
            ResizeFilter::Bilinear,
            ResizeFilter::CatmullRom,
            ResizeFilter::Lanczos3,
        ] {
            let out = resize(
                solid(40, 30, [10, 20, 30, 255]),
                &ResizeMode::Exact {
                    width: 17,
                    height: 9,
                },
                filter,
                &DEFAULT_LIMITS,
            )
            .unwrap();
            assert_eq!(out.dimensions(), (17, 9));
            // A solid colour must stay that colour under any filter.
            assert!(out.pixels().all(|p| p.0 == [10, 20, 30, 255]), "{filter:?}");
        }
    }

    #[test]
    fn fit_preserves_aspect_ratio_and_does_not_upscale_by_default() {
        let l = DEFAULT_LIMITS;
        let fit = |w, h, upscale| ResizeMode::Fit {
            max_width: w,
            max_height: h,
            allow_upscale: upscale,
        };
        assert_eq!(
            resolve_resize(4000, 3000, &fit(800, 800, false), &l).unwrap(),
            (800, 600)
        );
        assert_eq!(
            resolve_resize(3000, 4000, &fit(800, 800, false), &l).unwrap(),
            (600, 800)
        );
        assert_eq!(
            resolve_resize(400, 300, &fit(800, 800, false), &l).unwrap(),
            (400, 300)
        );
        assert_eq!(
            resolve_resize(400, 300, &fit(800, 800, true), &l).unwrap(),
            (800, 600)
        );
        // Extreme aspect ratio never collapses to zero.
        assert_eq!(
            resolve_resize(10_000, 1, &fit(100, 100, false), &l).unwrap(),
            (100, 1)
        );
    }

    #[test]
    fn percent_resize() {
        let l = DEFAULT_LIMITS;
        let p = |percent| ResizeMode::Percent { percent };
        assert_eq!(resolve_resize(1000, 500, &p(50.0), &l).unwrap(), (500, 250));
        assert_eq!(resolve_resize(3, 3, &p(1.0), &l).unwrap(), (1, 1));
        for bad in [0.0, -5.0, f64::NAN, f64::INFINITY, 1000.1] {
            assert!(resolve_resize(100, 100, &p(bad), &l).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_zero_and_oversized_targets() {
        let l = DEFAULT_LIMITS;
        let exact = |width, height| ResizeMode::Exact { width, height };
        assert!(matches!(
            resolve_resize(10, 10, &exact(0, 10), &l),
            Err(EngineError::InvalidDimensions(_))
        ));
        assert!(matches!(
            resolve_resize(10, 10, &exact(30_000, 10), &l),
            Err(EngineError::TooLarge(_))
        ));
        assert!(matches!(
            resolve_resize(10_000, 5_000, &ResizeMode::Percent { percent: 200.0 }, &l),
            Err(EngineError::TooLarge(_))
        ));
    }

    #[test]
    fn transparent_edges_do_not_darken() {
        // Left half opaque white, right half fully transparent black.
        let img = RgbaImage::from_fn(8, 8, |x, _| {
            if x < 4 {
                Rgba([255, 255, 255, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        });
        let out = resize(
            img,
            &ResizeMode::Exact {
                width: 4,
                height: 4,
            },
            ResizeFilter::Bilinear,
            &DEFAULT_LIMITS,
        )
        .unwrap();
        for p in out.pixels().filter(|p| p[3] > 0) {
            assert!(p[0] > 250, "colour bled from transparent pixels: {p:?}");
        }
    }
}
