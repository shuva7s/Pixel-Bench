//! ONNX Runtime sessions. Prefers the platform GPU provider (DirectML on
//! Windows, CoreML on macOS) and falls back to the CPU, both when a provider
//! cannot be registered and when it fails at run time.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use image_core::{DEFAULT_LIMITS, Operation, ResizeFilter, ResizeMode, RgbaImage};
use ort::environment::Environment;
use ort::ep::ExecutionProviderDispatch;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};

use crate::error::{AiError, Result};
use crate::mask::{segment_input, segment_output};
use crate::models::{ModelDirs, ModelId, spec};
use crate::upscale::{
    MODEL_SCALE, TILE, TILE_PAD, place_tile, plan_tiles, tile_input, upscale_alpha, upscale_problem,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    /// GPU when available, otherwise CPU.
    Auto,
    Cpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Gpu,
    Cpu,
}

/// The GPU execution provider for this platform, if there is one.
fn gpu_provider() -> Option<(ExecutionProviderDispatch, &'static str)> {
    #[cfg(windows)]
    return Some((
        ort::ep::DirectML::default().build().error_on_failure(),
        "DirectML",
    ));
    #[cfg(target_os = "macos")]
    return Some((
        ort::ep::CoreML::default().build().error_on_failure(),
        "CoreML",
    ));
    #[allow(unreachable_code)]
    None
}

/// Name of the GPU API used on this platform ("DirectML", "CoreML"), if any.
pub fn gpu_api() -> Option<&'static str> {
    gpu_provider().map(|(_, name)| name)
}

struct Loaded {
    id: ModelId,
    device: Device,
    backend: Backend,
    session: Session,
}

/// Keeps at most one model loaded, to bound memory.
pub struct Runtime {
    env: Environment,
    pub dirs: ModelDirs,
    loaded: Mutex<Option<Loaded>>,
}

pub struct Segmented {
    /// `size × size` mask, 0 = background, 255 = subject.
    pub mask: Vec<u8>,
    pub size: usize,
    pub backend: Backend,
    pub millis: u64,
}

/// Square input size of each segmentation model.
fn input_size(id: ModelId) -> Option<usize> {
    match id {
        ModelId::U2Netp => Some(320),
        ModelId::BiRefNetLite => Some(1024),
        ModelId::RealEsrganX4v3 => None,
    }
}

impl Runtime {
    pub fn new(dirs: ModelDirs) -> Result<Self> {
        let env = ort::init().with_name("pixel-bench").build()?;
        Ok(Runtime {
            env,
            dirs,
            loaded: Mutex::new(None),
        })
    }

    fn create(&self, bytes: &[u8], gpu: Option<ExecutionProviderDispatch>) -> Result<Session> {
        let opt = |e: ort::Error<ort::session::builder::SessionBuilder>| {
            AiError::from(ort::Error::from(e))
        };
        let mut b = Session::builder(&self.env)?
            .with_optimization_level(GraphOptimizationLevel::All)
            .map_err(opt)?;
        if let Some(ep) = gpu {
            // DirectML needs sequential execution without memory patterns.
            b = b.with_memory_pattern(false).map_err(opt)?;
            b = b.with_parallel_execution(false).map_err(opt)?;
            b = b.with_execution_providers([ep]).map_err(opt)?;
        }
        Ok(b.commit_from_memory(bytes)?)
    }

    /// Loads `id` (reusing the current session when possible).
    fn with_session<T>(
        &self,
        id: ModelId,
        device: Device,
        f: impl FnOnce(&mut Loaded) -> Result<T>,
    ) -> Result<T> {
        let mut guard = self.loaded.lock().unwrap();
        if guard
            .as_ref()
            .is_none_or(|l| l.id != id || l.device != device)
        {
            *guard = None; // free the previous model first
            let bytes = self.dirs.load(id)?;
            let gpu = if device == Device::Auto {
                gpu_provider()
            } else {
                None
            };
            let (session, backend) = match gpu.map(|(ep, _)| self.create(&bytes, Some(ep))) {
                Some(Ok(s)) => (s, Backend::Gpu),
                _ => (
                    self.create(&bytes, None).map_err(|e| {
                        AiError::new(
                            "MODEL_LOAD_FAILED",
                            format!("Could not start {}: {e}", spec(id).name),
                        )
                    })?,
                    Backend::Cpu,
                ),
            };
            *guard = Some(Loaded {
                id,
                device,
                backend,
                session,
            });
        }
        f(guard.as_mut().unwrap())
    }

