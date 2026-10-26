//! wasm-bindgen bindings for `image-core`.
//!
//! Structured options cross the boundary as JSON strings (validated by serde
//! on the Rust side); pixel and file data cross as `Uint8Array`s. Errors are
//! thrown as JS `Error`s whose `name` is a stable code such as `INVALID_CROP`.

use image_core::{
    DEFAULT_LIMITS, EncodeOptions, EngineError, Format, Operation, RgbaImage, decode, inspect,
    is_opaque,
};
use wasm_bindgen::prelude::*;

fn js_error(err: EngineError) -> JsValue {
    let e = js_sys::Error::new(&err.to_string());
    e.set_name(err.code().as_str());
    e.into()
}

fn parse<T: serde::de::DeserializeOwned>(json: &str, what: &str) -> Result<T, JsValue> {
    serde_json::from_str(json)
        .map_err(|e| js_error(EngineError::InvalidOptions(format!("{what}: {e}"))))
}

/// Header-only inspection; returns `ImageInfo` serialised as JSON.
#[wasm_bindgen(js_name = inspect)]
pub fn inspect_js(bytes: &[u8]) -> Result<String, JsValue> {
    let info = inspect(bytes, &DEFAULT_LIMITS).map_err(js_error)?;
    serde_json::to_string(&info).map_err(|e| js_error(EngineError::Encode(e.to_string())))
}

/// The engine's safety limits as JSON (`maxInputBytes`, `maxSide`, `maxPixels`).
/// Metadata report (EXIF fields and other blocks) as JSON.
#[wasm_bindgen(js_name = inspectMetadata)]
pub fn inspect_metadata_js(bytes: &[u8]) -> Result<String, JsValue> {
    let report = image_core::metadata::inspect_metadata(bytes).map_err(js_error)?;
    serde_json::to_string(&report).map_err(|e| js_error(EngineError::Encode(e.to_string())))
}

/// Removes metadata without re-encoding (JPEG, PNG, WebP). The result is
/// re-inspected and an error is thrown unless it is verifiably clean.
#[wasm_bindgen(js_name = stripMetadata)]
pub fn strip_metadata_js(
    bytes: &[u8],
    keep_orientation: bool,
    keep_icc: bool,
) -> Result<Vec<u8>, JsValue> {
    image_core::metadata::strip_metadata(
        bytes,
        image_core::metadata::StripOptions {
            keep_orientation,
            keep_icc,
        },
    )
    .map_err(js_error)
}

#[wasm_bindgen(js_name = limits)]
pub fn limits_js() -> String {
    format!(
        r#"{{"maxInputBytes":{},"maxSide":{},"maxPixels":{}}}"#,
        DEFAULT_LIMITS.max_input_bytes, DEFAULT_LIMITS.max_side, DEFAULT_LIMITS.max_pixels
    )
}

/// An encoded output file.
#[wasm_bindgen]
pub struct EncodedOutput {
    bytes: Vec<u8>,
    format: Format,
    width: u32,
    height: u32,
}

#[wasm_bindgen]
impl EncodedOutput {
    /// Moves the encoded bytes out (subsequent calls return an empty array).
    #[wasm_bindgen(js_name = takeBytes)]
    pub fn take_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String {
        format_name(self.format).into()
    }
}

impl From<image_core::Output> for EncodedOutput {
    fn from(o: image_core::Output) -> Self {
        EncodedOutput {
            bytes: o.bytes,
            format: o.format,
            width: o.width,
            height: o.height,
        }
    }
}

/// Raw RGBA pixels for drawing a preview onto a canvas.
#[wasm_bindgen]
pub struct RgbaFrame {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

#[wasm_bindgen]
impl RgbaFrame {
    #[wasm_bindgen(js_name = takePixels)]
    pub fn take_pixels(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pixels)
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
}

fn format_name(f: Format) -> &'static str {
    match f {
        Format::Jpeg => "jpeg",
        Format::Png => "png",
        Format::Webp => "webp",
        Format::Bmp => "bmp",
        Format::Gif => "gif",
        Format::Tiff => "tiff",
        Format::Ico => "ico",
        Format::Avif => "avif",
    }
}

