//! Tauri shell: one `call` command that dispatches to the native backend
//! (`app-core` for images, `ai` for the AI tools) on a blocking thread, so
//! the UI stays responsive and independent requests run in parallel.
//!
//! Wire format (see `src/lib/native/bridge.ts`): the request body is one raw
//! binary field (file bytes or RGBA pixels); the `x-call` header holds
//! `{module, method, id, binary, args}` as URL-encoded JSON. The reply is
//! `[u32 LE json length][json][binary]`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use ai::removebg::{BackdropSpec, Cutout};
use ai::{Device, ModelDirs, ModelId, Runtime};
use app_core::engine::{FileInfo, inspect, safe_metadata};
use app_core::overlay::Overlay;
use app_core::settings::{OutputSettings, StripSpec, TargetSpec};
use app_core::{AppError, Engine, Job, Processed, Rendered};
use image_core::{Format, Operation, RgbaImage};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager};

struct State {
    engine: Engine,
    dirs: ModelDirs,
    runtime: Mutex<Option<Arc<Runtime>>>,
    cutouts: Mutex<HashMap<u32, Arc<Cutout>>>,
    backdrop: RwLock<Option<RgbaImage>>,
    cancel: AtomicBool,
}

impl State {
    fn runtime(&self) -> Result<Arc<Runtime>, AppError> {
        let mut rt = self.runtime.lock().unwrap();
        if rt.is_none() {
            *rt = Some(Arc::new(Runtime::new(self.dirs.clone()).map_err(ai_err)?));
        }
        Ok(rt.as_ref().unwrap().clone())
    }

    fn cutout(&self, handle: u32) -> Result<Arc<Cutout>, AppError> {
        self.cutouts
            .lock()
            .unwrap()
            .get(&handle)
            .cloned()
            .ok_or_else(|| AppError::new("INVALID_OPTIONS", "Remove the background first."))
    }
}

fn ai_err(e: ai::AiError) -> AppError {
    AppError::new(e.code, e.message)
}

#[derive(Deserialize)]
struct Header {
    module: String,
    method: String,
    id: u64,
    args: Value,
}

/// A reply: JSON plus an optional binary field (`binaryField` names it for the UI).
struct Reply {
    json: Value,
    binary: Option<(&'static str, Vec<u8>)>,
}

impl Reply {
    fn json(json: Value) -> Self {
        Reply { json, binary: None }
    }

    fn pack(mut self) -> Vec<u8> {
        if let (Some((field, _)), Value::Object(map)) = (&self.binary, &mut self.json) {
            map.insert("binaryField".into(), Value::from(*field));
        }
        let json = serde_json::to_vec(&self.json).expect("serialisable");
        let bin = self.binary.map(|(_, b)| b).unwrap_or_default();
        let mut out = Vec::with_capacity(4 + json.len() + bin.len());
        out.extend_from_slice(&(json.len() as u32).to_le_bytes());
        out.extend_from_slice(&json);
        out.extend_from_slice(&bin);
        out
    }
}

fn args<T: DeserializeOwned>(v: &Value) -> Result<T, AppError> {
    serde_json::from_value(v.clone())
        .map_err(|e| AppError::new("INVALID_OPTIONS", format!("Invalid request: {e}")))
}

fn format_json(format: Format, width: u32, height: u32) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    m.insert("format".into(), json!(format));
    m.insert("mimeType".into(), json!(format.mime_type()));
    m.insert("extension".into(), json!(format.extension()));
    m.insert("width".into(), json!(width));
    m.insert("height".into(), json!(height));
    m
}

fn rendered(r: Rendered) -> Reply {
    let mut m = format_json(r.encoded.format, r.encoded.width, r.encoded.height);
    if let Some(t) = r.target {
        m.insert("target".into(), json!(t));
    }
    Reply {
        json: Value::Object(m),
        binary: Some(("bytes", r.encoded.bytes)),
    }
}

