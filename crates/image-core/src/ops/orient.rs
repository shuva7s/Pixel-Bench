use image::RgbaImage;
use image::imageops;
use serde::Deserialize;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlipDirection {
    Horizontal,
    Vertical,
}

/// Clockwise rotation by a multiple of 90 degrees.
pub(super) fn rotate(img: RgbaImage, degrees: u16) -> Result<RgbaImage> {
    Ok(match degrees {
        0 | 360 => img,
        90 => imageops::rotate90(&img),
        180 => {
            let mut img = img;
            imageops::rotate180_in_place(&mut img);
            img
        }
        270 => imageops::rotate270(&img),
        other => {
            return Err(EngineError::InvalidOptions(format!(
                "rotation must be 0, 90, 180 or 270 degrees, got {other}"
            )));
        }
    })
}

pub(super) fn flip(mut img: RgbaImage, direction: FlipDirection) -> RgbaImage {
    match direction {
        FlipDirection::Horizontal => imageops::flip_horizontal_in_place(&mut img),
        FlipDirection::Vertical => imageops::flip_vertical_in_place(&mut img),
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// 3x2 image where each pixel encodes its own coordinates.
    fn tagged() -> RgbaImage {
        RgbaImage::from_fn(3, 2, |x, y| Rgba([x as u8, y as u8, 7, 255]))
    }

    fn px(img: &RgbaImage, x: u32, y: u32) -> (u8, u8) {
        let p = img.get_pixel(x, y);
        (p[0], p[1])
    }

    #[test]
    fn rotate_90_moves_pixels_clockwise() {
        let out = rotate(tagged(), 90).unwrap();
        assert_eq!(out.dimensions(), (2, 3));
        // Bottom-left of source becomes top-left.
        assert_eq!(px(&out, 0, 0), (0, 1));
        assert_eq!(px(&out, 1, 0), (0, 0));
        assert_eq!(px(&out, 1, 2), (2, 0));
    }

    #[test]
    fn rotate_180_and_270() {
        let r180 = rotate(tagged(), 180).unwrap();
        assert_eq!(r180.dimensions(), (3, 2));
        assert_eq!(px(&r180, 0, 0), (2, 1));
        assert_eq!(px(&r180, 2, 1), (0, 0));

        let r270 = rotate(tagged(), 270).unwrap();
        assert_eq!(r270.dimensions(), (2, 3));
        // Top-right of source becomes top-left.
        assert_eq!(px(&r270, 0, 0), (2, 0));
        assert_eq!(px(&r270, 1, 2), (0, 1));
    }

    #[test]
    fn four_quarter_turns_are_identity() {
        let mut img = tagged();
        for _ in 0..4 {
            img = rotate(img, 90).unwrap();
        }
        assert_eq!(img, tagged());
    }

    #[test]
    fn rejects_arbitrary_angles() {
        assert!(matches!(
            rotate(tagged(), 45),
            Err(EngineError::InvalidOptions(_))
        ));
    }

    #[test]
    fn flips() {
        let h = flip(tagged(), FlipDirection::Horizontal);
        assert_eq!(h.dimensions(), (3, 2));
        assert_eq!(px(&h, 0, 0), (2, 0));
        assert_eq!(px(&h, 2, 1), (0, 1));

        let v = flip(tagged(), FlipDirection::Vertical);
        assert_eq!(px(&v, 0, 0), (0, 1));
        assert_eq!(px(&v, 2, 1), (2, 0));
    }
}
