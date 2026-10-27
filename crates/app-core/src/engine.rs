//! Open images (editor, background removal) and one-shot jobs (utilities).
//! Mirrors the request/response protocol the UI used with its Web Worker.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use image_core::metadata::{MetadataReport, StripOptions, inspect_metadata, strip_metadata};
use image_core::{DEFAULT_LIMITS, ImageInfo, Operation, ResizeFilter, ResizeMode, RgbaImage};
use serde::Serialize;

use crate::encode::{Encoded, encode};
use crate::error::{AppError, Result};
use crate::overlay::{Overlay, draw_overlays};
use crate::settings::{OutputSettings, SourceFormat, StripSpec, TargetSpec};
use crate::target::{MAX_SCALE, TargetOutcome, fit_to_target};

/// Header-level facts about a file (also for AVIF/HEIC, which are decoded by the UI).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub format: SourceFormat,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub color_model: String,
    pub bits_per_channel: u8,
    pub has_alpha_channel: bool,
    pub orientation_corrected: bool,
    pub animated: bool,
    pub byte_size: usize,
}

impl From<ImageInfo> for FileInfo {
    fn from(i: ImageInfo) -> Self {
        FileInfo {
            format: i.format.into(),
            mime_type: i.mime_type.into(),
            width: i.width,
            height: i.height,
            color_model: i.color_model.into(),
            bits_per_channel: i.bits_per_channel,
            has_alpha_channel: i.has_alpha_channel,
            orientation_corrected: i.orientation_corrected,
            animated: i.animated,
            byte_size: i.byte_size,
        }
    }
}

/// AVIF / HEIC detection from the ISO-BMFF `ftyp` box: (format, animated).
pub fn sniff_container(b: &[u8]) -> Option<(SourceFormat, bool)> {
    if b.len() < 16 || &b[4..8] != b"ftyp" {
        return None;
    }
    let size = (u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize).min(b.len());
    let mut brands = vec![&b[8..12]];
    let mut i = 16;
    while i + 4 <= size {
        brands.push(&b[i..i + 4]);
        i += 4;
    }
    let has = |x: &[u8]| brands.contains(&x);
    const HEIC: [&[u8]; 8] = [
        b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs",
    ];
    if has(b"avis") {
        return Some((SourceFormat::Avif, true));
    }
    if has(b"avif") {
        return Some((SourceFormat::Avif, false));
    }
    if HEIC.iter().any(|x| has(x)) {
        return Some((SourceFormat::Heic, has(b"hevs") || has(b"msf1")));
    }
    has(b"mif1").then_some((SourceFormat::Heic, false))
}

/// Primary image size from the first `ispe` box.
fn read_ispe(b: &[u8]) -> Option<(u32, u32)> {
    let at = b.windows(4).position(|w| w == b"ispe")?;
    let v = b.get(at + 8..at + 16)?;
    Some((
        u32::from_be_bytes([v[0], v[1], v[2], v[3]]),
        u32::from_be_bytes([v[4], v[5], v[6], v[7]]),
    ))
}

/// Inspects any supported file, including AVIF/HEIC (size from the container).
pub fn inspect(bytes: &[u8]) -> Result<FileInfo> {
    if let Some((format, animated)) = sniff_container(bytes) {
        let (width, height) = read_ispe(bytes)
            .filter(|&(w, h)| w > 0 && h > 0)
            .ok_or_else(|| {
                AppError::new("DECODE_FAILED", "The file has no readable image size.")
            })?;
        return Ok(FileInfo {
            format,
            mime_type: if format == SourceFormat::Avif {
                "image/avif"
            } else {
                "image/heic"
            }
            .into(),
            width,
            height,
            color_model: "rgba".into(),
            bits_per_channel: 8,
            has_alpha_channel: format == SourceFormat::Avif,
            orientation_corrected: false,
            animated,
            byte_size: bytes.len(),
        });
    }
    Ok(image_core::inspect(bytes, &DEFAULT_LIMITS)?.into())
}

/// Metadata report, or None for formats it does not apply to.
pub fn safe_metadata(bytes: &[u8]) -> Option<MetadataReport> {
    inspect_metadata(bytes).ok()
}

/// Decodes `bytes`, or asks the UI to decode AVIF/HEIC.
pub fn decode(bytes: &[u8]) -> Result<(RgbaImage, FileInfo)> {
    if let Some((format, animated)) = sniff_container(bytes) {
        if animated {
            return Err(image_core::EngineError::AnimatedNotSupported.into());
        }
        return Err(AppError::needs_ui_decoder(
            if format == SourceFormat::Avif {
                "AVIF"
            } else {
                "HEIC"
            },
        ));
    }
    let info = inspect(bytes)?;
    let decoded = image_core::decode(bytes, &DEFAULT_LIMITS)?;
    Ok((decoded.image, info))
}

