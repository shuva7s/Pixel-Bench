use crate::error::{EngineError, Result};

/// Hard safety limits checked before any large allocation.
///
/// The defaults keep a worst-case pipeline (decoded RGBA + one working copy +
/// encoder buffers) comfortably below the 4 GiB wasm32 address space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_input_bytes: usize,
    pub max_side: u32,
    pub max_pixels: u64,
}

pub const DEFAULT_LIMITS: Limits = Limits {
    max_input_bytes: 100 * 1024 * 1024,
    max_side: 20_000,
    max_pixels: 50_000_000,
};

impl Default for Limits {
    fn default() -> Self {
        DEFAULT_LIMITS
    }
}

impl Limits {
    pub fn check_input_len(&self, len: usize) -> Result<()> {
        if len == 0 {
            return Err(EngineError::EmptyInput);
        }
        if len > self.max_input_bytes {
            return Err(EngineError::TooLarge(format!(
                "The file is {} MB; the maximum is {} MB.",
                len / (1024 * 1024),
                self.max_input_bytes / (1024 * 1024)
            )));
        }
        Ok(())
    }

    /// Validates that a `width x height` RGBA image may be allocated.
    pub fn check_dimensions(&self, width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 {
            return Err(EngineError::InvalidDimensions(format!(
                "{width}x{height} has a zero-sized side"
            )));
        }
        if width > self.max_side || height > self.max_side {
            return Err(EngineError::TooLarge(format!(
                "{width}x{height} exceeds the maximum side length of {} px.",
                self.max_side
            )));
        }
        let pixels = u64::from(width) * u64::from(height);
        if pixels > self.max_pixels {
            return Err(EngineError::TooLarge(format!(
                "{width}x{height} ({:.1} MP) exceeds the maximum of {:.0} MP.",
                pixels as f64 / 1e6,
                self.max_pixels as f64 / 1e6
            )));
        }
        Ok(())
    }

    /// Maximum bytes the decoder may allocate. Allows the decoded image in its
    /// widest native layout (16-bit RGBA) plus some codec scratch space.
    pub(crate) fn decoder_max_alloc(&self) -> u64 {
        self.max_pixels * 8 + 64 * 1024 * 1024
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_zero_and_oversized() {
        let l = DEFAULT_LIMITS;
        assert!(l.check_dimensions(0, 10).is_err());
        assert!(l.check_dimensions(10, 0).is_err());
        assert!(l.check_dimensions(20_001, 1).is_err());
        assert!(l.check_dimensions(10_000, 10_000).is_err());
        assert!(l.check_dimensions(8_000, 6_000).is_ok());
        assert!(l.check_dimensions(u32::MAX, u32::MAX).is_err());
    }

    #[test]
    fn rejects_empty_and_huge_input() {
        let l = DEFAULT_LIMITS;
        assert!(matches!(l.check_input_len(0), Err(EngineError::EmptyInput)));
        assert!(matches!(
            l.check_input_len(l.max_input_bytes + 1),
            Err(EngineError::TooLarge(_))
        ));
        assert!(l.check_input_len(1024).is_ok());
    }
}
