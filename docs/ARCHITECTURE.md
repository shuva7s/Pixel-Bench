# Architecture and technical decisions

Pixel Bench is a [Tauri 2](https://tauri.app) desktop app for Windows, macOS and Linux. A native Rust backend does all image and AI work. A React/TypeScript interface (Next.js static export, shadcn/ui) runs in the system web view: WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux.

## Layers

| Layer        | Location                 | Responsibility                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image engine | `crates/image-core`      | Format detection, header inspection, decoding with limits, EXIF orientation, operations (develop, crop, straighten, resize, pad…), encoders, metadata inspection and lossless removal, structured errors. With the `parallel` feature, hot loops run on all cores (`par.rs`); results are identical to the single-threaded build. |
| Backend      | `crates/app-core`        | Open images and cached preview proxies, every output format (adds libwebp for lossy WebP and rav1e for AVIF), target file size search, text/logo watermarks (ab_glyph + tiny-skia, Geist fonts bundled), one-shot jobs, AVIF/HEIC detection. No UI dependency; tested with `cargo test`.                                          |
| AI           | `crates/ai`              | ONNX Runtime via `ort`: GPU provider (DirectML on Windows, Core ML on macOS) with CPU fallback, both at load and at run time. Background removal (U²-Netp, BiRefNet-lite), compositing onto backdrops, tiled Real-ESRGAN upscaling, pinned/verified model downloads.                                                              |
| AVIF encoder | `crates/avif-encoder`    | rav1e via ravif, multi-threaded (`native`), with rav1e's assembly (`asm`, needs nasm).                                                                                                                                                                                                                                            |
| Shell        | `apps/desktop/src-tauri` | One Tauri command, `call`, that dispatches `{module, method}` to the crates above on a blocking thread pool. It also emits progress events and writes files chosen in native dialogs.                                                                                                                                             |
| Interface    | `apps/desktop/src`       | The three workspaces (editor, utilities, remove background). `lib/native/bridge.ts` replaces the web version's Web Worker RPC with the same `client.call(method, params)` interface, so components barely changed.                                                                                                                |

## IPC

All requests go through one command:

- **Request:** the body is a single raw binary field (file bytes or RGBA pixels); the `x-call` header holds `{module, method, id, binary, args}` as URL-encoded JSON.
- **Reply:** `[u32 LE json length][json][binary]`. The JSON names the binary field (`bytes` for encoded files, `pixels` for previews), which arrives as an `ArrayBuffer`. Nothing goes through base64.
- **Errors:** they keep the UI's error codes (`DECODE_FAILED`, `TOO_LARGE`, `MODEL_INVALID`…).
- **Progress:** model downloads and upscaling report through `native-progress` events, matched by request id.
- **AVIF/HEIC:** no pure-Rust decoders exist, so the backend answers `NEEDS_UI_DECODER`. The client then decodes in the web view (system decoder, or libheif for HEIC) and resends pixels (`openRgba`, `processRgba`, `upscaleRgba`).

## Pipeline

`decode → [flip | rotate | straighten | crop | resize | develop | pad]* → [watermarks] → encode`

- **Editor ops order:** the editor emits flip → rotate → straighten → crop → develop → pad, so crop coordinates refer to the rotated and straightened frame.
- **Previews:** they render on cached downscaled proxies (800 px drafts while a slider moves, 1400 px when idle) and return raw RGBA. `apply_all_scaled` adapts crop rectangles and pixel radii to the proxy.
- **Exports:** they always render at full resolution and are saved with a native Save dialog. Batches can be saved into a folder; existing files are never overwritten.
- **Target file size:** a bounded search (at most 16 encodes) over quality, then over scale, with a learned size ∝ scale^k model. It reports honestly when a target can't be met.

## Performance (6000 × 4000, release, i7-12650H, best of 3)

| Operation                       | WebAssembly (old web app) | Native, 1 thread | Native, `parallel` |
| ------------------------------- | ------------------------: | ---------------: | -----------------: |
| Develop: light + colour         |                    366 ms |           232 ms |              78 ms |
| Develop: + colour mixer         |                   1385 ms |          1031 ms |             185 ms |
| Develop: + clarity + sharpening |                   1526 ms |          1064 ms |             258 ms |
| Develop: + vignette + grain     |                   1056 ms |           566 ms |             153 ms |
| Straighten 3°                   |                   1040 ms |           946 ms |             193 ms |
| Resize to 50% (Lanczos3)        |                    107 ms |            95 ms |              96 ms |
| Encode JPEG q85                 |                    359 ms |           232 ms |             255 ms |

The workloads in the two measurements differ slightly (the web numbers come from the earlier benchmark script). Run the native table with `cargo test --release -p image-core --features parallel --test speed -- --ignored --nocapture`.

AI on the CPU (native ONNX Runtime): U²-Netp 0.25 s per photo, BiRefNet-lite 9.7 s. BiRefNet could not run on the CPU in the web version at all: it exceeded WebAssembly's 4 GB memory limit.

## Limits and safety

- Input ≤ 100 MB, ≤ 20,000 px per side, ≤ 50 MP; dimensions are checked from the header before pixels are allocated. AI upscaling output is also capped at 50 MP.
- Malformed input is rejected with error codes, never panics. Animated GIF/PNG/WebP and multi-page TIFF are rejected explicitly.
- Models are pinned by size and SHA-256 and verified every time they are loaded. A failed download is deleted. BiRefNet is fetched from a commit-pinned Hugging Face URL, only after consent.
- The interface runs with a restrictive CSP. It can only open native dialogs, open external links in the browser, and reveal saved files (see `src-tauri/capabilities/default.json`).

## Codec choices

| Format | Decode                               | Encode                                                         |
| ------ | ------------------------------------ | -------------------------------------------------------------- |
| JPEG   | `zune-jpeg` (via `image`)            | `jpeg-encoder` (standard Huffman tables, optional progressive) |
| PNG    | `png`                                | `png` (fast / default / best, colour type reduced losslessly)  |
| WebP   | `image-webp`                         | lossy: libwebp (`webp` crate); lossless: `image-webp`          |
| AVIF   | web view (system decoder)            | rav1e via ravif (multi-threaded)                               |
| HEIC   | web view, else libheif (WebAssembly) | — (written as JPEG for "same as original")                     |
| GIF    | `gif`                                | `gif` (speed 10)                                               |
| TIFF   | `tiff`                               | `tiff` (LZW + predictor)                                       |
| ICO    | `image`                              | `image` (square, 16–256 px PNG entries)                        |
| BMP    | `image`                              | `image` (24-bit, alpha flattened)                              |

## Builds

- **Linux and macOS** build natively.
- **Windows** builds in CI. On PCs with Smart App Control, develop in WSL2 (the app opens via WSLg) and take the Windows and macOS installers from CI: `ci.yml` builds them for pull requests into `main`, and `release.yml` publishes a GitHub Release on every merge into `main`.
- **ONNX Runtime** is linked statically from `ort`'s prebuilt binaries. On Windows, `DirectML.dll` is shipped next to the executable: CI copies it from `target/release` into `src-tauri/dlls/` (git-ignored) before building, and `tauri.windows.conf.json` bundles it from there.
