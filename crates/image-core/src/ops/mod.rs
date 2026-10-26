//! Pixel transformations. Every operation consumes an owned RGBA image and
//! returns a new one, so a pipeline never holds more than two full buffers.

mod crop;
mod develop;
mod orient;
mod pad;
mod resize;
mod straighten;

use image::RgbaImage;
use serde::Deserialize;

pub use crop::CropRect;
pub use develop::{BANDS, Develop};
pub use orient::FlipDirection;
pub use pad::Padding;
pub use resize::{ResizeFilter, ResizeMode, resolve_resize};
pub use straighten::{MAX_STRAIGHTEN_DEGREES, cover_scale};

use crate::error::Result;
use crate::limits::Limits;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Operation {
    Crop(CropRect),
    Resize {
        size: ResizeMode,
        #[serde(default)]
        filter: ResizeFilter,
    },
    Rotate {
        degrees: u16,
    },
    Flip {
        direction: FlipDirection,
    },
    /// Arbitrary-angle rotation, zoomed to keep the frame filled.
    Straighten {
        degrees: f32,
    },
    Develop(Box<Develop>),
    /// Adds a border / padding around the image.
    Pad(Padding),
}

pub fn apply(img: RgbaImage, op: &Operation, limits: &Limits) -> Result<RgbaImage> {
    match op {
        Operation::Crop(rect) => crop::crop(img, rect),
        Operation::Resize { size, filter } => resize::resize(img, size, *filter, limits),
        Operation::Rotate { degrees } => orient::rotate(img, *degrees),
        Operation::Flip { direction } => Ok(orient::flip(img, *direction)),
        Operation::Straighten { degrees } => straighten::straighten(img, *degrees),
        Operation::Develop(d) => develop::develop(img, d),
        Operation::Pad(p) => pad::pad(img, p, limits),
    }
}

pub fn apply_all(mut img: RgbaImage, ops: &[Operation], limits: &Limits) -> Result<RgbaImage> {
    for op in ops {
        img = apply(img, op, limits)?;
    }
    Ok(img)
}

/// Applies `ops`, written for a full-resolution image, to a copy that was
/// downscaled by `scale` (e.g. a preview proxy). Crop rectangles and pixel
/// radii are scaled, and crops are clamped to absorb rounding differences.
pub fn apply_all_scaled(
    mut img: RgbaImage,
    ops: &[Operation],
    scale: f64,
    limits: &Limits,
) -> Result<RgbaImage> {
    if scale == 1.0 {
        // Full resolution: validate strictly, never clamp silently.
        return apply_all(img, ops, limits);
    }
    for op in ops {
        let scaled = match op {
            Operation::Crop(r) => {
                let (w, h) = img.dimensions();
                let s = |v: u32| (v as f64 * scale).round() as u32;
                let x = s(r.x).min(w - 1);
                let y = s(r.y).min(h - 1);
                Operation::Crop(CropRect {
                    x,
                    y,
                    width: s(r.width).clamp(1, w - x),
                    height: s(r.height).clamp(1, h - y),
                })
            }
            Operation::Develop(d) => Operation::Develop(Box::new(d.scaled(scale))),
            Operation::Pad(p) => Operation::Pad(p.scaled(scale)),
            other => other.clone(),
        };
        img = apply(img, &scaled, limits)?;
    }
    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::DEFAULT_LIMITS;

    #[test]
    fn scaled_crop_is_clamped_to_proxy_bounds() {
        let img = RgbaImage::new(50, 25); // proxy of a 101x51 image at ~0.5
        let ops = [Operation::Crop(CropRect {
            x: 51,
            y: 1,
            width: 50,
            height: 50,
        })];
        let out = apply_all_scaled(img, &ops, 0.5, &DEFAULT_LIMITS).unwrap();
        assert_eq!(out.dimensions(), (24, 24));
    }

    #[test]
    fn full_scale_rejects_invalid_crops() {
        let ops = [Operation::Crop(CropRect {
            x: 40,
            y: 0,
            width: 20,
            height: 5,
        })];
        assert!(apply_all_scaled(RgbaImage::new(50, 25), &ops, 1.0, &DEFAULT_LIMITS).is_err());
    }

    #[test]
    fn develop_and_straighten_deserialize() {
        let ops: Vec<Operation> = serde_json::from_str(
            r#"[{"op":"straighten","degrees":-3.5},{"op":"develop","exposure":0.5,"monochrome":true}]"#,
        )
        .unwrap();
        let pad: Operation = serde_json::from_str(
            r#"{"op":"pad","top":1,"right":2,"bottom":3,"left":4,"color":[1,2,3,4]}"#,
        )
        .unwrap();
        assert!(matches!(pad, Operation::Pad(Padding { right: 2, .. })));
        assert_eq!(ops[0], Operation::Straighten { degrees: -3.5 });
        match &ops[1] {
            Operation::Develop(d) => assert!(d.monochrome && d.exposure == 0.5),
            other => panic!("{other:?}"),
        }
    }
}
