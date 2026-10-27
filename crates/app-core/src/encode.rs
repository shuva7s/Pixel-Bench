//! Encoding for every output format. `image-core` covers the formats it
//! implements in pure Rust; lossy WebP (libwebp) and AVIF (rav1e) are added
//! here because they are native-only.

use image_core::{EncodeOptions, EngineError, Format, Result, RgbaImage};

use crate::settings::{OutputSettings, SourceFormat};

/// An encoded file.
#[derive(Debug, Clone)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub format: Format,
    pub width: u32,
    pub height: u32,
}

/// Encodes `img` for `settings`. `quality` overrides the setting (target-size search).
pub fn encode(
    img: RgbaImage,
    settings: &OutputSettings,
    source: SourceFormat,
    quality: Option<u8>,
) -> Result<Encoded> {
    let format = settings.resolve(source);
    let q = quality.unwrap_or(settings.quality).clamp(1, 100);
    let (width, height) = img.dimensions();
    let bytes = match format {
        Format::Avif => {
            avif_encoder::encode(img.as_raw(), width, height, q, settings.avif_speed.rav1e())
                .map_err(EngineError::Encode)?
        }
        Format::Webp if !settings.webp_lossless => lossy_webp(&img, q)?,
        _ => {
            let opts = core_options(format, settings, q);
            image_core::encode(img, &opts)?
        }
    };
    Ok(Encoded {
        bytes,
        format,
        width,
        height,
    })
}

fn core_options(format: Format, settings: &OutputSettings, quality: u8) -> EncodeOptions {
    let background = settings.background_rgb();
    match format {
        Format::Jpeg => EncodeOptions::Jpeg {
            quality,
            progressive: settings.progressive,
            background,
        },
        Format::Png => EncodeOptions::Png {
            compression: settings.png_compression,
        },
        Format::Webp => EncodeOptions::Webp,
        Format::Bmp => EncodeOptions::Bmp { background },
        Format::Gif => EncodeOptions::Gif,
        Format::Tiff => EncodeOptions::Tiff,
        Format::Ico => EncodeOptions::Ico,
        Format::Avif => unreachable!("AVIF is encoded by avif-encoder"),
    }
}

/// WebP's format limit.
const WEBP_MAX_SIDE: u32 = 16_383;

fn lossy_webp(img: &RgbaImage, quality: u8) -> Result<Vec<u8>> {
    let (w, h) = img.dimensions();
    if w > WEBP_MAX_SIDE || h > WEBP_MAX_SIDE {
        return Err(EngineError::TooLarge(format!(
            "WebP images can be at most {WEBP_MAX_SIDE} px per side; this image is {w}x{h}."
        )));
    }
    let encoder = webp::Encoder::from_rgba(img.as_raw(), w, h);
    let mut config = webp::WebPConfig::new()
        .map_err(|_| EngineError::Encode("could not initialise the WebP encoder".into()))?;
    config.quality = f32::from(quality);
    config.method = 4;
    config.alpha_quality = 100;
    let out = encoder
        .encode_advanced(&config)
        .map_err(|e| EngineError::Encode(format!("WebP encoding failed: {e:?}")))?;
    Ok(out.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{AvifSpeed, OutputFormat};
    use image_core::PngCompression;

    pub(crate) fn settings(format: OutputFormat) -> OutputSettings {
        OutputSettings {
            format,
            quality: 80,
            progressive: false,
            png_compression: PngCompression::Default,
            webp_lossless: false,
            avif_speed: AvifSpeed::Fast,
            background: "#ffffff".into(),
        }
    }

    fn noisy(w: u32, h: u32) -> RgbaImage {
        let mut seed = 7u32;
        RgbaImage::from_fn(w, h, |x, y| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let n = (seed >> 27) as u8;
            image::Rgba([(x * 3) as u8 ^ n, (y * 5) as u8, 128 ^ n, 255])
        })
    }

    #[test]
    fn writes_every_format() {
        let cases = [
            (OutputFormat::Jpeg, Format::Jpeg, &b"\xff\xd8"[..]),
            (OutputFormat::Png, Format::Png, &b"\x89PNG"[..]),
            (OutputFormat::Webp, Format::Webp, &b"RIFF"[..]),
            (OutputFormat::Avif, Format::Avif, &b""[..]),
            (OutputFormat::Gif, Format::Gif, &b"GIF8"[..]),
            (OutputFormat::Tiff, Format::Tiff, &b""[..]),
            (OutputFormat::Bmp, Format::Bmp, &b"BM"[..]),
            (OutputFormat::Ico, Format::Ico, &b"\0\0\x01\0"[..]),
        ];
        for (out, format, magic) in cases {
            let e = encode(noisy(48, 32), &settings(out), SourceFormat::Png, None).unwrap();
            assert_eq!(e.format, format);
            assert!(e.bytes.starts_with(magic), "{format:?}");
            assert_eq!(
                Format::detect(&e.bytes).ok().unwrap_or(Format::Avif),
                format
            );
        }
    }

    #[test]
    fn lossy_webp_quality_controls_size_and_keeps_alpha() {
        let low = encode(
            noisy(96, 96),
            &settings(OutputFormat::Webp),
            SourceFormat::Png,
            Some(20),
        )
        .unwrap();
        let high = encode(
            noisy(96, 96),
            &settings(OutputFormat::Webp),
            SourceFormat::Png,
            Some(95),
        )
        .unwrap();
        assert!(low.bytes.len() < high.bytes.len());
        let mut translucent = noisy(32, 32);
        translucent.pixels_mut().for_each(|p| p.0[3] = 100);
        let e = encode(
            translucent,
            &settings(OutputFormat::Webp),
            SourceFormat::Png,
            None,
        )
        .unwrap();
        let back = image::load_from_memory(&e.bytes).unwrap().to_rgba8();
        assert!(back.pixels().all(|p| (90..=110).contains(&p.0[3])));
    }

    #[test]
    fn lossless_webp_is_exact() {
        let img = noisy(40, 30);
        let mut s = settings(OutputFormat::Webp);
        s.webp_lossless = true;
        let e = encode(img.clone(), &s, SourceFormat::Png, None).unwrap();
        assert_eq!(image::load_from_memory(&e.bytes).unwrap().to_rgba8(), img);
    }

    #[test]
    fn heic_same_as_original_becomes_jpeg() {
        let e = encode(
            noisy(16, 16),
            &settings(OutputFormat::Same),
            SourceFormat::Heic,
            None,
        )
        .unwrap();
        assert_eq!(e.format, Format::Jpeg);
    }
}