/// Wraps pixels decoded by the UI (AVIF/HEIC), checking the size limits.
pub fn from_rgba(rgba: Vec<u8>, width: u32, height: u32) -> Result<RgbaImage> {
    DEFAULT_LIMITS.check_dimensions(width, height)?;
    RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| AppError::new("INVALID_DIMENSIONS", "Pixel data does not match the size."))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub handle: u32,
    pub info: FileInfo,
    pub has_transparency: bool,
    pub metadata: Option<MetadataReport>,
}

/// Raw RGBA for drawing a preview.
#[derive(Debug, Clone)]
pub struct Frame {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// An encoded output plus, when a target was requested, how it went.
#[derive(Debug, Clone)]
pub struct Rendered {
    pub encoded: Encoded,
    pub target: Option<TargetOutcome>,
}

struct Session {
    image: RgbaImage,
    source: SourceFormat,
    /// Downscaled proxies for previews, keyed by maximum side.
    proxies: Mutex<HashMap<u32, Arc<RgbaImage>>>,
}

/// Images kept open by the UI and registered logos. Thread-safe: requests
/// for different images run in parallel.
#[derive(Default)]
pub struct Engine {
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    logos: RwLock<HashMap<String, RgbaImage>>,
    next: AtomicU32,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    fn session(&self, handle: u32) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(&handle)
            .cloned()
            .ok_or_else(AppError::not_loaded)
    }

    fn insert(
        &self,
        image: RgbaImage,
        info: FileInfo,
        metadata: Option<MetadataReport>,
    ) -> OpenResult {
        let handle = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let has_transparency = !image_core::is_opaque(&image);
        let source = info.format;
        self.sessions.lock().unwrap().insert(
            handle,
            Arc::new(Session {
                image,
                source,
                proxies: Mutex::default(),
            }),
        );
        OpenResult {
            handle,
            info,
            has_transparency,
            metadata,
        }
    }

    /// Decodes and keeps an image (AVIF/HEIC: error `NEEDS_UI_DECODER`).
    pub fn open(&self, bytes: &[u8]) -> Result<OpenResult> {
        let (image, info) = decode(bytes)?;
        Ok(self.insert(image, info, safe_metadata(bytes)))
    }

    /// Keeps pixels decoded by the UI.
    pub fn open_rgba(
        &self,
        rgba: Vec<u8>,
        width: u32,
        height: u32,
        mut info: FileInfo,
    ) -> Result<OpenResult> {
        let image = from_rgba(rgba, width, height)?;
        info.width = width;
        info.height = height;
        info.has_alpha_channel = !image_core::is_opaque(&image);
        Ok(self.insert(image, info, None))
    }

    pub fn close(&self, handle: u32) {
        self.sessions.lock().unwrap().remove(&handle);
    }

    pub fn source(&self, handle: u32) -> Result<(SourceFormat, u32, u32)> {
        let s = self.session(handle)?;
        Ok((s.source, s.image.width(), s.image.height()))
    }

    /// A clone of the full-resolution pixels (for the AI tools).
    pub fn pixels(&self, handle: u32) -> Result<RgbaImage> {
        Ok(self.session(handle)?.image.clone())
    }

    /// Renders `ops` (and overlays) on a cached proxy whose long side is at most `max_side`.
    pub fn preview(
        &self,
        handle: u32,
        ops: &[Operation],
        max_side: u32,
        overlays: &[Overlay],
    ) -> Result<Frame> {
        let s = self.session(handle)?;
        let proxy = {
            let mut proxies = s.proxies.lock().unwrap();
            match proxies.get(&max_side) {
                Some(p) => p.clone(),
                None => {
                    let p = Arc::new(image_core::thumbnail(&s.image, max_side, &DEFAULT_LIMITS)?);
                    proxies.insert(max_side, p.clone());
                    p
                }
            }
        };
        let scale = f64::from(proxy.width()) / f64::from(s.image.width());
        let mut img =
            image_core::ops::apply_all_scaled((*proxy).clone(), ops, scale, &DEFAULT_LIMITS)?;
        draw_overlays(&mut img, overlays, &self.logos.read().unwrap());
        let (width, height) = img.dimensions();
        Ok(Frame {
            pixels: img.into_raw(),
            width,
            height,
        })
    }