    /// Runs a single-input model; a GPU failure at run time switches this model to the CPU and retries once.
    fn run(&self, loaded: &mut Loaded, data: Vec<f32>, dims: [usize; 4]) -> Result<Vec<f32>> {
        let attempt = |session: &mut Session, data: Vec<f32>| -> Result<Vec<f32>> {
            let input = Tensor::from_array((dims, data))?;
            let outputs = session.run(ort::inputs![input])?;
            let (_, values) = outputs[0].try_extract_tensor::<f32>()?;
            Ok(values.to_vec())
        };
        match attempt(&mut loaded.session, data.clone()) {
            Ok(v) => Ok(v),
            Err(_) if loaded.backend == Backend::Gpu => {
                let bytes = self.dirs.load(loaded.id)?;
                loaded.session = self.create(&bytes, None)?;
                loaded.backend = Backend::Cpu;
                attempt(&mut loaded.session, data)
            }
            Err(e) => Err(e),
        }
    }

    /// Finds the subject. The mask is `size × size`, covering the whole image.
    pub fn segment(&self, image: &RgbaImage, id: ModelId, device: Device) -> Result<Segmented> {
        let size = input_size(id)
            .ok_or_else(|| AiError::new("INVALID_OPTIONS", "Not a background-removal model."))?;
        let filter = if id == ModelId::U2Netp {
            ResizeFilter::Lanczos3
        } else {
            ResizeFilter::Bilinear
        };
        let resized = image_core::ops::apply(
            image.clone(),
            &Operation::Resize {
                size: ResizeMode::Exact {
                    width: size as u32,
                    height: size as u32,
                },
                filter,
            },
            &DEFAULT_LIMITS,
        )?;
        let input = segment_input(resized.as_raw(), size, id);
        self.with_session(id, device, |loaded| {
            let start = Instant::now();
            let raw = self.run(loaded, input, [1, 3, size, size])?;
            let millis = start.elapsed().as_millis() as u64;
            let mask = segment_output(&raw[..size * size], id);
            Ok(Segmented {
                mask,
                size,
                backend: loaded.backend,
                millis,
            })
        })
    }

    /// AI upscale by 2 or 4. `progress` gets a fraction (0–1); `cancel` stops between tiles.
    pub fn upscale(
        &self,
        image: &RgbaImage,
        factor: u32,
        device: Device,
        mut progress: impl FnMut(f64),
        cancel: &AtomicBool,
    ) -> Result<(RgbaImage, Backend)> {
        if factor != 2 && factor != 4 {
            return Err(AiError::new(
                "INVALID_OPTIONS",
                "The upscale factor must be 2 or 4.",
            ));
        }
        if let Some(problem) = upscale_problem(image.width(), image.height(), factor) {
            return Err(AiError::new("TOO_LARGE", problem));
        }
        let (w, h) = (image.width() as usize, image.height() as usize);
        let f = factor as usize;
        let (ow, oh) = (w * f, h * f);
        let src = image.as_raw();
        let mut out = vec![0u8; ow * oh * 4];
        let tiles = plan_tiles(w, h, TILE, TILE_PAD);
        let backend = self.with_session(ModelId::RealEsrganX4v3, device, |loaded| {
            for (i, t) in tiles.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AiError::new("CANCELLED", "Cancelled."));
                }
                progress(i as f64 / tiles.len() as f64);
                let y = self.run(
                    loaded,
                    tile_input(src, w, t),
                    [1, 3, t.in_height, t.in_width],
                )?;
                if y.len() != 3 * t.in_width * t.in_height * MODEL_SCALE * MODEL_SCALE {
                    return Err(AiError::new(
                        "INFERENCE_FAILED",
                        "The upscaling model returned an unexpected size.",
                    ));
                }
                place_tile(&y, t, &mut out, ow, f);
            }
            Ok(loaded.backend)
        })?;
        progress(1.0);
        if image_core::is_opaque(image) {
            out.chunks_exact_mut(4).for_each(|p| p[3] = 255);
        } else {
            upscale_alpha(src, w, h, &mut out, f);
        }
        Ok((
            RgbaImage::from_raw(ow as u32, oh as u32, out).expect("sized buffer"),
            backend,
        ))
    }
}
