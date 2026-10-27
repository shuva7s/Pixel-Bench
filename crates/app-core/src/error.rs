use image_core::EngineError;
use serde::Serialize;

/// An error for the UI: a stable `code` (as in the web version's
/// `EngineError`) and a plain-language `message`.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        AppError {
            code,
            message: message.into(),
        }
    }

    /// The file is AVIF/HEIC: the UI decodes it (system decoder or libheif) and
    /// opens the pixels with `open_rgba`.
    pub fn needs_ui_decoder(format: &str) -> Self {
        AppError::new(
            "NEEDS_UI_DECODER",
            format!("{format} files are decoded by the app's viewer."),
        )
    }

    pub fn not_loaded() -> Self {
        AppError::new(
            "ENGINE_NOT_READY",
            "The image is no longer loaded. Please open it again.",
        )
    }
}

impl From<EngineError> for AppError {
    fn from(e: EngineError) -> Self {
        AppError {
            code: e.code().as_str(),
            message: e.to_string(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new("IO_FAILED", e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
