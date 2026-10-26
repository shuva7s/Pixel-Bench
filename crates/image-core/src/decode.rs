use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageReader, RgbaImage, metadata::Orientation};
use serde::Serialize;

use crate::error::{EngineError, Result};
use crate::format::{Format, gif_is_animated, png_is_animated, tiff_page_count, webp_is_animated};
use crate::limits::Limits;

/// Header-level facts about an image, obtained without decoding pixel data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub format: Format,
    pub mime_type: &'static str,
    /// Display width, i.e. after applying any EXIF orientation.
    pub width: u32,
    /// Display height, i.e. after applying any EXIF orientation.
    pub height: u32,
    /// `"grayscale"`, `"grayscale-alpha"`, `"rgb"` or `"rgba"`.
    pub color_model: &'static str,
    pub bits_per_channel: u8,
    pub has_alpha_channel: bool,
    /// True when the stored pixels are rotated/flipped by EXIF orientation;
    /// the engine applies it so output matches what browsers display.
    pub orientation_corrected: bool,
    pub animated: bool,
    pub byte_size: usize,
}

fn reader<'a>(bytes: &'a [u8], format: Format, limits: &Limits) -> ImageReader<Cursor<&'a [u8]>> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format.to_image_format());
    let mut l = image::Limits::default();
    l.max_image_width = Some(limits.max_side);
    l.max_image_height = Some(limits.max_side);
    l.max_alloc = Some(limits.decoder_max_alloc());
    reader.limits(l);
    reader
}

fn is_animated(bytes: &[u8], format: Format) -> bool {
    match format {
        Format::Png => png_is_animated(bytes),
        Format::Webp => webp_is_animated(bytes),
        Format::Gif => gif_is_animated(bytes),
        _ => false,
    }
}

fn swaps_axes(o: Orientation) -> bool {
    matches!(
        o,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

/// Reads format, dimensions and colour layout from the header only.
///
/// Does not enforce pixel-count limits so the UI can show *why* an image is
/// too large; [`decode`] enforces them.
pub fn inspect(bytes: &[u8], limits: &Limits) -> Result<ImageInfo> {
    limits.check_input_len(bytes.len())?;
    let format = Format::detect(bytes)?;
    let mut decoder = reader(
        bytes,
        format,
        &Limits {
            max_side: u32::MAX,
            ..*limits
        },
    )
    .into_decoder()
    .map_err(EngineError::from_decode)?;
    let (w, h) = decoder.dimensions();
    let color = decoder.color_type();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = if swaps_axes(orientation) {
        (h, w)
    } else {
        (w, h)
    };
    let channels = color.channel_count();
    let has_alpha = color.has_alpha();
    let color_model = match (channels, has_alpha) {
        (1, _) => "grayscale",
        (2, _) => "grayscale-alpha",
        (_, false) => "rgb",
        (_, true) => "rgba",
    };
    Ok(ImageInfo {
        format,
        mime_type: format.mime_type(),
        width,
        height,
        color_model,
        bits_per_channel: (color.bits_per_pixel() / u16::from(channels)) as u8,
        has_alpha_channel: has_alpha,
        orientation_corrected: orientation != Orientation::NoTransforms,
        animated: is_animated(bytes, format),
        byte_size: bytes.len(),
    })
}

/// A decoded still image normalised to 8-bit RGBA with EXIF orientation applied.
#[derive(Debug, Clone)]
pub struct Decoded {
    pub format: Format,
    pub image: RgbaImage,
}

pub fn decode(bytes: &[u8], limits: &Limits) -> Result<Decoded> {
    limits.check_input_len(bytes.len())?;
    let format = Format::detect(bytes)?;
    if is_animated(bytes, format) {
        return Err(EngineError::AnimatedNotSupported);
    }
    if format == Format::Tiff && tiff_page_count(bytes) > 1 {
        return Err(EngineError::MultiPageNotSupported);
    }
    let mut decoder = reader(bytes, format, limits)
        .into_decoder()
        .map_err(EngineError::from_decode)?;
    let (w, h) = decoder.dimensions();
    limits.check_dimensions(w, h)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(EngineError::from_decode)?;
    img.apply_orientation(orientation);
    Ok(Decoded {
        format,
        image: img.into_rgba8(),
    })
}

/// True when every pixel is fully opaque.
pub fn is_opaque(img: &RgbaImage) -> bool {
    img.as_raw().chunks_exact(4).all(|p| p[3] == 255)
}
