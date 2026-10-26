use image::codecs::bmp::BmpEncoder;
use image::codecs::gif::GifEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{ExtendedColorType, ImageEncoder, RgbaImage};
use serde::Deserialize;

use crate::decode::is_opaque;
use crate::error::{EngineError, Result};
use crate::format::Format;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PngCompression {
    Fast,
    #[default]
    Default,
    Best,
}

const WHITE: [u8; 3] = [255, 255, 255];

fn white() -> [u8; 3] {
    WHITE
}

fn default_quality() -> u8 {
    85
}

/// Output settings. Formats without alpha support (JPEG, BMP) composite
/// transparent pixels onto `background`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "format",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum EncodeOptions {
    Jpeg {
        #[serde(default = "default_quality")]
        quality: u8,
        #[serde(default)]
        progressive: bool,
        #[serde(default = "white")]
        background: [u8; 3],
    },
    Png {
        #[serde(default)]
        compression: PngCompression,
    },
    /// Lossless WebP (the pure-Rust encoder does not implement lossy VP8).
    Webp,
    Bmp {
        #[serde(default = "white")]
        background: [u8; 3],
    },
    /// Still GIF with a 256-colour palette and 1-bit transparency.
    Gif,
    /// Lossless TIFF (LZW).
    Tiff,
    /// Windows icon with standard sizes (16–256 px), square.
    Ico,
}

/// Icon sizes written into ICO files (those not larger than the source).
const ICO_SIZES: [u32; 7] = [16, 24, 32, 48, 64, 128, 256];

impl EncodeOptions {
    pub fn format(&self) -> Format {
        match self {
            EncodeOptions::Jpeg { .. } => Format::Jpeg,
            EncodeOptions::Png { .. } => Format::Png,
            EncodeOptions::Webp => Format::Webp,
            EncodeOptions::Bmp { .. } => Format::Bmp,
            EncodeOptions::Gif => Format::Gif,
            EncodeOptions::Tiff => Format::Tiff,
            EncodeOptions::Ico => Format::Ico,
        }
    }

    pub fn validate(&self) -> Result<()> {
        match self {
            EncodeOptions::Jpeg { quality, .. } if !(1..=100).contains(quality) => {
                Err(EngineError::InvalidOptions(format!(
                    "JPEG quality must be between 1 and 100, got {quality}"
                )))
            }
            _ => Ok(()),
        }
    }
}

/// Composites every pixel over an opaque background, in place. Afterwards
/// every alpha value is 255.
pub fn flatten(img: &mut RgbaImage, bg: [u8; 3]) {
    for p in img.as_mut().chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        if a == 255 {
            continue;
        }
        for c in 0..3 {
            p[c] = ((u32::from(p[c]) * a + u32::from(bg[c]) * (255 - a) + 127) / 255) as u8;
        }
        p[3] = 255;
    }
}

fn is_gray(img: &RgbaImage) -> bool {
    img.as_raw()
        .chunks_exact(4)
        .all(|p| p[0] == p[1] && p[1] == p[2])
}

/// Keeps only the selected channel indices of each RGBA pixel.
fn pack(img: &RgbaImage, channels: &[usize]) -> Vec<u8> {
    let mut out = Vec::with_capacity(img.as_raw().len() / 4 * channels.len());
    for p in img.as_raw().chunks_exact(4) {
        out.extend(channels.iter().map(|&c| p[c]));
    }
    out
}

fn enc_err(e: impl std::fmt::Display) -> EngineError {
    EngineError::Encode(e.to_string())
}