fn processed(p: Processed) -> Reply {
    let mut reply = rendered(p.rendered);
    if let Value::Object(m) = &mut reply.json {
        m.insert("sourceInfo".into(), json!(p.source_info));
        m.insert("lossless".into(), json!(p.lossless));
    }
    reply
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderArgs {
    handle: u32,
    #[serde(default)]
    ops: Vec<Operation>,
    output: OutputSettings,
    #[serde(default)]
    overlays: Vec<Overlay>,
    target: Option<TargetSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessArgs {
    #[serde(default)]
    ops: Vec<Operation>,
    output: OutputSettings,
    #[serde(default)]
    overlays: Vec<Overlay>,
    target: Option<TargetSpec>,
    strip: Option<StripSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RgbaArgs {
    width: u32,
    height: u32,
    info: FileInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpscaleArgs {
    factor: u32,
    device: Device,
    output: OutputSettings,
    #[serde(default)]
    overlays: Vec<Overlay>,
    target: Option<TargetSpec>,
}

fn progress(app: &AppHandle, id: u64, label: &str, fraction: Option<f64>) {
    let _ = app.emit(
        "native-progress",
        json!({ "id": id, "label": label, "fraction": fraction }),
    );
}

/// Picks `name`, or `name (1)`, `name (2)`… so existing files are never overwritten.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("a free name")
}

fn dispatch(app: &AppHandle, st: &State, h: Header, body: Vec<u8>) -> Result<Reply, AppError> {
    let a = &h.args;
    let engine = &st.engine;
    match (h.module.as_str(), h.method.as_str()) {
        // ---- images
        ("engine" | "ai", "open") => Ok(Reply::json(json!(engine.open(&body)?))),
        ("engine" | "ai", "openRgba") => {
            let r: RgbaArgs = args(a)?;
            Ok(Reply::json(json!(
                engine.open_rgba(body, r.width, r.height, r.info)?
            )))
        }
        ("engine", "inspect") => Ok(Reply::json(
            json!({ "info": inspect(&body)?, "metadata": safe_metadata(&body) }),
        )),
        ("engine", "render") => {
            let r: RenderArgs = args(a)?;
            Ok(rendered(engine.render(
                r.handle,
                &r.ops,
                &r.output,
                &r.overlays,
                r.target,
            )?))
        }
        ("engine", "preview") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                handle: u32,
                #[serde(default)]
                ops: Vec<Operation>,
                max_side: u32,
                #[serde(default)]
                overlays: Vec<Overlay>,
            }
            let p: P = args(a)?;
            let f = engine.preview(p.handle, &p.ops, p.max_side, &p.overlays)?;
            Ok(Reply {
                json: json!({ "width": f.width, "height": f.height }),
                binary: Some(("pixels", f.pixels)),
            })
        }
        ("engine" | "ai", "setLogo") => {
            let id: String = args(&a["id"])?;
            let (width, height) = engine.set_logo(id, &body)?;
            Ok(Reply::json(json!({ "width": width, "height": height })))
        }
        ("engine" | "ai", "close") => {
            let handle: u32 = args(&a["handle"])?;
            engine.close(handle);
            st.cutouts.lock().unwrap().remove(&handle);
            Ok(Reply::json(json!({})))
        }
        ("engine", "process") => {
            let p: ProcessArgs = args(a)?;
            let job = Job {
                bytes: &body,
                pixels: None,
                ops: &p.ops,
                settings: &p.output,
                overlays: &p.overlays,
                target: p.target,
                strip: p.strip,
            };
            Ok(processed(engine.process(job)?))
        }
        ("engine", "processRgba") => {
            let p: ProcessArgs = args(a)?;
            let r: RgbaArgs = args(a)?;
            let job = Job {
                bytes: &[],
                pixels: Some((body, r.width, r.height, r.info)),
                ops: &p.ops,
                settings: &p.output,
                overlays: &p.overlays,
                target: p.target,
                strip: None,
            };
            Ok(processed(engine.process(job)?))
        }
        ("engine", "cancel") => Ok(Reply::json(json!({}))),

        // ---- AI
        ("ai", "capabilities") => {
            let cached: Vec<ModelId> = [
                ModelId::U2Netp,
                ModelId::BiRefNetLite,
                ModelId::RealEsrganX4v3,
            ]
            .into_iter()
            .filter(|&m| st.dirs.is_present(m))
            .collect();
            Ok(Reply::json(
                json!({ "gpu": ai::gpu_api(), "cached": cached }),
            ))
        }
        ("ai", "prepare") => {
            let model: ModelId = args(&a["model"])?;
            let name = ai::models::spec(model).name;
            st.dirs
                .download(model, |f| {
                    progress(app, h.id, &format!("Downloading {name}"), Some(f))
                })
                .map_err(ai_err)?;
            Ok(Reply::json(json!({})))
        }
        ("ai", "segment") => {
            #[derive(Deserialize)]
            struct S {
                handle: u32,
                model: ModelId,
                device: Device,
            }
            let s: S = args(a)?;
            if !st.dirs.is_present(s.model) {
                let name = ai::models::spec(s.model).name;
                st.dirs
                    .download(s.model, |f| {
                        progress(app, h.id, &format!("Downloading {name}"), Some(f))
                    })
                    .map_err(ai_err)?;
            }
            progress(app, h.id, "Finding the subject", None);
            let image = engine.pixels(s.handle)?;
            let seg = st
                .runtime()?
                .segment(&image, s.model, s.device)
                .map_err(ai_err)?;
            let cutout = Cutout::new(seg.mask, seg.size);
            // Fewer than 0.1% of pixels kept: no subject found.
            let empty = cutout.kept_fraction() < 0.001;
            st.cutouts
                .lock()
                .unwrap()
                .insert(s.handle, Arc::new(cutout));
            Ok(Reply::json(
                json!({ "backend": seg.backend, "ms": seg.millis, "empty": empty }),
            ))
        }
        ("ai", "preview") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                handle: u32,
                max_side: u32,
                edges: ai::mask::EdgeSettings,
                backdrop: BackdropSpec,
                #[serde(default)]
                mask: bool,
            }
            let p: P = args(a)?;
            let image = engine.pixels(p.handle)?;
            let backdrop = st.backdrop.read().unwrap();
            let img = st
                .cutout(p.handle)?
                .render(
                    &image,
                    Some(p.max_side),
                    p.edges,
                    &p.backdrop,
                    backdrop.as_ref(),
                    p.mask,
                )
                .map_err(ai_err)?;
            let (width, height) = img.dimensions();
            Ok(Reply {
                json: json!({ "width": width, "height": height }),
                binary: Some(("pixels", img.into_raw())),
            })
        }
        ("ai", "render") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct R {
                handle: u32,
                edges: ai::mask::EdgeSettings,
                backdrop: BackdropSpec,
                output: OutputSettings,
                target: Option<TargetSpec>,
            }
            let r: R = args(a)?;
            let (source, _, _) = engine.source(r.handle)?;
            let image = engine.pixels(r.handle)?;
            let composed = {
                let backdrop = st.backdrop.read().unwrap();
                st.cutout(r.handle)?
                    .render(&image, None, r.edges, &r.backdrop, backdrop.as_ref(), false)
                    .map_err(ai_err)?
            };
            Ok(rendered(app_core::engine::render_output(
                &composed,
                source,
                &[],
                &r.output,
                &[],
                &HashMap::new(),
                r.target,
            )?))
        }
        ("ai", "setBackdrop") => {
            let (img, _) = app_core::engine::decode(&body)?;
            let dims = img.dimensions();
            *st.backdrop.write().unwrap() = Some(img);
            Ok(Reply::json(json!({ "width": dims.0, "height": dims.1 })))
        }
        ("ai", "upscale" | "upscaleRgba") => {
            let u: UpscaleArgs = args(a)?;
            let (image, info) = if h.method == "upscaleRgba" {
                let r: RgbaArgs = args(a)?;
                (
                    app_core::engine::from_rgba(body, r.width, r.height)?,
                    r.info,
                )
            } else {
                app_core::engine::decode(&body)?
            };
            st.cancel.store(false, Ordering::Relaxed);
            let rt = st.runtime()?;
            let (up, backend) = rt
                .upscale(
                    &image,
                    u.factor,
                    u.device,
                    |f| progress(app, h.id, "Upscaling", Some(f)),
                    &st.cancel,
                )
                .map_err(ai_err)?;
            progress(app, h.id, "Encoding", None);
            let r = engine.process(Job {
                bytes: &[],
                pixels: Some((
                    up.into_raw(),
                    info.width * u.factor,
                    info.height * u.factor,
                    info.clone(),
                )),
                ops: &[],
                settings: &u.output,
                overlays: &u.overlays,
                target: u.target,
                strip: None,
            })?;
            let mut reply = processed(Processed {
                source_info: info,
                ..r
            });
            if let Value::Object(m) = &mut reply.json {
                m.insert("backend".into(), json!(backend));
            }
            Ok(reply)
        }
        ("ai", "cancel") => {
            st.cancel.store(true, Ordering::Relaxed);
            Ok(Reply::json(json!({})))
        }

        // ---- files
        // Automated UI tests set PIXEL_BENCH_TEST_SAVE_DIR: saving then skips the
        // native dialogs (which WebDriver cannot drive) and writes there.
        ("fs", "testSaveDir") => Ok(Reply::json(
            json!({ "dir": std::env::var_os("PIXEL_BENCH_TEST_SAVE_DIR").map(PathBuf::from) }),
        )),
        ("fs", "write") => {
            let path: PathBuf = args(&a["path"])?;
            std::fs::write(&path, &body)?;
            Ok(Reply::json(json!({ "path": path })))
        }
        ("fs", "writeUnique") => {
            let dir: PathBuf = args(&a["dir"])?;
            let name: String = args(&a["name"])?;
            // Only a plain file name: never write outside the chosen folder.
            let name = Path::new(&name)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image")
                .to_string();
            let path = unique_path(&dir, &name);
            std::fs::write(&path, &body)?;
            Ok(Reply::json(json!({ "path": path })))
        }
        (m, f) => Err(AppError::new(
            "INVALID_OPTIONS",
            format!("Unknown request {m}.{f}"),
        )),
    }
}

