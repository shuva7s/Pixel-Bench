# Architecture and technical decisions

## Layers

| Layer       | Location                          | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core engine | `crates/image-core`               | Format detection (magic bytes), header inspection, decoding with limits, EXIF orientation, pixel operations, encoders, structured errors. Pure Rust, no wasm dependencies, tested natively.                                                                                                                                                                                                                                                                                                                            |
| Bindings    | `packages/image-engine-wasm/rust` | `wasm-bindgen` surface: `inspect`, `process`, `EngineImage` (decode once, render many), `limits`. Options cross as JSON; errors become JS `Error`s whose `name` is a stable code.                                                                                                                                                                                                                                                                                                                                      |
| TS wrapper  | `packages/image-engine-wasm/src`  | Typed API (`DecodedImage`, `processImage`, `inspectImage`), `EngineError`, the format table. The `shared` entry has no WASM glue so the main thread never loads the engine.                                                                                                                                                                                                                                                                                                                                            |
| Worker      | `apps/web/src/lib/engine`         | Typed request/response protocol over a dedicated module worker. Keeps decoded images by handle; transfers `ArrayBuffer`s both ways. On an engine crash the worker is replaced and pending calls fail with `ENGINE_CRASHED`.                                                                                                                                                                                                                                                                                            |
| AI worker   | `apps/web/src/lib/ai`             | A second worker for background removal and upscaling. It loads ONNX Runtime Web from `/vendor/ort/` at runtime (not bundled), picks WebGPU or WebAssembly (BiRefNet is GPU-only; other models retry on the CPU if the GPU fails), downloads models with progress, verifies SHA-256 and caches them in Cache Storage (`models-v1`). It reuses the engine for decoding, resizing and encoding (`lib/engine/render.ts` is shared by both workers). Pre/post-processing (`mask.ts`, `upscale.ts`) is pure and unit-tested. |
| RPC         | `apps/web/src/lib/engine/rpc.ts`  | Generic typed request/response client and worker loop with progress messages. Both workers use it.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| UI          | `apps/web/src/components`         | shadcn/ui (Radix, default neutral theme; dark mode follows the OS) in `components/ui/`, shared fields in `fields.tsx`, and a full-height two-pane `Workspace` (stage left, scrollable options right; stacked on phones with the image pinned). Three workspaces: `editor/` (state, undo history, Auto and presets in `lib/editor.ts`), `utilities/` (one or many files, bounded worker pool) and `remove-bg/`.                                                                                                         |

## Pipeline

`decode → [flip | rotate | straighten | crop | resize | develop | pad]* → [overlays] → encode`

Overlays (text and logos) are drawn on an OffscreenCanvas in the worker. Pixels leave the Rust engine only when a JS-side step is needed: overlays, lossy WebP (libwebp via `@jsquash/webp`) or AVIF (rav1e, a separate WASM module).

The editor always emits operations in the order flip → rotate → straighten → crop → develop → pad, so crop coordinates refer to the rotated and straightened frame.

- Every operation takes an owned `RgbaImage` and returns one, so a run holds at most the source plus one working buffer. Identity operations return their input without copying.
- `EngineImage::render` clones the decoded source once per run, so the source can be re-rendered with different settings without decoding again.
- Editor previews use cached downscaled proxies inside the worker (800 px drafts while a slider moves, 1400 px when idle) and return raw RGBA, which avoids an encode/decode round trip. `apply_all_scaled` adapts full-resolution operations to a proxy: crop rectangles and the sharpening radius are scaled, and crops are clamped only on proxies, never at full resolution.

## Limits and safety

- Input ≤ 100 MB, ≤ 20,000 px per side, ≤ 50 MP. Dimensions are checked from the header **before** pixel allocation, and the `image` decoder also gets `max_alloc` and side limits.
- The resize target is validated against the same limits. WebP output is capped at 16,383 px per side by the format and JPEG at 65,535.
- Arithmetic on crop bounds uses `checked_add`. The APNG/WebP animation scanners are bounds-checked and never panic on malformed input.
- The release profile uses `panic = "abort"`. If a wasm trap occurs anyway (for example out of memory), the worker is terminated and recreated, and the user sees a clear message.
- Animated PNG/WebP files are detected and rejected with `ANIMATED_NOT_SUPPORTED`; they are never silently flattened to one frame.

## Codec choices