/// A decoded image kept in WASM memory so several renders can reuse one decode.
#[wasm_bindgen]
pub struct EngineImage {
    image: RgbaImage,
    format: Format,
    /// Size relative to the original decode (1.0, or < 1 for a thumbnail).
    scale: f64,
}

#[wasm_bindgen]
impl EngineImage {
    /// Wraps straight-alpha RGBA pixels decoded elsewhere (e.g. by the
    /// browser for AVIF/HEIC). `format` is only used as a label.
    #[wasm_bindgen(js_name = fromRgba)]
    pub fn from_rgba(pixels: Vec<u8>, width: u32, height: u32) -> Result<EngineImage, JsValue> {
        DEFAULT_LIMITS
            .check_dimensions(width, height)
            .map_err(js_error)?;
        let image = RgbaImage::from_raw(width, height, pixels).ok_or_else(|| {
            js_error(EngineError::InvalidDimensions(format!(
                "pixel buffer does not match {width}x{height}"
            )))
        })?;
        Ok(EngineImage {
            image,
            format: Format::Png,
            scale: 1.0,
        })
    }

    pub fn decode(bytes: &[u8]) -> Result<EngineImage, JsValue> {
        let d = decode(bytes, &DEFAULT_LIMITS).map_err(js_error)?;
        Ok(EngineImage {
            image: d.image,
            format: d.format,
            scale: 1.0,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.image.width()
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.image.height()
    }
    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String {
        format_name(self.format).into()
    }
    /// True when at least one pixel is not fully opaque.
    #[wasm_bindgen(js_name = hasTransparency)]
    pub fn has_transparency(&self) -> bool {
        !is_opaque(&self.image)
    }

    /// A downscaled copy for fast previews.
    pub fn thumbnail(&self, max_side: u32) -> Result<EngineImage, JsValue> {
        let image =
            image_core::thumbnail(&self.image, max_side, &DEFAULT_LIMITS).map_err(js_error)?;
        let scale = self.scale * image.width() as f64 / self.image.width() as f64;
        Ok(EngineImage {
            image,
            format: self.format,
            scale,
        })
    }

    /// Applies `ops_json` (an `Operation[]`) and encodes with `encode_json`.
    pub fn render(&self, ops_json: &str, encode_json: &str) -> Result<EncodedOutput, JsValue> {
        let ops: Vec<Operation> = parse(ops_json, "operations")?;
        let enc: EncodeOptions = parse(encode_json, "encode options")?;
        image_core::render(&self.image, &ops, &enc, &DEFAULT_LIMITS)
            .map(Into::into)
            .map_err(js_error)
    }

    /// Applies `ops_json` and returns raw RGBA pixels (no encoding). Ops are
    /// written for the full-resolution image; on a thumbnail, crop
    /// rectangles and pixel radii are scaled to match.
    #[wasm_bindgen(js_name = renderRgba)]
    pub fn render_rgba(&self, ops_json: &str) -> Result<RgbaFrame, JsValue> {
        let ops: Vec<Operation> = parse(ops_json, "operations")?;
        let img = image_core::ops::apply_all_scaled(
            self.image.clone(),
            &ops,
            self.scale,
            &DEFAULT_LIMITS,
        )
        .map_err(js_error)?;
        let (width, height) = img.dimensions();
        Ok(RgbaFrame {
            pixels: img.into_raw(),
            width,
            height,
        })
    }
}

/// One-shot decode, transform and encode (used for batch jobs).
#[wasm_bindgen]
pub fn process(bytes: &[u8], ops_json: &str, encode_json: &str) -> Result<EncodedOutput, JsValue> {
    let ops: Vec<Operation> = parse(ops_json, "operations")?;
    let enc: EncodeOptions = parse(encode_json, "encode options")?;
    image_core::process(bytes, &ops, &enc, &DEFAULT_LIMITS)
        .map(Into::into)
        .map_err(js_error)
}
