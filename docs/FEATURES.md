# Feature status

Last verified: 2026-10-26.

The app has three tools: the **Photo editor** (Lightroom-style, one photo), **Utilities** (convert, compress, resize and clean one or many files) and **Remove background** (AI). The editor's colour and light controls go beyond the original Easy scope at the user's request.

Legend: ✅ implemented and tested · 🟡 implemented, incompletely tested · ⬜ not implemented

"Tested" means automated tests of real behaviour: native Rust tests (R), WASM-in-Node integration tests (W), web unit tests (U) and Playwright browser tests against the production build (E). "M" marks a manual check in a real browser.

## Photo editor (`/edit/`)

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

## Utilities (`/utilities/`)

| Feature                                                                                                | Status | Tests      | Notes                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One or many files (up to 200), per-file status, details before processing                              | ✅     | W, E       | Format is read from the bytes, not the name                                                                                                                |
| Output: JPEG, PNG, WebP (lossy or lossless), AVIF, GIF, TIFF, ICO, BMP                                 | ✅     | R, W, E    | See codec table in ARCHITECTURE.md                                                                                                                         |
| Input: all of the above plus HEIC/HEIF                                                                 | ✅     | R, W, E    | AVIF/HEIC decoded by the browser; HEIC falls back to libheif when the browser can't (E-tested fallback)                                                    |
| Compression controls; real before/after sizes                                                          | ✅     | R, W, E    | "Larger" is shown as larger                                                                                                                                |
| Target file size: at most / at least, optional resizing (in "Format & file size", right below Quality) | ✅     | U, E       | Binary search on quality (≤ 16 encodes), then on scale; the quality slider is hidden while a target is set; reports when a target can't be met; never pads |
| Resize: fit within box, percentage                                                                     | ✅     | R, W, U, E |                                                                                                                                                            |
| AI upscale 2× / 4×                                                                                     | ✅     | U, E       | See AI section                                                                                                                                             |
| Metadata inspection (EXIF, GPS, XMP, ICC, comments)                                                    | ✅     | R, W, E    | GPS pin shown in the list                                                                                                                                  |
| Lossless metadata removal (JPEG, PNG, WebP), keep orientation / ICC                                    | ✅     | R, W, E    | Pixels are copied unchanged; every output is re-parsed and verified clean                                                                                  |
| Watermark (text / logo) for every file                                                                 | ✅     | E          |                                                                                                                                                            |
| Bounded parallel processing, failures isolated per file                                                | ✅     | U, E       | min(4, cores/2) workers, terminated after each run                                                                                                         |
| Finish current / Cancel now                                                                            | ✅     | U, E       | Cancel terminates the workers immediately                                                                                                                  |
| Individual downloads and ZIP                                                                           | ✅     | E          |                                                                                                                                                            |

## Remove background (`/remove-bg/`)

| Feature                                                                  | Status  | Tests | Notes                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fast model (U²-Netp, self-hosted)                                        | ✅      | U, E  | E2E checks the subject is kept and the background removed on a synthetic photo; no external requests                                                                                |
| High-quality model (BiRefNet-lite), downloaded with consent, WebGPU only | ✅      | U, E  | Consent, pinned URL, download failure, checksum rejection and a real download + cut-out run on a real GPU (`webgpu` project). Without WebGPU it is unavailable, with an explanation |
| WebGPU with CPU fallback (Fast model, upscaling)                         | ✅      | E     | Both paths E2E-tested (`chromium` = CPU, `webgpu` = real GPU). A GPU failure at run time retries on the CPU                                                                         |
| Empty-mask warning                                                       | 🟡      | —     | Shown when the mask keeps < 0.1% of pixels; not automated                                                                                                                           |
| Backgrounds: transparent, colour, blurred photo, image                   | ✅ / 🟡 | U, E  | Transparent and colour E2E-tested; blur and image share the compositor (unit-tested)                                                                                                |
| Edge hardness, shift, feather; mask view                                 | ✅      | U, E  | Settings re-composite without re-running the model                                                                                                                                  |
| Export via the normal output settings (PNG default)                      | ✅      | E     |                                                                                                                                                                                     |

