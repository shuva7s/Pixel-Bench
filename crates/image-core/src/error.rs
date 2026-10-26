use thiserror::Error;

/// Every failure the engine can report. Each variant maps to a stable
/// machine-readable [`ErrorCode`] so the UI can react without parsing text.
#[derive(Debug, Error)]
pub enum EngineError {
    #[error("The file is empty.")]
    EmptyInput,

    #[error(
        "Unsupported or unrecognised image format. Supported formats: JPEG, PNG, WebP, BMP, GIF, TIFF, ICO, AVIF and HEIC."
    )]
    UnsupportedFormat,

    #[error("Animated images are not supported yet; only still images can be processed.")]
    AnimatedNotSupported,

    #[error(
        "Multi-page TIFF files are not supported yet; only single-page TIFFs can be processed."
    )]
    MultiPageNotSupported,

    #[error("The image could not be decoded: {0}")]
    Decode(String),

    #[error("The image could not be encoded: {0}")]
    Encode(String),

    #[error("{0}")]
    TooLarge(String),

    #[error("Invalid dimensions: {0}")]
    InvalidDimensions(String),

    #[error("Invalid crop: {0}")]
    InvalidCrop(String),

    #[error("Invalid options: {0}")]
    InvalidOptions(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    EmptyInput,
    UnsupportedFormat,
    AnimatedNotSupported,
    MultiPageNotSupported,
    DecodeFailed,
    EncodeFailed,
    TooLarge,
    InvalidDimensions,
    InvalidCrop,
    InvalidOptions,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::EmptyInput => "EMPTY_INPUT",
            ErrorCode::UnsupportedFormat => "UNSUPPORTED_FORMAT",
            ErrorCode::AnimatedNotSupported => "ANIMATED_NOT_SUPPORTED",
            ErrorCode::MultiPageNotSupported => "MULTI_PAGE_NOT_SUPPORTED",
            ErrorCode::DecodeFailed => "DECODE_FAILED",
            ErrorCode::EncodeFailed => "ENCODE_FAILED",
            ErrorCode::TooLarge => "TOO_LARGE",
            ErrorCode::InvalidDimensions => "INVALID_DIMENSIONS",
            ErrorCode::InvalidCrop => "INVALID_CROP",
            ErrorCode::InvalidOptions => "INVALID_OPTIONS",
        }
    }
}

impl EngineError {
    pub fn code(&self) -> ErrorCode {
        match self {
            EngineError::EmptyInput => ErrorCode::EmptyInput,
            EngineError::UnsupportedFormat => ErrorCode::UnsupportedFormat,
            EngineError::AnimatedNotSupported => ErrorCode::AnimatedNotSupported,
            EngineError::MultiPageNotSupported => ErrorCode::MultiPageNotSupported,
            EngineError::Decode(_) => ErrorCode::DecodeFailed,
            EngineError::Encode(_) => ErrorCode::EncodeFailed,
            EngineError::TooLarge(_) => ErrorCode::TooLarge,
            EngineError::InvalidDimensions(_) => ErrorCode::InvalidDimensions,
            EngineError::InvalidCrop(_) => ErrorCode::InvalidCrop,
            EngineError::InvalidOptions(_) => ErrorCode::InvalidOptions,
        }
    }

    pub(crate) fn from_decode(err: image::ImageError) -> Self {
        match err {
            image::ImageError::Limits(e) => {
                EngineError::TooLarge(format!("The image exceeds the processing limits ({e})."))
            }
            image::ImageError::Unsupported(e) => {
                EngineError::Decode(format!("unsupported image feature ({e})"))
            }
            other => EngineError::Decode(other.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, EngineError>;
