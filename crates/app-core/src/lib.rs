//! Native backend for the desktop app. Everything here is plain Rust with no
//! UI dependency, so it is tested with `cargo test`; the Tauri shell only
//! translates commands into these calls.

pub mod encode;
pub mod engine;
pub mod error;
pub mod overlay;
pub mod settings;
pub mod target;

pub use engine::{Engine, FileInfo, Frame, Job, OpenResult, Processed, Rendered};
pub use error::{AppError, Result};