/// Encodes `img`, consuming it so flattening can happen without a copy.
pub fn encode(mut img: RgbaImage, opts: &EncodeOptions) -> Result<Vec<u8>> {
    opts.validate()?;
    let format = opts.format();
    let (w, h) = img.dimensions();
    if w > format.max_side() || h > format.max_side() {
        return Err(EngineError::TooLarge(format!(
            "{} images can be at most {} px per side; this image is {w}x{h}.",
            format.mime_type(),
            format.max_side()
        )));
    }

    let mut out = Vec::new();
    match *opts {
        EncodeOptions::Jpeg {
            quality,
            progressive,
            background,
        } => {
            flatten(&mut img, background);
            let mut enc = jpeg_encoder::Encoder::new(&mut out, quality);
            enc.set_progressive(progressive);
            // Optimised Huffman tables are deliberately off: for near-uniform
            // images they produce single-symbol tables that zune-jpeg 0.5.15
            // (the decoder used by `image`) mis-decodes, so our own output
            // would not round-trip. See docs/FEATURES.md "Known issues".
            enc.set_optimized_huffman_tables(false);
            enc.set_sampling_factor(if quality >= 90 {
                jpeg_encoder::SamplingFactor::R_4_4_4
            } else {
                jpeg_encoder::SamplingFactor::R_4_2_0
            });
            // Alpha is ignored by the encoder; it is 255 after flattening.
            enc.encode(
                img.as_raw(),
                w as u16,
                h as u16,
                jpeg_encoder::ColorType::Rgba,
            )
            .map_err(enc_err)?;
        }
        EncodeOptions::Png { compression } => {
            let level = match compression {
                PngCompression::Fast => CompressionType::Fast,
                PngCompression::Default => CompressionType::Default,
                PngCompression::Best => CompressionType::Best,
            };
            let encoder = PngEncoder::new_with_quality(&mut out, level, FilterType::Adaptive);
            // Lossless channel reduction: drop alpha / colour when unused.
            let (opaque, gray) = (is_opaque(&img), is_gray(&img));
            let (data, color) = match (opaque, gray) {
                (true, true) => (pack(&img, &[0]), ExtendedColorType::L8),
                (true, false) => (pack(&img, &[0, 1, 2]), ExtendedColorType::Rgb8),
                (false, true) => (pack(&img, &[0, 3]), ExtendedColorType::La8),
                (false, false) => (img.into_raw(), ExtendedColorType::Rgba8),
            };
            encoder.write_image(&data, w, h, color).map_err(enc_err)?;
        }
        EncodeOptions::Webp => {
            let encoder = WebPEncoder::new_lossless(&mut out);
            if is_opaque(&img) {
                encoder
                    .encode(&pack(&img, &[0, 1, 2]), w, h, ExtendedColorType::Rgb8)
                    .map_err(enc_err)?;
            } else {
                encoder
                    .encode(img.as_raw(), w, h, ExtendedColorType::Rgba8)
                    .map_err(enc_err)?;
            }
        }
        EncodeOptions::Bmp { background } => {
            flatten(&mut img, background);
            let rgb = pack(&img, &[0, 1, 2]);
            drop(img);
            BmpEncoder::new(&mut out)
                .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
                .map_err(enc_err)?;
        }
        EncodeOptions::Gif => {
            // Speed 10 of 1..=30: good palette quality at reasonable speed.
            let mut encoder = GifEncoder::new_with_speed(&mut out, 10);
            encoder
                .encode(img.as_raw(), w, h, ExtendedColorType::Rgba8)
                .map_err(enc_err)?;
        }
        EncodeOptions::Tiff => encode_tiff(&img, &mut out)?,
        EncodeOptions::Ico => encode_ico(img, &mut out)?,
    }
    Ok(out)
}

fn encode_tiff(img: &RgbaImage, out: &mut Vec<u8>) -> Result<()> {
    use tiff::encoder::{Compression, Predictor, TiffEncoder, colortype};
    let (w, h) = img.dimensions();
    let mut cursor = std::io::Cursor::new(Vec::new());
    // The horizontal predictor makes LZW markedly more effective on photos.
    let mut encoder = TiffEncoder::new(&mut cursor)
        .map_err(enc_err)?
        .with_compression(Compression::Lzw)
        .with_predictor(Predictor::Horizontal);
    if is_opaque(img) {
        encoder
            .write_image::<colortype::RGB8>(w, h, &pack(img, &[0, 1, 2]))
            .map_err(enc_err)?;
    } else {
        encoder
            .write_image::<colortype::RGBA8>(w, h, img.as_raw())
            .map_err(enc_err)?;
    }
    *out = cursor.into_inner();
    Ok(())
}

