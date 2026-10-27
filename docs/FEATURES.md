# Feature status

Last verified: 2026-10-26.

Pixel Bench is now a **desktop app** (Tauri 2, Windows / macOS / Linux) with a native Rust backend. It was converted from the browser version on 2026-10-26; the browser version is in git history (commit `e45252a`). There are three tools: the **Photo editor**, **Utilities**, and **Remove background**.

## Desktop conversion status

| Area                                                                                                                                                                 | Status     | Evidence                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image engine (all operations, formats, metadata), multi-threaded                                                                                                     | ✅         | Rust tests pass single- and multi-threaded with identical results; a box-blur reference test covers the band-parallel path                                                                                                                                                                                                                                |
| Backend: sessions, previews, every output format incl. lossy WebP (libwebp) and AVIF (rav1e), target size, watermarks, lossless metadata removal, AVIF/HEIC hand-off | ✅         | `cargo test -p app-core` (24 tests)                                                                                                                                                                                                                                                                                                                       |
| AI: U²-Netp and BiRefNet-lite cut-outs, Real-ESRGAN 2×/4×, model pinning and tamper rejection                                                                        | ✅ (CPU)   | `cargo test -p ai --release` runs the **real models**: both cut-outs keep the subject and remove the background; upscaling stays within 2.4 levels of a Lanczos reference; BiRefNet runs on the CPU in 9.7 s                                                                                                                                              |
| GPU acceleration (DirectML / Core ML)                                                                                                                                | 🟡         | Implemented with automatic CPU fallback; not yet run on a Windows or Mac machine                                                                                                                                                                                                                                                                          |
| Tauri shell (IPC, dialogs, saving, progress)                                                                                                                         | ✅         | Built and run on Linux (WSL); exercised by the end-to-end suite; wire format and safe file names unit-tested                                                                                                                                                                                                                                              |
| Interface                                                                                                                                                            | ✅         | Type-checks, lints, 26 unit tests; runs in the app window (WebKitGTK) under the end-to-end suite                                                                                                                                                                                                                                                          |
| End-to-end tests                                                                                                                                                     | ✅ (Linux) | `pnpm --filter desktop test:e2e`: 8 WebDriver tests (`tauri-driver`) against the real app: navigation, native backend, edit + export, batch with HEIC to a target size, AVIF/WebP, AI upscale, background removal with transparent and colour exports, consent before downloads. Native Save dialogs are bypassed in tests by `PIXEL_BENCH_TEST_SAVE_DIR` |
| Installers (Windows, macOS, Linux)                                                                                                                                   | 🟡         | CI workflow written (`.github/workflows/desktop.yml`), not yet run. Builds are unsigned                                                                                                                                                                                                                                                                   |

The tables below describe features. "E" marks from the browser era refer to the old browser tests. The desktop end-to-end suite above covers the main flow of each tool; finer UI details (for example crop dragging and undo) are not yet re-covered.

## Photo editor

| Feature                                                                          | Status  | Tests   | Notes                                                                                |
| -------------------------------------------------------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------ |
| Open photo (picker, drag-and-drop, paste), validation                            | ✅ / 🟡 | U, E    | Picker E2E-tested; drag-and-drop and paste share the code path but are not automated |
| Live engine preview, draft while dragging then refined                           | ✅      | W, E    | 800 px draft, 1400 px after 250 ms idle; export is always full resolution            |
| Exposure, Contrast, Highlights, Shadows, Whites, Blacks; Auto                    | ✅      | R, W, E | Tone curve in gamma space; Auto analyses the unedited image                          |
| Temperature, Tint, Vibrance, Saturation, Black & white                           | ✅      | R, W, E | White balance in linear light                                                        |
| Colour mixer: hue / saturation / luminance × 8 bands                             | ✅      | R, W, E |                                                                                      |
| Clarity, Blur, Sharpening, Vignette, Grain                                       | ✅      | R, E    | Blur radius scales with the image (sigma up to 2% of the long side)                  |
| Crop: drag box, aspect presets, custom ratio                                     | ✅ / 🟡 | U, E    | Pointer dragging is unit-tested at the geometry level only                           |
| Straighten ±45°, rotate 90°, flip                                                | ✅      | R, W, E |                                                                                      |
| Border and padding to a shape (1:1, 4:5, 3:2, 16:9, 9:16), colour or transparent | ✅      | R, U, E | Border is a % of the short side; padding is applied after the crop                   |
| Text and logo watermarks                                                         | ✅      | U, E    | 9 anchors, size, opacity, font, shadow; logos keep transparency; drawn in the worker |
| Presets, histogram, undo/redo, before/after, per-section reset                   | ✅ / 🟡 | U, E    | Section reset and double-click reset are not automated                               |
| Info & metadata panel (camera, dates, GPS, software)                             | ✅      | R, W, E |                                                                                      |
| Export (all output formats, quality, background)                                 | ✅      | E       | Download validated (magic bytes, dimensions)                                         |