#[tauri::command]
async fn call(app: AppHandle, request: Request<'_>) -> Result<Response, AppError> {
    let header = request
        .headers()
        .get("x-call")
        .and_then(|v| v.to_str().ok())
        .and_then(percent_decode)
        .and_then(|v| serde_json::from_str::<Header>(&v).ok())
        .ok_or_else(|| AppError::new("INVALID_OPTIONS", "Missing request header."))?;
    let body = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => Vec::new(),
    };
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = handle.state::<State>();
        dispatch(&handle, &st, header, body).map(|r| Response::new(r.pack()))
    })
    .await
    .map_err(|e| {
        AppError::new(
            "ENGINE_CRASHED",
            format!("The engine stopped unexpectedly: {e}"),
        )
    })?
}

/// Decodes `encodeURIComponent` output.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Installed apps keep resources in the platform's resource folder; a
            // build run straight from `target/` has them next to the executable.
            let installed = app.path().resource_dir()?.join("models");
            let beside_exe = std::env::current_exe()?.parent().map(|d| d.join("models"));
            let bundled = match beside_exe {
                Some(dir) if !installed.is_dir() && dir.is_dir() => dir,
                _ => installed,
            };
            let downloads = app.path().app_data_dir()?.join("models");
            app.manage(State {
                engine: Engine::new(),
                dirs: ModelDirs { bundled, downloads },
                runtime: Mutex::new(None),
                cutouts: Mutex::default(),
                backdrop: RwLock::new(None),
                cancel: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![call])
        .run(tauri::generate_context!())
        .expect("error while running Pixel Bench");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_uri_components() {
        assert_eq!(
            percent_decode("%7B%22a%22%3A%22%C3%A9%20x%22%7D").unwrap(),
            r#"{"a":"é x"}"#
        );
        assert_eq!(percent_decode("%zz"), None);
    }

    #[test]
    fn packs_json_and_binary() {
        let packed = Reply {
            json: json!({ "width": 2 }),
            binary: Some(("pixels", vec![1, 2, 3])),
        }
        .pack();
        let len = u32::from_le_bytes(packed[..4].try_into().unwrap()) as usize;
        let v: Value = serde_json::from_slice(&packed[4..4 + len]).unwrap();
        assert_eq!(v["binaryField"], "pixels");
        assert_eq!(&packed[4 + len..], &[1, 2, 3]);
    }

    #[test]
    fn never_overwrites_files() {
        let dir = std::env::temp_dir().join(format!("pb-unique-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.png"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.png"), dir.join("a (1).png"));
        assert_eq!(unique_path(&dir, "b.png"), dir.join("b.png"));
        std::fs::remove_dir_all(dir).ok();
    }
}
