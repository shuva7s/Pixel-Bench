use image::RgbaImage;

use crate::error::{EngineError, Result};

pub const MAX_STRAIGHTEN_DEGREES: f32 = 45.0;

/// Zoom factor so an image rotated by `deg` still covers its original frame
/// (no empty corners), like Lightroom's "constrain crop".
pub fn cover_scale(w: u32, h: u32, deg: f32) -> f32 {
    let t = deg.to_radians().abs();
    let ratio = (w as f32 / h as f32).max(h as f32 / w as f32);
    t.cos() + ratio * t.sin()
}

/// Rotates by an arbitrary angle (clockwise, degrees) and zooms to fill the
/// same `w x h` frame. Bilinear sampling.
pub(super) fn straighten(img: RgbaImage, degrees: f32) -> Result<RgbaImage> {
    if !degrees.is_finite() || degrees.abs() > MAX_STRAIGHTEN_DEGREES {
        return Err(EngineError::InvalidOptions(format!(
            "straighten angle must be between -{MAX_STRAIGHTEN_DEGREES} and {MAX_STRAIGHTEN_DEGREES} degrees, got {degrees}"
        )));
    }
    if degrees == 0.0 {
        return Ok(img);
    }
    let (w, h) = img.dimensions();
    let s = cover_scale(w, h, degrees);
    let (sin, cos) = degrees.to_radians().sin_cos();
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let src = img.as_raw();
    let stride = w as usize * 4;
    let sample = |x: f32, y: f32| -> [u8; 4] {
        let x = x.clamp(0.0, (w - 1) as f32);
        let y = y.clamp(0.0, (h - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w as usize - 1), (y0 + 1).min(h as usize - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let at = |xx: usize, yy: usize, c: usize| src[yy * stride + xx * 4 + c] as f32;
        std::array::from_fn(|c| {
            let top = at(x0, y0, c) * (1.0 - fx) + at(x1, y0, c) * fx;
            let bot = at(x0, y1, c) * (1.0 - fx) + at(x1, y1, c) * fx;
            // round_ties_even maps to a native wasm instruction; round() does not.
            (top * (1.0 - fy) + bot * fy).round_ties_even() as u8
        })
    };
    let mut out = vec![0u8; stride * h as usize];
    crate::par::for_rows(&mut out, stride, |y0, band| {
        for (i, row) in band.chunks_exact_mut(stride).enumerate() {
            let y = y0 + i;
            for (x, p) in row.chunks_exact_mut(4).enumerate() {
                // Inverse mapping: output pixel centre -> source position.
                let dx = (x as f32 + 0.5 - cx) / s;
                let dy = (y as f32 + 0.5 - cy) / s;
                let sx = cos * dx + sin * dy + cx - 0.5;
                let sy = -sin * dx + cos * dy + cy - 0.5;
                p.copy_from_slice(&sample(sx, sy));
            }
        }
    });
    Ok(RgbaImage::from_raw(w, h, out).expect("sized buffer"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn zero_is_identity_and_size_is_preserved() {
        let img = RgbaImage::from_fn(40, 30, |x, y| Rgba([x as u8, y as u8, 0, 255]));
        assert_eq!(straighten(img.clone(), 0.0).unwrap(), img);
        let out = straighten(img, 7.5).unwrap();
        assert_eq!(out.dimensions(), (40, 30));
    }

    #[test]
    fn corners_are_filled_from_the_image() {
        // Opaque source; after rotation every output pixel must still be opaque
        // and come from inside the image (no empty corners).
        let img = RgbaImage::from_fn(60, 40, |x, _| {
            Rgba([if x < 30 { 255 } else { 0 }, 0, 0, 255])
        });
        for deg in [-45.0, -10.0, 3.0, 30.0, 45.0] {
            let out = straighten(img.clone(), deg).unwrap();
            assert!(out.pixels().all(|p| p[3] == 255), "{deg}");
        }
    }

    #[test]
    fn rotation_direction_is_clockwise() {
        // Bright dot right of centre; a clockwise turn moves it down.
        let mut img = RgbaImage::from_pixel(101, 101, Rgba([0, 0, 0, 255]));
        for y in 48..53 {
            for x in 78..83 {
                img.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let out = straighten(img, 20.0).unwrap();
        let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
        for (x, y, p) in out.enumerate_pixels() {
            if p[0] > 128 {
                sx += x as f32;
                sy += y as f32;
                n += 1.0;
            }
        }
        assert!(n > 0.0);
        assert!(sy / n > 55.0, "dot moved down: y={}", sy / n);
        assert!(sx / n > 50.0);
    }

    #[test]
    fn rejects_bad_angles() {
        let img = RgbaImage::new(4, 4);
        for a in [46.0, -50.0, f32::NAN] {
            assert!(straighten(img.clone(), a).is_err(), "{a}");
        }
    }

    #[test]
    fn cover_scale_values() {
        assert!((cover_scale(100, 100, 0.0) - 1.0).abs() < 1e-6);
        assert!(cover_scale(200, 100, 10.0) > 1.0);
    }
}