    /// Full-resolution render and encode.
    pub fn render(
        &self,
        handle: u32,
        ops: &[Operation],
        settings: &OutputSettings,
        overlays: &[Overlay],
        target: Option<TargetSpec>,
    ) -> Result<Rendered> {
        let s = self.session(handle)?;
        render_output(
            &s.image,
            s.source,
            ops,
            settings,
            overlays,
            &self.logos.read().unwrap(),
            target,
        )
    }

    /// Registers a logo for image overlays; returns its size.
    pub fn set_logo(&self, id: String, bytes: &[u8]) -> Result<(u32, u32)> {
        let (img, _) = decode(bytes)?;
        let dims = img.dimensions();
        self.logos.write().unwrap().insert(id, img);
        Ok(dims)
    }

    /// One-shot job (utilities): decode or take `pixels`, transform and encode,
    /// or remove metadata without re-encoding.
    pub fn process(&self, job: Job<'_>) -> Result<Processed> {
        if let Some(strip) = job.strip {
            let info = inspect(job.bytes)?;
            let out = strip_metadata(
                job.bytes,
                StripOptions {
                    keep_orientation: strip.keep_orientation,
                    keep_icc: strip.keep_icc,
                },
            )?;
            let format = info.format.writable();
            return Ok(Processed {
                rendered: Rendered {
                    encoded: Encoded {
                        bytes: out,
                        format,
                        width: info.width,
                        height: info.height,
                    },
                    target: None,
                },
                source_info: info,
                lossless: true,
            });
        }
        let (image, info) = match job.pixels {
            Some((rgba, w, h, info)) => (from_rgba(rgba, w, h)?, info),
            None => decode(job.bytes)?,
        };
        let rendered = render_output(
            &image,
            info.format,
            job.ops,
            job.settings,
            job.overlays,
            &self.logos.read().unwrap(),
            job.target,
        )?;
        Ok(Processed {
            rendered,
            source_info: info,
            lossless: false,
        })
    }
}

pub struct Job<'a> {
    pub bytes: &'a [u8],
    /// Pixels decoded by the UI (AVIF/HEIC) instead of `bytes`.
    pub pixels: Option<(Vec<u8>, u32, u32, FileInfo)>,
    pub ops: &'a [Operation],
    pub settings: &'a OutputSettings,
    pub overlays: &'a [Overlay],
    pub target: Option<TargetSpec>,
    pub strip: Option<StripSpec>,
}

#[derive(Debug, Clone)]
pub struct Processed {
    pub rendered: Rendered,
    pub source_info: FileInfo,
    /// True when the file was rewritten without re-encoding (metadata only).
    pub lossless: bool,
}

fn with_scale(ops: &[Operation], scale: f64) -> Vec<Operation> {
    let mut v = ops.to_vec();
    if (scale - 1.0).abs() > 1e-9 {
        v.push(Operation::Resize {
            size: ResizeMode::Percent {
                percent: scale * 100.0,
            },
            filter: ResizeFilter::Lanczos3,
        });
    }
    v
}

fn encode_with(
    image: &RgbaImage,
    source: SourceFormat,
    ops: &[Operation],
    settings: &OutputSettings,
    overlays: &[Overlay],
    logos: &HashMap<String, RgbaImage>,
    quality: Option<u8>,
) -> Result<Encoded> {
    let mut img = image_core::ops::apply_all(image.clone(), ops, &DEFAULT_LIMITS)?;
    draw_overlays(&mut img, overlays, logos);
    Ok(encode(img, settings, source, quality)?)
}

impl crate::target::HasSize for Encoded {
    fn size(&self) -> u64 {
        self.bytes.len() as u64
    }
}

