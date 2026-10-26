use serde::{Deserialize, Serialize};

use crate::error::{EngineError, Result};

/// Image formats known to the engine.
///
/// Everything except AVIF can be decoded here. AVIF (and HEIC) files are
/// decoded by the browser and handed to the engine as raw pixels, because
/// the only AVIF decoders available to Rust are C libraries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Jpeg,
    Png,
    Webp,
    Bmp,
    Gif,
    Tiff,
    Ico,
    Avif,
}

impl Format {
    pub const ALL: [Format; 8] = [
        Format::Jpeg,
        Format::Png,
        Format::Webp,
        Format::Bmp,
        Format::Gif,
        Format::Tiff,
        Format::Ico,
        Format::Avif,
    ];

    pub fn mime_type(self) -> &'static str {
        match self {
            Format::Jpeg => "image/jpeg",
            Format::Png => "image/png",
            Format::Webp => "image/webp",
            Format::Bmp => "image/bmp",
            Format::Gif => "image/gif",
            Format::Tiff => "image/tiff",
            Format::Ico => "image/x-icon",
            Format::Avif => "image/avif",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Format::Jpeg => "jpg",
            Format::Png => "png",
            Format::Webp => "webp",
            Format::Bmp => "bmp",
            Format::Gif => "gif",
            Format::Tiff => "tiff",
            Format::Ico => "ico",
            Format::Avif => "avif",
        }
    }

    /// Whether the engine's encoder for this format writes an alpha channel.
    /// GIF transparency is 1-bit: pixels are either fully opaque or clear.
    pub fn supports_alpha(self) -> bool {
        !matches!(self, Format::Jpeg | Format::Bmp)
    }

    /// Largest width/height the encoder for this format can represent.
    pub fn max_side(self) -> u32 {
        match self {
            Format::Jpeg | Format::Gif | Format::Avif => u16::MAX as u32,
            Format::Webp => 16_383,
            // Icons are resized to standard sizes, so any input fits.
            Format::Png | Format::Bmp | Format::Tiff | Format::Ico => u32::MAX,
        }
    }

    /// Detects a format the engine can decode from the file's magic bytes.
    /// File names and MIME types supplied by the browser are never trusted.
    pub fn detect(bytes: &[u8]) -> Result<Format> {
        match image::guess_format(bytes) {
            Ok(image::ImageFormat::Jpeg) => Ok(Format::Jpeg),
            Ok(image::ImageFormat::Png) => Ok(Format::Png),
            Ok(image::ImageFormat::WebP) => Ok(Format::Webp),
            Ok(image::ImageFormat::Bmp) => Ok(Format::Bmp),
            Ok(image::ImageFormat::Gif) => Ok(Format::Gif),
            Ok(image::ImageFormat::Tiff) => Ok(Format::Tiff),
            Ok(image::ImageFormat::Ico) => Ok(Format::Ico),
            _ => Err(EngineError::UnsupportedFormat),
        }
    }

    pub(crate) fn to_image_format(self) -> image::ImageFormat {
        match self {
            Format::Jpeg => image::ImageFormat::Jpeg,
            Format::Png => image::ImageFormat::Png,
            Format::Webp => image::ImageFormat::WebP,
            Format::Bmp => image::ImageFormat::Bmp,
            Format::Gif => image::ImageFormat::Gif,
            Format::Tiff => image::ImageFormat::Tiff,
            Format::Ico => image::ImageFormat::Ico,
            Format::Avif => image::ImageFormat::Avif,
        }
    }
}

/// True when a GIF stream has more than one frame. Uses the GIF decoder's
/// frame iterator, so it is bounds-safe on malformed input.
pub(crate) fn gif_is_animated(bytes: &[u8]) -> bool {
    use image::AnimationDecoder;
    let Ok(decoder) = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes)) else {
        return false;
    };
    decoder.into_frames().take(2).filter(|f| f.is_ok()).count() > 1
}

/// Number of images (pages) in a TIFF file, capped at 2.
pub(crate) fn tiff_page_count(bytes: &[u8]) -> usize {
    let Ok(mut decoder) = tiff::decoder::Decoder::new(std::io::Cursor::new(bytes)) else {
        return 0;
    };
    let mut pages = 1;
    while pages < 2 && decoder.more_images() {
        if decoder.next_image().is_err() {
            break;
        }
        pages += 1;
    }
    pages
}

/// Returns true when a PNG stream contains an `acTL` chunk (APNG) before its
/// first `IDAT`. Bounds-checked; malformed input simply yields `false` and is
/// left for the decoder to reject.
pub(crate) fn png_is_animated(bytes: &[u8]) -> bool {
    let mut pos = 8usize;
    while let Some(header) = bytes.get(pos..pos + 8) {
        let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        match &header[4..8] {
            b"acTL" => return true,
            b"IDAT" | b"IEND" => return false,
            _ => {}
        }
        // length + type + data + crc
        pos = match pos.checked_add(12).and_then(|p| p.checked_add(len)) {
            Some(p) => p,
            None => return false,
        };
    }
    false
}

/// Returns true when a WebP stream is an extended (VP8X) file with the
/// animation flag set.
pub(crate) fn webp_is_animated(bytes: &[u8]) -> bool {
    bytes.len() >= 21 && &bytes[12..16] == b"VP8X" && bytes[20] & 0x02 != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_by_magic_bytes() {
        assert_eq!(
            Format::detect(b"\x89PNG\r\n\x1a\n....").unwrap(),
            Format::Png
        );
        assert_eq!(
            Format::detect(b"\xff\xd8\xff\xe0....").unwrap(),
            Format::Jpeg
        );
        assert_eq!(
            Format::detect(b"RIFF\0\0\0\0WEBPVP8 ").unwrap(),
            Format::Webp
        );
        assert_eq!(Format::detect(b"BM\0\0\0\0\0\0\0\0").unwrap(), Format::Bmp);
        assert_eq!(
            Format::detect(b"GIF89a\x01\x00\x01\x00").unwrap(),
            Format::Gif
        );
        assert_eq!(Format::detect(b"II*\0\x08\0\0\0").unwrap(), Format::Tiff);
        // AVIF is detected by the web layer and decoded by the browser.
        assert!(matches!(
            Format::detect(b"\0\0\0\x1cftypavif\0\0\0\0"),
            Err(EngineError::UnsupportedFormat)
        ));
        assert!(matches!(
            Format::detect(b"hello world"),
            Err(EngineError::UnsupportedFormat)
        ));
    }

    #[test]
    fn png_animation_scan_is_bounds_safe() {
        let mut apng = b"\x89PNG\r\n\x1a\n".to_vec();
        apng.extend_from_slice(&[0, 0, 0, 13]);
        apng.extend_from_slice(b"IHDR");
        apng.extend_from_slice(&[0; 13 + 4]);
        apng.extend_from_slice(&[0, 0, 0, 8]);
        apng.extend_from_slice(b"acTL");
        assert!(png_is_animated(&apng));

        let mut bogus = b"\x89PNG\r\n\x1a\n".to_vec();
        bogus.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        bogus.extend_from_slice(b"tEXt");
        assert!(!png_is_animated(&bogus));
        assert!(!png_is_animated(b"\x89PNG"));
    }

    #[test]
    fn webp_animation_flag() {
        let mut v = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        v.extend_from_slice(&[10, 0, 0, 0, 0x02]);
        assert!(webp_is_animated(&v));
        v[20] = 0x10;
        assert!(!webp_is_animated(&v));
        assert!(!webp_is_animated(b"RIFF"));
    }
}