| Format | Decode                        | Encode                                                      | Notes                                                                                                                                                                                               |
| ------ | ----------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JPEG   | `zune-jpeg` (via `image`)     | `jpeg-encoder`                                              | Standard Huffman tables (optimised tables trigger a `zune-jpeg` decode bug, see FEATURES.md), optional progressive, 4:2:0 below q90 and 4:4:4 at q90+. Alpha is flattened onto a chosen background. |
| PNG    | `png`                         | `png` via `image`                                           | Fast / default / best levels with adaptive filtering. The colour type is reduced losslessly (L8 / LA8 / RGB8 / RGBA8) when channels are unused.                                                     |
| WebP   | `image-webp`                  | libwebp (`@jsquash/webp`, lossy) or `image-webp` (lossless) | Lossy is the default; the libwebp encoder is loaded only when needed.                                                                                                                               |
| BMP    | `image`                       | `image` (24-bit)                                            | Alpha is flattened, because viewer support for 32-bit BMP alpha is inconsistent.                                                                                                                    |
| AVIF   | browser (`createImageBitmap`) | `ravif`/rav1e (separate module)                             | Encode speed setting maps to rav1e 10 / 8 / 6.                                                                                                                                                      |
| HEIC   | browser, else libheif-js      | —                                                           | libheif (LGPL-3.0) is served as a separate, unmodified file. The container is sniffed from `ftyp` brands and its size read from the `ispe` box before decoding.                                     |
| GIF    | `gif` (via `image`)           | `gif` (speed 10)                                            | Animated GIFs are rejected.                                                                                                                                                                         |
| TIFF   | `tiff`                        | `tiff` (LZW + predictor)                                    | Multi-page TIFFs are rejected.                                                                                                                                                                      |
| ICO    | `image`                       | `image` (PNG entries)                                       | The image is padded to a square; sizes 16–256 px up to the source size.                                                                                                                             |

Resizing uses `fast_image_resize` (convolution with Lanczos3, Catmull-Rom or bilinear, or nearest). It premultiplies alpha when the image has transparency, so transparent edges don't get dark fringes.

Develop (`ops/develop.rs`) runs in stages:

1. White balance and exposure in linear light, then a monotone cubic tone curve (Fritsch–Carlson) in gamma space, shaped by contrast, highlights, shadows, whites and blacks. Everything up to here depends only on each 8-bit channel value, so it collapses into three 256-entry tables; with no colour adjustments the stage maps u8 to u8 directly.
2. Colour: an HSL mixer with linear blending between eight band centres, then vibrance/saturation (mixing towards Rec. 709 luma), then black & white.
3. Local contrast on an 8-bit luma plane: clarity (blur radius 1% of the long side) and unsharp-mask sharpening. The blurs approximate a Gaussian with three box passes using prefix sums and running column sums.
4. Vignette (lookup by squared radius) and deterministic hash grain.

On wasm32, `f32::round` and `rem_euclid` compile to software routines rather than single instructions, so hot loops use `round_ties_even` (native `f32.nearest`) and `floor`-based wrapping.

## Version notes (verified 2026-10)

- Next.js 16.4.3 (Turbopack, App Router, `output: "export"`), React 19.3.1, Tailwind CSS 4.3.3.
- TypeScript **6.0.3**, not 7.x: TS 7 (the native port) does not expose the compiler API that `typescript-eslint` needs, and `typescript-eslint` requires `<6.1`.
- ESLint **9.39.5**, not 10.x: the React, jsx-a11y and import plugins bundled by `eslint-config-next` 16.4 declare peer support only up to ESLint 9.
- Rust stable 1.99, edition 2024, `image` 0.25.10, `wasm-bindgen` 0.2.129 (CLI pinned to match).
- WASM SIMD (`simd128`) was benchmarked and left off: the results are mixed, and some common paths get slower (see FEATURES.md).
- ONNX Runtime Web 1.30.0: the `webgpu` build (native WebGPU EP, asyncify wasm) is used, not the default JSEP build, which failed on U²-Net and BiRefNet on GPUs (see FEATURES.md). It is served from `/vendor/ort/` and imported at runtime with `turbopackIgnore`, so it is never bundled. `onnxruntime-web` ships no licence file in the package, so the MIT licence is copied from the repository (`apps/web/third-party/`).

## Metadata

`metadata.rs` parses EXIF (kamadak-exif), XMP, ICC and comments to build the report. `strip_metadata` rewrites JPEG segments, PNG chunks (CRCs recomputed) and WebP RIFF chunks (VP8X flags updated) without touching image data. It can keep orientation and ICC, drops trailing data, and re-parses the output to verify it is clean.

## Target file size

`lib/target.ts` binary-searches quality (at most 16 encodes). If that is not enough and resizing is allowed, it searches the scale using a learned size ∝ scale^k model. It always returns the best attempt with an honest "met / not met" reason.

## Offline

`scripts/build-sw.mjs` generates `sw.js` with a content hash. Pages are network-first; hashed assets are cache-first. Worker scripts are matched without their query string and re-wrapped, so worker bootstrap still works offline. Optional codecs and ORT are cached on first use. `.onnx` requests bypass the service worker, because the app keeps its own verified model cache, which updates don't clear.