## AI models

| Model                            | Used by                          | Size   | Licence      | Source / hosting                                                                                                                                      |
| -------------------------------- | -------------------------------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| U²-Netp                          | Remove background — Fast         | 4.6 MB | Apache-2.0   | xuebinqin/U-2-Net; ONNX from `BritishWerewolf/U-2-Netp` @ `7112208d`. Self-hosted in `models/`                                                        |
| BiRefNet-lite (fp16)             | Remove background — High quality | 110 MB | MIT          | ZhengPeng7/BiRefNet; WebGPU-friendly export `jiabins0303/birefnet-lite-1024-webgpu` @ `1ad01cef`. Fetched from Hugging Face at runtime, after consent |
| Real-ESRGAN realesr-general-x4v3 | Utilities — AI upscale           | 4.9 MB | BSD-3-Clause | Converted to ONNX by us from the official weights (`scripts/convert_esrgan.py`; max difference to PyTorch 1.9 × 10⁻⁵). Self-hosted                    |

- Every model is pinned by byte size and SHA-256 (`apps/web/src/lib/ai/models.ts`, `models/SHA256SUMS`). The browser verifies the hash before using or caching a model.
- Verified models are kept in Cache Storage (`models-v1`), which app updates don't clear. They work offline afterwards.
- Offline validation against known masks: U²-Netp IoU 0.996, BiRefNet-lite IoU 1.0 on a synthetic scene (`onnxruntime` native).
- The weights' licences are listed above. The models were trained on public datasets (e.g. DUTS, DIS5K, DIV2K) that carry their own terms. We don't redistribute those datasets.
- Rejected candidates: RMBG-1.4/2.0 (non-commercial licence), ISNet general-use (licence unclear), APISR (GPL).

### AI performance and limits

- Runtime: ONNX Runtime Web 1.30, the `webgpu` build (native WebGPU execution provider, plus WebAssembly SIMD for the CPU). It is loaded from `/vendor/ort/` only when an AI tool runs (≈ 27 MB, cached). The default JSEP build was measured and rejected. On an Intel Iris Xe it can't run U²-Net (MaxPool `ceil_mode` is not implemented), and it silently returns garbage for BiRefNet: Concat kernels need more than the 8 storage buffers allowed per stage, so they fail validation. The native EP matches the CPU output for all three models.
- CPU threads need cross-origin isolation (COOP/COEP). `public/_headers` and `scripts/serve.mjs` send these headers. Without them, inference is single-threaded and noticeably slower.
- Upscaling works in 192 px tiles with 16 px of overlapping context, so memory stays bounded and there are no seams. 2× averages 2×2 blocks of the 4× result. The output is limited to 50 MP.
- **BiRefNet needs WebGPU.** Its export has a fixed 1024 × 1024 input, and on WebAssembly inference fails with `std::bad_alloc`: wasm32 memory is capped at 4 GB. This was reproduced in Chrome and in Node. Measured on an Intel Iris Xe (i7-12650H): download about 15 s, model preparation about 6 s, inference 13–20 s.
- U²-Netp: about 1.7 s on the CPU (single thread) or GPU at 320². Real-ESRGAN: about 0.4 s (CPU) / 0.7 s (GPU) per 64² tile in the lab test; upscaling a 40 × 30 image takes under a second.
- WebGPU is used only where available (desktop Chrome/Edge; other browsers vary). Playwright's bundled Chromium exposes no adapter here, so the GPU tests use installed Chrome (`E2E_WEBGPU=1`).

## Shared safeguards

| Feature                                                                          | Status | Tests   |
| -------------------------------------------------------------------------------- | ------ | ------- |
| Rust → WASM engine and the AI runtime in Web Workers (not in the main bundle)    | ✅     | W, E    |
| Limits checked from the header before allocation (100 MB, 20,000 px/side, 50 MP) | ✅     | R, W, E |
| Malformed/truncated input rejected without panics                                | ✅     | R, W, E |
| Animated GIF/PNG/WebP and multi-page TIFF rejected explicitly                    | ✅     | R, W    |
| Offline after the first visit (service worker)                                   | ✅     | E       |
| No external network requests (except the opt-in BiRefNet download)               | ✅     | E       |
| Phone-width layout (no horizontal overflow)                                      | ✅     | E       |