## Utilities

| Feature                                                                                                | Status  | Tests      | Notes                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One or many files (up to 200), per-file status, details before processing                              | ✅      | W, E       | Format is read from the bytes, not the name                                                                                                                                                                                           |
| Output: JPEG, PNG, WebP (lossy or lossless), AVIF, GIF, TIFF, ICO, BMP                                 | ✅      | R, W, E    | See codec table in ARCHITECTURE.md                                                                                                                                                                                                    |
| Input: all of the above plus HEIC/HEIF                                                                 | ✅      | R, W, E    | AVIF/HEIC decoded by the system web view; HEIC falls back to libheif                                                                                                                                                                  |
| Compression controls; real before/after sizes                                                          | ✅      | R, W, E    | "Larger" is shown as larger                                                                                                                                                                                                           |
| Target file size: at most / at least, optional resizing (in "Format & file size", right below Quality) | ✅      | U, E       | Binary search on quality (≤ 16 encodes), then on scale; the quality slider is hidden while a target is set; reports when a target can't be met; never pads                                                                            |
| Resize: fit within box, percentage                                                                     | ✅      | R, W, U, E |                                                                                                                                                                                                                                       |
| AI upscale 2× / 4×                                                                                     | ✅      | U, E       | See AI section                                                                                                                                                                                                                        |
| Metadata inspection (EXIF, GPS, XMP, ICC, comments)                                                    | ✅      | R, W, E    | GPS pin shown in the list                                                                                                                                                                                                             |
| Lossless metadata removal (JPEG, PNG, WebP), keep orientation / ICC                                    | ✅      | R, W, E    | Pixels are copied unchanged; every output is re-parsed and verified clean                                                                                                                                                             |
| Watermark (text / logo) for every file                                                                 | ✅      | E          |                                                                                                                                                                                                                                       |
| Bounded parallel processing, failures isolated per file                                                | ✅      | U, E       | min(4, cores/2) workers, terminated after each run                                                                                                                                                                                    |
| Finish current / Cancel now                                                                            | ✅ / 🟡 | U          | Both stop new files at once. Native jobs cannot be interrupted mid-file: files already in progress finish, but after "Cancel now" their results are discarded. AI upscaling stops between tiles. Not covered by the desktop E2E suite |
| Individual downloads and ZIP                                                                           | ✅      | E          |                                                                                                                                                                                                                                       |

## Remove background

| Feature                                                          | Status  | Tests | Notes                                                                                                                            |
| ---------------------------------------------------------------- | ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| Fast model (U²-Netp, included with the app)                      | ✅      | R     | Real-model test: subject kept, background removed; 0.25 s on the CPU                                                             |
| High-quality model (BiRefNet-lite), downloaded with consent      | ✅ / 🟡 | R     | Real-model test on the CPU (9.7 s); pinned URL and tamper rejection tested. The consent flow is not yet tested in the app window |
| GPU (DirectML / Core ML) with CPU fallback                       | 🟡      | —     | A GPU failure at load or run time falls back to the CPU; not yet run on Windows/macOS                                            |
| Empty-mask warning                                               | 🟡      | —     | Shown when the mask keeps < 0.1% of pixels                                                                                       |
| Backgrounds: transparent, colour, blurred photo, image           | ✅      | R     | Compositor and cover-fit tested natively                                                                                         |
| Edge hardness, shift, feather; mask view                         | ✅      | R     | Settings re-composite without re-running the model                                                                               |
| Export via the normal output settings (PNG default), Save dialog | 🟡      | —     | Encoding tested natively; the Save dialog flow is not yet tested in the app                                                      |

## AI models

| Model                            | Used by                          | Size   | Licence      | Source / hosting                                                                                                                                      |
| -------------------------------- | -------------------------------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| U²-Netp                          | Remove background — Fast         | 4.6 MB | Apache-2.0   | xuebinqin/U-2-Net; ONNX from `BritishWerewolf/U-2-Netp` @ `7112208d`. Bundled with the app                                                            |
| BiRefNet-lite (fp16)             | Remove background — High quality | 110 MB | MIT          | ZhengPeng7/BiRefNet; WebGPU-friendly export `jiabins0303/birefnet-lite-1024-webgpu` @ `1ad01cef`. Fetched from Hugging Face at runtime, after consent |
| Real-ESRGAN realesr-general-x4v3 | Utilities — AI upscale           | 4.9 MB | BSD-3-Clause | Converted to ONNX by us from the official weights (`scripts/convert_esrgan.py`; max difference to PyTorch 1.9 × 10⁻⁵). Bundled with the app           |

