use image::RgbaImage;
use serde::Deserialize;

use crate::error::{EngineError, Result};
use crate::limits::Limits;

/// Adds space around the image, filled with `color` (RGBA; alpha 0 gives
/// transparent padding).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Padding {
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
    pub left: u32,
    pub color: [u8; 4],
}

impl Padding {
    pub fn scaled(&self, scale: f64) -> Padding {
        let s = |v: u32| (v as f64 * scale).round() as u32;
        Padding {
            top: s(self.top),
            right: s(self.right),
            bottom: s(self.bottom),
            left: s(self.left),
            color: self.color,
        }
    }
}

pub(super) fn pad(img: RgbaImage, p: &Padding, limits: &Limits) -> Result<RgbaImage> {
    if p.top == 0 && p.right == 0 && p.bottom == 0 && p.left == 0 {
        return Ok(img);
    }
    let (w, h) = img.dimensions();
    let nw = w.checked_add(p.left).and_then(|v| v.checked_add(p.right));
    let nh = h.checked_add(p.top).and_then(|v| v.checked_add(p.bottom));
    let (Some(nw), Some(nh)) = (nw, nh) else {
        return Err(EngineError::TooLarge("the padding is too large".into()));
    };
    limits.check_dimensions(nw, nh)?;
    let mut out = RgbaImage::from_pixel(nw, nh, image::Rgba(p.color));
    image::imageops::replace(&mut out, &img, i64::from(p.left), i64::from(p.top));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::DEFAULT_LIMITS;
    use image::Rgba;

    #[test]
    fn pads_each_side_with_the_colour() {
        let img = RgbaImage::from_pixel(4, 2, Rgba([9, 9, 9, 255]));
        let p = Padding {
            top: 1,
            right: 2,
            bottom: 3,
            left: 4,
            color: [255, 0, 0, 255],
        };
        let out = pad(img, &p, &DEFAULT_LIMITS).unwrap();
        assert_eq!(out.dimensions(), (10, 6));
        assert_eq!(out.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(out.get_pixel(4, 1).0, [9, 9, 9, 255]);
        assert_eq!(out.get_pixel(7, 2).0, [9, 9, 9, 255]);
        assert_eq!(out.get_pixel(8, 2).0, [255, 0, 0, 255]);
        assert_eq!(out.get_pixel(5, 3).0, [255, 0, 0, 255]);
    }

    #[test]
    fn transparent_padding_and_limits() {
        let img = RgbaImage::new(2, 2);
        let clear = Padding {
            top: 1,
            right: 1,
            bottom: 1,
            left: 1,
            color: [0, 0, 0, 0],
        };
        assert_eq!(
            pad(img.clone(), &clear, &DEFAULT_LIMITS)
                .unwrap()
                .get_pixel(0, 0)[3],
            0
        );
        let huge = Padding {
            top: 0,
            right: u32::MAX,
            bottom: 0,
            left: 1,
            color: [0; 4],
        };
        assert!(pad(img.clone(), &huge, &DEFAULT_LIMITS).is_err());
        let big = Padding {
            top: 0,
            right: 30_000,
            bottom: 0,
            left: 0,
            color: [0; 4],
        };
        assert!(matches!(
            pad(img, &big, &DEFAULT_LIMITS),
            Err(EngineError::TooLarge(_))
        ));
    }
}
