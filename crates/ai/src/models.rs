//! The AI models the app can run. Every model is pinned by size and SHA-256,
//! and verified before it is used. See docs/FEATURES.md for sources and licences.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AiError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ModelId {
    #[serde(rename = "u2netp")]
    U2Netp,
    #[serde(rename = "birefnet-lite")]
    BiRefNetLite,
    #[serde(rename = "realesrgan-x4v3")]
    RealEsrganX4v3,
}

pub struct ModelSpec {
    pub id: ModelId,
    pub name: &'static str,
    pub file: &'static str,
    /// Downloaded on first use (after the user agrees) instead of shipping with the app.
    pub url: Option<&'static str>,
    pub bytes: u64,
    pub sha256: &'static str,
}

pub const MODELS: [ModelSpec; 3] = [
    ModelSpec {
        id: ModelId::U2Netp,
        name: "U²-Net (small)",
        file: "u2netp.onnx",
        url: None,
        bytes: 4_574_861,
        sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
    },
    ModelSpec {
        id: ModelId::BiRefNetLite,
        name: "BiRefNet-lite",
        file: "birefnet-lite-fp16.onnx",
        url: Some(
            "https://huggingface.co/jiabins0303/birefnet-lite-1024-webgpu/resolve/1ad01cef0f4101a285c5a3e0bd7f15597d93403f/onnx/model_fp16.onnx",
        ),
        bytes: 114_834_127,
        sha256: "4059896039dfccb0f15b9080ff06d11d90e499449bb045e797055eb8901cf5f4",
    },
    ModelSpec {
        id: ModelId::RealEsrganX4v3,
        name: "Real-ESRGAN general x4v3",
        file: "realesr-general-x4v3.onnx",
        url: None,
        bytes: 4_866_396,
        sha256: "f788518cc66e302bc9b6946016e989dd9374f1012d5b6c0c7e753904ef3f99e4",
    },
];

pub fn spec(id: ModelId) -> &'static ModelSpec {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .expect("every model is registered")
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Where models live: shipped ones in `bundled`, downloaded ones in `downloads`.
#[derive(Debug, Clone)]
pub struct ModelDirs {
    pub bundled: PathBuf,
    pub downloads: PathBuf,
}

impl ModelDirs {
    fn path(&self, m: &ModelSpec) -> PathBuf {
        if m.url.is_some() {
            self.downloads.join(m.file)
        } else {
            self.bundled.join(m.file)
        }
    }

    /// True when the model is on disk (downloaded models are checked by size only; bytes are verified on load).
    pub fn is_present(&self, id: ModelId) -> bool {
        let m = spec(id);
        fs::metadata(self.path(m)).is_ok_and(|md| md.len() == m.bytes)
    }

    /// Reads and verifies a model that is already on disk.
    pub fn load(&self, id: ModelId) -> Result<Vec<u8>> {
        let m = spec(id);
        let path = self.path(m);
        let bytes = fs::read(&path).map_err(|_| {
            if m.url.is_some() {
                AiError::new(
                    "MODEL_NOT_DOWNLOADED",
                    format!("{} has not been downloaded yet.", m.name),
                )
            } else {
                AiError::new(
                    "MODEL_LOAD_FAILED",
                    format!("{} is missing from the app ({}).", m.name, path.display()),
                )
            }
        })?;
        if bytes.len() as u64 != m.bytes || sha256_hex(&bytes) != m.sha256 {
            if m.url.is_some() {
                let _ = fs::remove_file(&path);
            }
            return Err(AiError::new(
                "MODEL_INVALID",
                format!("{} failed its integrity check, so it was not used.", m.name),
            ));
        }
        Ok(bytes)
    }

    /// Downloads a model (if needed), verifying size and SHA-256 before it is kept.
    /// `progress` receives a fraction from 0 to 1.
    pub fn download(&self, id: ModelId, mut progress: impl FnMut(f64)) -> Result<()> {
        let m = spec(id);
        let Some(url) = m.url else { return Ok(()) };
        if self.load(id).is_ok() {
            return Ok(());
        }
        fs::create_dir_all(&self.downloads)?;
        let failed = |what: String| {
            AiError::new(
                "MODEL_DOWNLOAD_FAILED",
                format!("Could not download {}: {what}", m.name),
            )
        };
        let response = ureq::get(url).call().map_err(|e| failed(e.to_string()))?;
        let mut reader = response.into_body().into_reader();
        let mut hasher = Sha256::new();
        let tmp = self.downloads.join(format!("{}.part", m.file));
        let mut out = fs::File::create(&tmp)?;
        let mut buf = vec![0u8; 1 << 16];
        let mut received = 0u64;
        loop {
            let n = reader.read(&mut buf).map_err(|e| failed(e.to_string()))?;
            if n == 0 {
                break;
            }
            received += n as u64;
            if received > m.bytes {
                drop(out);
                let _ = fs::remove_file(&tmp);
                return Err(AiError::new(
                    "MODEL_INVALID",
                    format!("{} is larger than expected, so it was not used.", m.name),
                ));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            progress(received as f64 / m.bytes as f64);
        }
        drop(out);
        let hash: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if received != m.bytes || hash != m.sha256 {
            let _ = fs::remove_file(&tmp);
            return Err(AiError::new(
                "MODEL_INVALID",
                format!(
                    "{} failed its integrity check (the download was incomplete or changed), so it was not used.",
                    m.name
                ),
            ));
        }
        fs::rename(&tmp, self.path(m))?;
        Ok(())
    }
}

/// Verifies arbitrary bytes against a model's pin (used by tests and tooling).
pub fn verify(id: ModelId, bytes: &[u8]) -> bool {
    let m = spec(id);
    bytes.len() as u64 == m.bytes && sha256_hex(bytes) == m.sha256
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_model_is_pinned() {
        for m in &MODELS {
            assert_eq!(m.sha256.len(), 64);
            assert!(m.bytes > 1_000_000);
        }
        assert!(
            spec(ModelId::BiRefNetLite)
                .url
                .unwrap()
                .contains("/resolve/1ad01cef0f4101a285c5a3e0bd7f15597d93403f/")
        );
    }

    #[test]
    fn rejects_tampered_and_missing_files() {
        let dir = std::env::temp_dir().join(format!("ai-models-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dirs = ModelDirs {
            bundled: dir.clone(),
            downloads: dir.clone(),
        };
        assert_eq!(
            dirs.load(ModelId::BiRefNetLite).unwrap_err().code,
            "MODEL_NOT_DOWNLOADED"
        );
        fs::write(dir.join("birefnet-lite-fp16.onnx"), vec![7u8; 1000]).unwrap();
        assert_eq!(
            dirs.load(ModelId::BiRefNetLite).unwrap_err().code,
            "MODEL_INVALID"
        );
        assert!(
            !dir.join("birefnet-lite-fp16.onnx").exists(),
            "a bad download is deleted"
        );
        assert!(!verify(ModelId::U2Netp, b"nope"));
        fs::remove_dir_all(dir).ok();
    }
}
