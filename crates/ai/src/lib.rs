//! On-device AI for the desktop app: background removal (U²-Netp,
//! BiRefNet-lite) and super-resolution (Real-ESRGAN), run with native ONNX
//! Runtime.

pub mod error;
pub mod mask;
pub mod models;
pub mod removebg;
pub mod runtime;
pub mod upscale;

pub use error::{AiError, Result};
pub use models::{ModelDirs, ModelId};
pub use runtime::{Backend, Device, Runtime, gpu_api};