/// Encodes, optionally searching quality and dimensions for a target size.
pub fn render_output(
    image: &RgbaImage,
    source: SourceFormat,
    ops: &[Operation],
    settings: &OutputSettings,
    overlays: &[Overlay],
    logos: &HashMap<String, RgbaImage>,
    target: Option<TargetSpec>,
) -> Result<Rendered> {
    let Some(spec) = target else {
        return Ok(Rendered {
            encoded: encode_with(image, source, ops, settings, overlays, logos, None)?,
            target: None,
        });
    };
    let pixels = f64::from(image.width()) * f64::from(image.height());
    let max_scale = (DEFAULT_LIMITS.max_pixels as f64 / pixels)
        .sqrt()
        .min(f64::from(DEFAULT_LIMITS.max_side) / f64::from(image.width().max(image.height())))
        .clamp(0.05, MAX_SCALE);
    let mut failure: Option<AppError> = None;
    let result = fit_to_target(
        |q, scale| {
            encode_with(
                image,
                source,
                &with_scale(ops, scale),
                settings,
                overlays,
                logos,
                Some(q),
            )
            .map_err(|e| {
                let msg = e.message.clone();
                failure = Some(e);
                image_core::EngineError::Encode(msg)
            })
        },
        spec,
        settings.is_lossy(source),
        max_scale,
    );
    match result {
        Ok(r) => Ok(Rendered {
            target: Some(r.outcome()),
            encoded: r.output,
        }),
        Err(e) => Err(failure.unwrap_or_else(|| e.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{AvifSpeed, OutputFormat, TargetMode};
    use image_core::{Format, PngCompression};

    fn settings(format: OutputFormat) -> OutputSettings {
        OutputSettings {
            format,
            quality: 85,
            progressive: false,
            png_compression: PngCompression::Default,
            webp_lossless: false,
            avif_speed: AvifSpeed::Fast,
            background: "#ffffff".into(),
        }
    }

    fn noisy_png(w: u32, h: u32) -> Vec<u8> {
        let mut seed = 3u32;
        let img = RgbaImage::from_fn(w, h, |x, y| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            image::Rgba([(x * 2) as u8, (y * 3) as u8, (seed >> 24) as u8, 255])
        });
        image_core::encode(
            img,
            &image_core::EncodeOptions::Png {
                compression: PngCompression::Fast,
            },
        )
        .unwrap()
    }

    #[test]
    fn open_preview_render_close() {
        let engine = Engine::new();
        let opened = engine.open(&noisy_png(400, 300)).unwrap();
        assert_eq!((opened.info.width, opened.info.height), (400, 300));
        assert!(!opened.has_transparency);
        let frame = engine.preview(opened.handle, &[], 200, &[]).unwrap();
        assert_eq!((frame.width, frame.height), (200, 150));
        assert_eq!(frame.pixels.len(), 200 * 150 * 4);
        let crop: Vec<Operation> =
            serde_json::from_str(r#"[{"op":"crop","x":0,"y":0,"width":200,"height":100}]"#)
                .unwrap();
        let r = engine
            .render(
                opened.handle,
                &crop,
                &settings(OutputFormat::Jpeg),
                &[],
                None,
            )
            .unwrap();
        assert_eq!(
            (r.encoded.width, r.encoded.height, r.encoded.format),
            (200, 100, Format::Jpeg)
        );
        // The preview scales the crop to the proxy.
        assert_eq!(
            engine
                .preview(opened.handle, &crop, 200, &[])
                .unwrap()
                .width,
            100
        );
        engine.close(opened.handle);
        assert_eq!(
            engine
                .preview(opened.handle, &[], 200, &[])
                .unwrap_err()
                .code,
            "ENGINE_NOT_READY"
        );
    }

    #[test]
    fn render_meets_a_target_size() {
        let engine = Engine::new();
        let h = engine.open(&noisy_png(320, 240)).unwrap().handle;
        let spec = TargetSpec {
            bytes: 30 * 1024,
            mode: TargetMode::AtMost,
            allow_resize: false,
        };
        let r = engine
            .render(h, &[], &settings(OutputFormat::Jpeg), &[], Some(spec))
            .unwrap();
        let t = r.target.unwrap();
        assert!(t.met && r.encoded.bytes.len() <= 30 * 1024, "{t:?}");
    }

    #[test]
    fn process_strips_metadata_losslessly() {
        let engine = Engine::new();
        let bytes = noisy_png(50, 40);
        let strip = StripSpec {
            keep_orientation: true,
            keep_icc: true,
        };
        let out = engine
            .process(Job {
                bytes: &bytes,
                pixels: None,
                ops: &[],
                settings: &settings(OutputFormat::Same),
                overlays: &[],
                target: None,
                strip: Some(strip),
            })
            .unwrap();
        assert!(out.lossless);
        assert_eq!(
            image::load_from_memory(&out.rendered.encoded.bytes)
                .unwrap()
                .to_rgba8(),
            image::load_from_memory(&bytes).unwrap().to_rgba8()
        );
    }

    #[test]
    fn containers_are_detected_and_handed_to_the_ui() {
        let mut heic = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic".to_vec();
        heic.extend_from_slice(b"\0\0\0\x14ispe\0\0\0\0\0\0\0\x60\0\0\0\x40");
        assert_eq!(sniff_container(&heic), Some((SourceFormat::Heic, false)));
        let info = inspect(&heic).unwrap();
        assert_eq!((info.width, info.height), (96, 64));
        assert_eq!(decode(&heic).unwrap_err().code, "NEEDS_UI_DECODER");
        let engine = Engine::new();
        let r = engine
            .open_rgba(vec![255; 96 * 64 * 4], 96, 64, info)
            .unwrap();
        assert_eq!(r.info.format, SourceFormat::Heic);
        assert!(sniff_container(&noisy_png(8, 8)).is_none());
    }
}
