//! The image engine of Pixel Bench: decoding, inspection, operations,
//! encoding and metadata. Pure Rust with no UI dependency; the `parallel`
//! feature spreads the heavy loops over all cores.

pub mod decode;
pub mod encode;
pub mod error;
pub mod format;
pub mod limits;
pub mod metadata;
pub mod ops;
mod par;

pub use image::RgbaImage;

pub use decode::{Decoded, ImageInfo, decode, inspect, is_opaque};
pub use encode::{EncodeOptions, PngCompression, encode};
pub use error::{EngineError, ErrorCode, Result};
pub use format::Format;
pub use limits::{DEFAULT_LIMITS, Limits};
pub use ops::{CropRect, Develop, FlipDirection, Operation, ResizeFilter, ResizeMode};

/// The encoded result of a pipeline run.
#[derive(Debug, Clone)]
pub struct Output {
    pub bytes: Vec<u8>,
    pub format: Format,
    pub width: u32,
    pub height: u32,
}

/// Applies `ops` to a copy of `source` and encodes the result.
pub fn render(
    source: &RgbaImage,
    ops: &[Operation],
    encode_opts: &EncodeOptions,
    limits: &Limits,
) -> Result<Output> {
    // Validate encoder options before doing any expensive pixel work.
    encode_opts.validate()?;
    let img = ops::apply_all(source.clone(), ops, limits)?;
    let (width, height) = img.dimensions();
    let bytes = encode::encode(img, encode_opts)?;
    Ok(Output {
        bytes,
        format: encode_opts.format(),
        width,
        height,
    })
}

/// Decode, transform and encode in one call (used for batch jobs).
pub fn process(
    input: &[u8],
    ops: &[Operation],
    encode_opts: &EncodeOptions,
    limits: &Limits,
) -> Result<Output> {
    encode_opts.validate()?;
    let decoded = decode::decode(input, limits)?;
    let img = ops::apply_all(decoded.image, ops, limits)?;
    let (width, height) = img.dimensions();
    let bytes = encode::encode(img, encode_opts)?;
    Ok(Output {
        bytes,
        format: encode_opts.format(),
        width,
        height,
    })
}

/// Downscales (never upscales) so the longest side is at most `max_side`.
/// Used to build cheap proxies for live previews.
pub fn thumbnail(source: &RgbaImage, max_side: u32, limits: &Limits) -> Result<RgbaImage> {
    let op = Operation::Resize {
        size: ResizeMode::Fit {
            max_width: max_side,
            max_height: max_side,
            allow_upscale: false,
        },
        filter: ResizeFilter::Bilinear,
    };
    ops::apply(source.clone(), &op, limits)
}
