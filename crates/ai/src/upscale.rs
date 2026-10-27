//! Tiled super-resolution helpers. The image is split into tiles with an
//! overlapping margin; only each tile's core is kept, so seams fall where both
//! neighbours saw the same context.

/// Real-ESRGAN x4v3 always upscales 4×; 2× averages 2×2 blocks of the 4× result.
pub const MODEL_SCALE: usize = 4;
/// Tiles are larger than in the browser: native memory is not the limit.
pub const TILE: usize = 256;
pub const TILE_PAD: usize = 16;
/// Output limit, matching the engine's 50 MP cap.
pub const MAX_OUTPUT_PIXELS: u64 = 50_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tile {
    /// Core region, in input pixels.
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
    /// Region fed to the model: the core plus up to TILE_PAD of context on each side.
    pub in_x: usize,
    pub in_y: usize,
    pub in_width: usize,
    pub in_height: usize,
}

pub fn plan_tiles(width: usize, height: usize, tile: usize, pad: usize) -> Vec<Tile> {
    let mut tiles = Vec::new();
    for y in (0..height).step_by(tile) {
        for x in (0..width).step_by(tile) {
            let w = tile.min(width - x);
            let h = tile.min(height - y);
            let in_x = x.saturating_sub(pad);
            let in_y = y.saturating_sub(pad);
            tiles.push(Tile {
                x,
                y,
                width: w,
                height: h,
                in_x,
                in_y,
                in_width: (x + w + pad).min(width) - in_x,
                in_height: (y + h + pad).min(height) - in_y,
            });
        }
    }
    tiles
}

/// Why an upscale is not possible, or None when it is.
pub fn upscale_problem(width: u32, height: u32, factor: u32) -> Option<String> {
    let out = u64::from(width) * u64::from(factor) * u64::from(height) * u64::from(factor);
    (out > MAX_OUTPUT_PIXELS).then(|| {
        format!(
            "The result would be {} MP, above the 50 MP limit. Try 2× or a smaller image.",
            out / 1_000_000
        )
    })
}

/// RGB of a region as a CHW float tensor in [0, 1].
pub fn tile_input(rgba: &[u8], width: usize, t: &Tile) -> Vec<f32> {
    let plane = t.in_width * t.in_height;
    let mut out = vec![0.0f32; 3 * plane];
    for y in 0..t.in_height {
        for x in 0..t.in_width {
            let src = ((t.in_y + y) * width + t.in_x + x) * 4;
            let dst = y * t.in_width + x;
            for c in 0..3 {
                out[c * plane + dst] = f32::from(rgba[src + c]) / 255.0;
            }
        }
    }
    out
}

/// Writes the core of a 4× model output into `out` (RGB only). For 2×, each
/// 2×2 block is averaged.
pub fn place_tile(model: &[f32], t: &Tile, out: &mut [u8], out_width: usize, factor: usize) {
    let mw = t.in_width * MODEL_SCALE;
    let plane = mw * t.in_height * MODEL_SCALE;
    let step = MODEL_SCALE / factor;
    let off_x = (t.x - t.in_x) * MODEL_SCALE;
    let off_y = (t.y - t.in_y) * MODEL_SCALE;
    let norm = 255.0 / (step * step) as f32;
    for y in 0..t.height * factor {
        for x in 0..t.width * factor {
            let dst = ((t.y * factor + y) * out_width + t.x * factor + x) * 4;
            for c in 0..3 {
                let mut sum = 0.0f32;
                for dy in 0..step {
                    let row = (off_y + y * step + dy) * mw + off_x + x * step;
                    for dx in 0..step {
                        sum += model[c * plane + row + dx].clamp(0.0, 1.0);
                    }
                }
                out[dst + c] = (sum * norm).round() as u8;
            }
        }
    }
}

/// Fills the alpha channel of `out` by bilinear upscaling of the source alpha.
pub fn upscale_alpha(src: &[u8], width: usize, height: usize, out: &mut [u8], factor: usize) {
    let (ow, oh) = (width * factor, height * factor);
    let a = |x: usize, y: usize| f32::from(src[(y * width + x) * 4 + 3]);
    for y in 0..oh {
        let fy = ((y as f32 + 0.5) / factor as f32 - 0.5).max(0.0);
        let y0 = (fy.floor() as usize).min(height - 1);
        let y1 = (y0 + 1).min(height - 1);
        let wy = fy - y0 as f32;
        for x in 0..ow {
            let fx = ((x as f32 + 0.5) / factor as f32 - 0.5).max(0.0);
            let x0 = (fx.floor() as usize).min(width - 1);
            let x1 = (x0 + 1).min(width - 1);
            let wx = fx - x0 as f32;
            let top = a(x0, y0) * (1.0 - wx) + a(x1, y0) * wx;
            let bottom = a(x0, y1) * (1.0 - wx) + a(x1, y1) * wx;
            out[(y * ow + x) * 4 + 3] = (top * (1.0 - wy) + bottom * wy).round() as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_the_image_exactly_once() {
        let tiles = plan_tiles(500, 300, 192, 16);
        assert_eq!(tiles.len(), 6);
        let area: usize = tiles.iter().map(|t| t.width * t.height).sum();
        assert_eq!(area, 500 * 300);
        assert!(
            tiles
                .iter()
                .all(|t| t.in_x + t.in_width <= 500 && t.x - t.in_x <= 16)
        );
    }

    /// A fake 4× model (nearest-neighbour): the assembled result must equal enlarging the whole image.
    fn fake_model(input: &[f32], t: &Tile) -> Vec<f32> {
        let (w, h) = (t.in_width * MODEL_SCALE, t.in_height * MODEL_SCALE);
        let mut out = vec![0.0; 3 * w * h];
        for c in 0..3 {
            for y in 0..h {
                for x in 0..w {
                    out[c * w * h + y * w + x] = input[c * t.in_width * t.in_height
                        + (y / MODEL_SCALE) * t.in_width
                        + x / MODEL_SCALE];
                }
            }
        }
        out
    }

    #[test]
    fn assembles_seamlessly() {
        let (w, h) = (7, 5);
        let src: Vec<u8> = (0..w * h * 4).map(|i| ((i * 37) % 251) as u8).collect();
        for factor in [2, 4] {
            let mut out = vec![0u8; w * factor * h * factor * 4];
            for t in plan_tiles(w, h, 3, 1) {
                place_tile(
                    &fake_model(&tile_input(&src, w, &t), &t),
                    &t,
                    &mut out,
                    w * factor,
                    factor,
                );
            }
            for y in 0..h * factor {
                for x in 0..w * factor {
                    let s = ((y / factor) * w + x / factor) * 4;
                    let d = (y * w * factor + x) * 4;
                    assert_eq!(&out[d..d + 3], &src[s..s + 3]);
                }
            }
        }
    }

    #[test]
    fn alpha_and_limits() {
        let src = [0, 0, 0, 0, 0, 0, 0, 255];
        let mut out = vec![0u8; 4 * 2 * 4];
        upscale_alpha(&src, 2, 1, &mut out, 2);
        assert_eq!((out[3], out[15]), (0, 255));
        assert!(upscale_problem(2000, 1500, 4).is_none());
        assert!(upscale_problem(2000, 2000, 4).unwrap().contains("50 MP"));
    }
}
