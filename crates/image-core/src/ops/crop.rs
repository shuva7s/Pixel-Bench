use image::RgbaImage;
use serde::Deserialize;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl CropRect {
    pub fn validate(&self, img_w: u32, img_h: u32) -> Result<()> {
        if self.width == 0 || self.height == 0 {
            return Err(EngineError::InvalidCrop(
                "the crop area must be at least 1x1 px".into(),
            ));
        }
        let right = self.x.checked_add(self.width);
        let bottom = self.y.checked_add(self.height);
        match (right, bottom) {
            (Some(r), Some(b)) if r <= img_w && b <= img_h => Ok(()),
            _ => Err(EngineError::InvalidCrop(format!(
                "area {}x{} at ({}, {}) extends outside the {img_w}x{img_h} image",
                self.width, self.height, self.x, self.y
            ))),
        }
    }
}

pub(super) fn crop(img: RgbaImage, rect: &CropRect) -> Result<RgbaImage> {
    rect.validate(img.width(), img.height())?;
    if rect.x == 0 && rect.y == 0 && rect.width == img.width() && rect.height == img.height() {
        return Ok(img);
    }
    Ok(image::imageops::crop_imm(&img, rect.x, rect.y, rect.width, rect.height).to_image())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn gradient(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([x as u8, y as u8, 0, 255]))
    }

    #[test]
    fn crops_exact_region() {
        let out = crop(
            gradient(10, 8),
            &CropRect {
                x: 2,
                y: 3,
                width: 4,
                height: 5,
            },
        )
        .unwrap();
        assert_eq!(out.dimensions(), (4, 5));
        assert_eq!(out.get_pixel(0, 0), &Rgba([2, 3, 0, 255]));
        assert_eq!(out.get_pixel(3, 4), &Rgba([5, 7, 0, 255]));
    }

    #[test]
    fn full_crop_is_identity() {
        let img = gradient(5, 5);
        let out = crop(
            img.clone(),
            &CropRect {
                x: 0,
                y: 0,
                width: 5,
                height: 5,
            },
        )
        .unwrap();
        assert_eq!(out, img);
    }

    #[test]
    fn rejects_out_of_bounds_and_empty() {
        let bad = [
            CropRect {
                x: 0,
                y: 0,
                width: 0,
                height: 1,
            },
            CropRect {
                x: 9,
                y: 0,
                width: 2,
                height: 1,
            },
            CropRect {
                x: 0,
                y: 8,
                width: 1,
                height: 1,
            },
            CropRect {
                x: u32::MAX,
                y: 0,
                width: 2,
                height: 1,
            },
        ];
        for r in bad {
            assert!(
                matches!(crop(gradient(10, 8), &r), Err(EngineError::InvalidCrop(_))),
                "{r:?}"
            );
        }
    }
}