/// Pads to a transparent square, then writes every standard icon size that
/// is not larger than the image (always at least 16 px) as PNG entries.
fn encode_ico(img: RgbaImage, out: &mut Vec<u8>) -> Result<()> {
    use image::codecs::ico::{IcoEncoder, IcoFrame};
    let (w, h) = img.dimensions();
    let side = w.max(h);
    let mut square = RgbaImage::new(side, side);
    image::imageops::overlay(
        &mut square,
        &img,
        i64::from((side - w) / 2),
        i64::from((side - h) / 2),
    );
    drop(img);
    let largest = side.min(256);
    let mut frames = Vec::new();
    for &size in ICO_SIZES.iter().filter(|&&s| s <= largest || s == 16) {
        let resized = crate::ops::apply(
            square.clone(),
            &crate::ops::Operation::Resize {
                size: crate::ops::ResizeMode::Exact {
                    width: size,
                    height: size,
                },
                filter: crate::ops::ResizeFilter::Lanczos3,
            },
            &crate::limits::DEFAULT_LIMITS,
        )?;
        frames.push(
            IcoFrame::as_png(resized.as_raw(), size, size, ExtendedColorType::Rgba8)
                .map_err(enc_err)?,
        );
    }
    IcoEncoder::new(out).encode_images(&frames).map_err(enc_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn flatten_blends_with_background() {
        let mut img =
            RgbaImage::from_raw(3, 1, vec![255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 128]).unwrap();
        flatten(&mut img, [0, 0, 255]);
        assert_eq!(img.get_pixel(0, 0), &Rgba([255, 0, 0, 255]));
        assert_eq!(img.get_pixel(1, 0), &Rgba([0, 0, 255, 255]));
        assert_eq!(img.get_pixel(2, 0), &Rgba([128, 0, 127, 255]));
    }

    #[test]
    fn rejects_bad_quality() {
        let opts = EncodeOptions::Jpeg {
            quality: 0,
            progressive: false,
            background: WHITE,
        };
        assert!(matches!(
            encode(RgbaImage::new(2, 2), &opts),
            Err(EngineError::InvalidOptions(_))
        ));
    }

    #[test]
    fn rejects_webp_over_format_limit() {
        let img = RgbaImage::new(16_384, 1);
        assert!(matches!(
            encode(img, &EncodeOptions::Webp),
            Err(EngineError::TooLarge(_))
        ));
    }

    #[test]
    fn ico_contains_standard_sizes_up_to_the_image_size() {
        let out = encode(
            RgbaImage::from_pixel(100, 40, Rgba([1, 2, 3, 255])),
            &EncodeOptions::Ico,
        )
        .unwrap();
        // ICONDIR: reserved(2) type(2) count(2), then 16-byte entries with width at offset 0.
        assert_eq!(&out[2..4], &[1, 0]);
        let count = u16::from_le_bytes([out[4], out[5]]) as usize;
        let widths: Vec<u32> = (0..count)
            .map(|i| match out[6 + i * 16] {
                0 => 256,
                w => u32::from(w),
            })
            .collect();
        assert_eq!(widths, vec![16, 24, 32, 48, 64]);
        let tiny = encode(RgbaImage::new(8, 8), &EncodeOptions::Ico).unwrap();
        assert_eq!(
            u16::from_le_bytes([tiny[4], tiny[5]]),
            1,
            "always at least a 16 px entry"
        );
    }

    #[test]
    fn options_deserialize_with_defaults() {
        let o: EncodeOptions = serde_json_like(r#"{"format":"jpeg"}"#);
        assert_eq!(
            o,
            EncodeOptions::Jpeg {
                quality: 85,
                progressive: false,
                background: WHITE
            }
        );
        let o: EncodeOptions = serde_json_like(r#"{"format":"png","compression":"best"}"#);
        assert_eq!(
            o,
            EncodeOptions::Png {
                compression: PngCompression::Best
            }
        );
        let o: EncodeOptions = serde_json_like(r#"{"format":"webp"}"#);
        assert_eq!(o, EncodeOptions::Webp);
    }

    fn serde_json_like<T: serde::de::DeserializeOwned>(s: &str) -> T {
        serde_json::from_str(s).unwrap()
    }
}