## Known issues and limitations

- **JPEG output does not use optimised Huffman tables.** `zune-jpeg` 0.5.15 (inside `image` 0.25.10) mis-decodes legal JPEGs whose AC Huffman table has a single symbol, which optimised tables produce for near-uniform images. An ignored regression test (`cargo test -- --ignored`) tracks the upstream fix.
- **Lossless WebP isn't size-optimised** (`image-webp`): photos come out much bigger than PNG. Lossy WebP (libwebp via `@jsquash/webp`, Apache-2.0) is the default.
- **AVIF encoding is slow.** It uses rav1e (pure Rust) in a separate, lazily loaded module (940 KB). "Fast" is the default speed.
- **HEIC can't be written**, and HEVC patents may apply to decoding in some countries. libheif (LGPL-3.0) is shipped unmodified as a separate file.
- **Metadata can't be inspected for AVIF/HEIC.** Converted files never contain metadata. Lossless removal supports JPEG, PNG and WebP only.
- **Target size:** an exact byte count can't be guaranteed. Lossless formats can only reach a target by resizing. "At least" never pads files with junk.
- **Editor preview approximations:** previews render on a ≤ 1400 px copy, so fine sharpening and grain look different from the export.
- **Colour management:** pixels are treated as sRGB. **Bit depth:** 16-bit input is processed at 8 bits.
- **Memory:** WASM memory grows to fit the largest image and is only released when the worker ends.
- **Next.js 16.4 static export quirk:** segment-prefetch files are written as nested folders but requested with flat names. `scripts/fix-export.mjs` writes the flat copies.

## WASM SIMD (measured, not enabled)

`simd128` was benchmarked on the full engine (6000 × 4000, Node 24, i7-12650H, median of 3):

| Operation                      |     Baseline |         SIMD |
| ------------------------------ | -----------: | -----------: |
| Encode PNG fast                |       828 ms |       446 ms |
| Encode PNG default             |      1661 ms |      1427 ms |
| Encode JPEG q85 / progressive  | 359 / 374 ms | 384 / 474 ms |
| Develop: + vignette + grain    |      1056 ms |       923 ms |
| Editor preview 1400 px, all on |       176 ms |       145 ms |
| Straighten 3°                  |      1040 ms |      1140 ms |
| Other operations               |   within ±5% |              |

The gains are mixed. The common paths (JPEG encode, straighten) get slower, and SIMD would require a second build plus feature detection for older browsers, so it stays off. The AI runtime and the WebP encoder pick SIMD builds themselves.

## Not implemented yet (⬜)

Tone curve editor, colour grading, noise reduction, dehaze, healing, masks · animated GIF/WebP and multi-page TIFF processing · ICC colour management.

## Benchmarks (6000 × 4000, Node 24 / V8, release WASM, no SIMD)

Run with `pnpm --filter @image-tools/engine bench`. Median of 3 runs on an i7-12650H; figures vary by machine and run.

| Operation                                    |                   Time |
| -------------------------------------------- | ---------------------: |
| Decode JPEG (3.4 MB)                         |                 294 ms |
| Encode JPEG q85                              |                 353 ms |
| Encode PNG fast / balanced / smallest        | ~0.9 / 1.3–1.6 / 2.3 s |
| Encode WebP lossless                         |                 421 ms |
| Resize 50% / to 1920 px (Lanczos3)           |            107 / 80 ms |
| Rotate 90° / flip / crop                     |       113 / 23 / 13 ms |
| Straighten 3°                                |                 ~1.2 s |
| Develop: light + colour                      |                 341 ms |
| Develop: + colour mixer                      |                 ~1.2 s |
| Develop: + clarity + sharpening              |                 ~1.9 s |
| Editor preview, 1400 px, every adjustment on |                 147 ms |

The engine WASM is 2.3 MB (850 KB gzipped). Only the engine and AI workers load it.