- Every model is pinned by byte size and SHA-256 (`crates/ai/src/models.rs`, `models/SHA256SUMS`). The app verifies the hash every time it loads a model. A download that fails the check is deleted.
- U²-Netp and Real-ESRGAN ship inside the app. BiRefNet is downloaded once into the app's data folder and works offline afterwards.
- Offline validation against known masks: U²-Netp IoU 0.996, BiRefNet-lite IoU 1.0 on a synthetic scene (`onnxruntime` native).
- The weights' licences are listed above. The models were trained on public datasets (e.g. DUTS, DIS5K, DIV2K) that carry their own terms. We don't redistribute those datasets.
- Rejected candidates: RMBG-1.4/2.0 (non-commercial licence), ISNet general-use (licence unclear), APISR (GPL).

### AI performance and limits

- Runtime: native ONNX Runtime 1.31 through `ort` 2.0 (prebuilt, statically linked). It tries the GPU provider on Windows (DirectML) and macOS (Core ML) and falls back to the CPU, both when the provider cannot be registered and when a run fails. Linux uses the CPU.
- Measured on the CPU (i7-12650H, in WSL): U²-Netp 0.25 s; BiRefNet-lite 9.7 s at its fixed 1024 × 1024 input. The browser version could not run BiRefNet on the CPU at all: it exceeded WebAssembly's 4 GB memory limit.
- Upscaling works in 256 px tiles with 16 px of overlapping context, so memory stays bounded and there are no seams. 2× averages 2×2 blocks of the 4× result. Output is limited to 50 MP, and it can be cancelled between tiles.
- Browser-era findings that still matter if the web view is ever used for AI again: ONNX Runtime Web's default JSEP WebGPU build failed on U²-Net and returned garbage for BiRefNet on an Intel Iris Xe. The native app does not use it.

## Shared safeguards

| Feature                                                                          | Status  | Tests                                                      |
| -------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------- |
| Native Rust backend on a blocking thread pool (UI never blocks)                  | ✅ / 🟡 | R; not yet observed in the app                             |
| Limits checked from the header before allocation (100 MB, 20,000 px/side, 50 MP) | ✅      | R                                                          |
| Malformed/truncated input rejected without panics                                | ✅      | R                                                          |
| Animated GIF/PNG/WebP and multi-page TIFF rejected explicitly                    | ✅      | R                                                          |
| Works offline (the optional BiRefNet download aside)                             | ✅      | By construction: no network code except the model download |
| Saving never overwrites existing files in batch mode                             | ✅      | R (Tauri shell unit test)                                  |

## Known issues and limitations

- **JPEG output does not use optimised Huffman tables.** `zune-jpeg` 0.5.15 (inside `image` 0.25.10) mis-decodes legal JPEGs whose AC Huffman table has a single symbol, which optimised tables produce for near-uniform images. An ignored regression test (`cargo test -- --ignored`) tracks the upstream fix.
- **Lossless WebP isn't size-optimised** (`image-webp`): photos come out much bigger than PNG. Lossy WebP (native libwebp, BSD-3) is the default.
- **AVIF encoding is slow.** It uses rav1e (multi-threaded, with assembly). "Fast" is the default speed.
- **HEIC can't be written**, and HEVC patents may apply to decoding in some countries. libheif (LGPL-3.0) is shipped unmodified as a separate file.
- **Metadata can't be inspected for AVIF/HEIC.** Converted files never contain metadata. Lossless removal supports JPEG, PNG and WebP only.
- **Target size:** an exact byte count can't be guaranteed. Lossless formats can only reach a target by resizing. "At least" never pads files with junk.
- **Editor preview approximations:** previews render on a ≤ 1400 px copy, so fine sharpening and grain look different from the export.
- **Colour management:** pixels are treated as sRGB. **Bit depth:** 16-bit input is processed at 8 bits.
- **Memory:** an open image stays in memory (with its preview proxies) until it is closed; batch jobs free their images as soon as each file is done.
- **Next.js 16.4 static export quirk:** segment-prefetch files are written as nested folders but requested with flat names. `scripts/fix-export.mjs` writes the flat copies.

## Not implemented yet (⬜)

Tone curve editor, colour grading, noise reduction, dehaze, healing, masks · animated GIF/WebP and multi-page TIFF processing · ICC colour management.

## Benchmarks

See [ARCHITECTURE.md](ARCHITECTURE.md#performance-6000--4000-release-i7-12650h-best-of-3): the native, multi-threaded engine is 3–7× faster than the browser version on the heavy operations.
