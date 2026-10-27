//! Settings sent by the UI as JSON. Field names and values match the
//! TypeScript types in `apps/desktop/src/lib` (camelCase).

use image_core::{Format, PngCompression};
use serde::{Deserialize, Serialize};

/// Formats a file can be opened from. HEIC can be read but not written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceFormat {
    Jpeg,
    Png,
    Webp,
    Bmp,
    Gif,
    Tiff,
    Ico,
    Avif,
    Heic,
}

impl From<Format> for SourceFormat {
    fn from(f: Format) -> Self {
        match f {
            Format::Jpeg => SourceFormat::Jpeg,
            Format::Png => SourceFormat::Png,
            Format::Webp => SourceFormat::Webp,
            Format::Bmp => SourceFormat::Bmp,
            Format::Gif => SourceFormat::Gif,
            Format::Tiff => SourceFormat::Tiff,
            Format::Ico => SourceFormat::Ico,
            Format::Avif => SourceFormat::Avif,
        }
    }
}

impl SourceFormat {
    /// The format written for "same as original" (HEIC cannot be written, so it becomes JPEG).
    pub fn writable(self) -> Format {
        match self {
            SourceFormat::Jpeg | SourceFormat::Heic => Format::Jpeg,
            SourceFormat::Png => Format::Png,
            SourceFormat::Webp => Format::Webp,
            SourceFormat::Bmp => Format::Bmp,
            SourceFormat::Gif => Format::Gif,
            SourceFormat::Tiff => Format::Tiff,
            SourceFormat::Ico => Format::Ico,
            SourceFormat::Avif => Format::Avif,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Same,
    Jpeg,
    Png,
    Webp,
    Bmp,
    Gif,
    Tiff,
    Ico,
    Avif,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AvifSpeed {
    Fast,
    Balanced,
    Small,
}

impl AvifSpeed {
    /// rav1e speed (1 = slowest/smallest, 10 = fastest).
    pub fn rav1e(self) -> u8 {
        match self {
            AvifSpeed::Fast => 10,
            AvifSpeed::Balanced => 8,
            AvifSpeed::Small => 6,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    pub format: OutputFormat,
    /// 1–100 for JPEG, lossy WebP and AVIF.
    pub quality: u8,
    pub progressive: bool,
    pub png_compression: PngCompression,
    pub webp_lossless: bool,
    pub avif_speed: AvifSpeed,
    /// `#rrggbb`, used when transparency has to be flattened.
    pub background: String,
}

impl OutputSettings {
    /// The format that will actually be written.
    pub fn resolve(&self, source: SourceFormat) -> Format {
        match self.format {
            OutputFormat::Same => source.writable(),
            OutputFormat::Jpeg => Format::Jpeg,
            OutputFormat::Png => Format::Png,
            OutputFormat::Webp => Format::Webp,
            OutputFormat::Bmp => Format::Bmp,
            OutputFormat::Gif => Format::Gif,
            OutputFormat::Tiff => Format::Tiff,
            OutputFormat::Ico => Format::Ico,
            OutputFormat::Avif => Format::Avif,
        }
    }

    /// Whether the output has a quality setting.
    pub fn is_lossy(&self, source: SourceFormat) -> bool {
        match self.resolve(source) {
            Format::Jpeg | Format::Avif => true,
            Format::Webp => !self.webp_lossless,
            _ => false,
        }
    }

    pub fn background_rgb(&self) -> [u8; 3] {
        parse_hex(&self.background).unwrap_or([255, 255, 255])
    }
}

/// Parses `#rrggbb` (the `#` is optional).
pub fn parse_hex(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetMode {
    AtMost,
    AtLeast,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSpec {
    pub bytes: u64,
    pub mode: TargetMode,
    /// Allow changing dimensions when quality alone cannot reach the target.
    pub allow_resize: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StripSpec {
    pub keep_orientation: bool,
    pub keep_icc: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_settings_json_from_the_ui() {
        let s: OutputSettings = serde_json::from_str(
            r##"{"format":"same","quality":82,"progressive":false,"pngCompression":"default","webpLossless":false,"avifSpeed":"fast","background":"#ff8000"}"##,
        )
        .unwrap();
        assert_eq!(s.resolve(SourceFormat::Heic), Format::Jpeg);
        assert_eq!(s.resolve(SourceFormat::Webp), Format::Webp);
        assert!(s.is_lossy(SourceFormat::Webp));
        assert!(!s.is_lossy(SourceFormat::Png));
        assert_eq!(s.background_rgb(), [255, 128, 0]);
        let t: TargetSpec =
            serde_json::from_str(r#"{"bytes":204800,"mode":"atMost","allowResize":true}"#).unwrap();
        assert_eq!(t.mode, TargetMode::AtMost);
    }

    #[test]
    fn hex_colours() {
        assert_eq!(parse_hex("#000000"), Some([0, 0, 0]));
        assert_eq!(parse_hex("FFFFFF"), Some([255, 255, 255]));
        assert_eq!(parse_hex("#fff"), None);
        assert_eq!(parse_hex("#gg0000"), None);
    }
}
