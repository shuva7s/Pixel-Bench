use serde::Serialize;

/// An error with a stable code, matching the UI's error codes.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AiError {
    pub code: &'static str,
    pub message: String,
}

impl AiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        AiError {
            code,
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for AiError {
    fn from(e: std::io::Error) -> Self {
        AiError::new("IO_FAILED", e.to_string())
    }
}

impl From<ort::Error> for AiError {
    fn from(e: ort::Error) -> Self {
        AiError::new(
            "INFERENCE_FAILED",
            format!("The AI model failed to run: {e}"),
        )
    }
}

impl From<image_core::EngineError> for AiError {
    fn from(e: image_core::EngineError) -> Self {
        AiError {
            code: e.code().as_str(),
            message: e.to_string(),
        }
    }
}

pub type Result<T> = std::result::Result<T, AiError>;
