# Pixel Bench

A free, private image toolkit for the browser. A Rust image engine compiled to WebAssembly does the work in Web Workers, and open-source AI models run on-device with ONNX Runtime Web, so images never leave the device. There is no backend, no account, no API key and no analytics. After the first visit it works offline.

The app has three tools. See [docs/FEATURES.md](docs/FEATURES.md) for exactly what works, what is tested, and what is planned.

## What it does

**Photo editor** (`/edit/`): Lightroom-style editing of one photo with a live preview.

| Panel         | Controls                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Presets       | Auto (histogram-based), Vivid, Soft, Warm, Cool, Matte, Moody, Vintage, B&W, B&W Soft             |
| Crop & rotate | Crop by dragging, aspect presets, straighten ±45° (auto-zoom, no empty corners), 90° rotate, flip |
| Light         | Exposure, Contrast, Highlights, Shadows, Whites, Blacks                                           |
| Color         | Temperature, Tint, Vibrance, Saturation, Black & white                                            |
| Color mixer   | Hue, Saturation, Luminance for red, orange, yellow, green, aqua, blue, purple, magenta            |
| Effects       | Clarity, Blur, Vignette (amount, midpoint), Grain                                                 |
| Detail        | Sharpening (amount, radius)                                                                       |
| Border        | Border width and padding to a shape (1:1, 4:5, 3:2, 16:9, 9:16), colour or transparent            |
| Text & logo   | Text and logo watermarks with anchor, size, opacity and shadow                                    |
| Info          | Metadata of the original (camera, dates, GPS)                                                     |
| Export        | Any output format, quality, background; renders at full resolution                                |

It also has an RGB histogram with clipping indicators, before/after (`\`), undo/redo (Ctrl+Z / Ctrl+Shift+Z), per-section reset, and double-click on a slider to reset it.

**Utilities** (`/utilities/`): day-to-day jobs for one file or hundreds.

- Convert to JPEG, PNG, WebP (lossy or lossless), AVIF, GIF, TIFF, ICO or BMP; open all of these plus HEIC/HEIF.
- Compress with quality controls, or to a target file size ("at most" or "at least", optionally resizing).
- Resize to fit within a box or by percentage (Lanczos3), or **AI upscale** 2×/4× with Real-ESRGAN.
- Inspect metadata (camera, dates, GPS) and remove it losslessly from JPEG, PNG and WebP.
- Watermark every file; see each file's real format and size first; download one by one or as a ZIP.

**Remove background** (`/remove-bg/`): an AI cut-out to a transparent PNG, a colour, a blurred copy of the photo or another image, with edge hardness, shift and feather. "Fast" (U²-Netp, 4.6 MB) is served by the site. "High quality" (BiRefNet-lite, 110 MB) is downloaded from Hugging Face only after the user agrees. Fast runs on the GPU via WebGPU when available, otherwise on the CPU. High quality needs WebGPU: the model is too large for WebAssembly's 4 GB memory.

## Repository layout

```
crates/image-core/          Rust library: decode, inspect, ops, encode, limits, errors (native-tested)
packages/image-engine-wasm/ wasm-bindgen bindings (rust/), build script, typed TS wrapper (src/), WASM tests (test/)
crates/avif-encoder/        rav1e AVIF encoder, built as a separate lazily loaded WASM module
apps/web/                   Next.js App Router static site (shadcn/ui), engine + AI workers, unit + Playwright tests
models/                     Self-hosted ONNX models with licences and SHA256SUMS
scripts/convert_esrgan.py   Reproducible Real-ESRGAN → ONNX conversion with a parity check
docs/                       Feature status and technical notes
```

Data flow: `File` → `ArrayBuffer` (transferred, not copied) → engine worker → Rust decode/ops/encode → output bytes (transferred back) → `Blob` → object URL for preview and download. Editor previews render on downscaled copies kept in the worker (an 800 px draft while a slider moves, then 1400 px) and return raw RGBA for a canvas; export always renders at full resolution.

## Requirements

| Tool             | Version used        | Notes                                                                             |
| ---------------- | ------------------- | --------------------------------------------------------------------------------- |
| Node.js          | 24.x (≥ 20.9)       |                                                                                   |
| pnpm             | 12.15               | `packageManager` is pinned                                                        |
| Rust             | stable (1.99)       | `rust-toolchain.toml` adds `wasm32-unknown-unknown`, rustfmt, clippy              |
| wasm-bindgen-cli | **0.2.129** exactly | must match the crate: `cargo install wasm-bindgen-cli --version 0.2.129 --locked` |

### Windows with Smart App Control

Smart App Control blocks the build-script executables that cargo compiles and runs. On such machines, install Rust inside WSL2 and set `IMAGE_TOOLS_RUST=wsl`. The WASM build script then runs cargo and wasm-bindgen through WSL, with the target dir on the Linux filesystem, while all JavaScript tooling stays on Windows. Run Rust tests with `wsl -e bash -lc "cargo test --workspace"` from the repo directory.

## Commands

```sh
pnpm install
pnpm build:wasm          # Rust → wasm32 → packages/image-engine-wasm/pkg
pnpm dev                 # build WASM, then Next dev server on http://localhost:3000
pnpm build               # build WASM, then static export to apps/web/out
pnpm start               # serve apps/web/out locally

pnpm test:rust           # native Rust unit + integration tests
pnpm test:js             # WASM integration tests (Node) + web unit tests
pnpm test:e2e            # Playwright against the static export (run `pnpm build` first;
                         # one-time: pnpm --filter web exec playwright install chromium)
                         # E2E_WEBGPU=1 adds a real-GPU project (needs Google Chrome);
                         # E2E_NETWORK=1 also downloads the real BiRefNet model
pnpm lint                # ESLint + clippy (-D warnings)
pnpm typecheck           # tsc --noEmit in each package
pnpm format              # prettier + cargo fmt
```

## Deployment

`pnpm build` produces a fully static site in `apps/web/out/` that any static host can serve, for example GitHub Pages, Cloudflare Pages or Netlify. Set `NEXT_PUBLIC_BASE_PATH` when serving from a sub-path. The host only serves files; all processing runs in visitors' browsers, so hosting cost doesn't grow with image volume. Free tiers still have bandwidth and request limits: the engine WASM (2.3 MB, about 850 KB gzipped) and the app scripts are downloaded once per visitor and then cached by the browser.

The build runs `apps/web/scripts/fix-export.mjs` after `next build` to work around a Next.js 16.4 static-export quirk with segment-prefetch file names (see [docs/FEATURES.md](docs/FEATURES.md#known-issues-and-limitations)).

For multi-threaded AI on the CPU, serve the site with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. `apps/web/public/_headers` does this on Netlify and Cloudflare Pages. GitHub Pages can't set headers, so AI runs single-threaded there; everything else works the same.

The service worker pre-caches the app (`scripts/build-sw.mjs`). Optional codecs and the AI runtime are cached when first used, and models are cached by the app after their checksum is verified.

The `pkg/` directory is generated and git-ignored, so the build environment needs Rust and wasm-bindgen-cli, or a CI step that builds the WASM first.

## Privacy

- Images are read with `File.arrayBuffer()` and processed in dedicated Web Workers. No image bytes are sent over the network; the Playwright suite asserts that pages make no external requests.
- The only external request the app can make is the opt-in BiRefNet download from Hugging Face. It is pinned to a commit, verified by SHA-256, and explained before it starts.
- No analytics, cookies, accounts or storage of images. Object URLs are revoked when results are replaced or the page is left.
- Converted and edited files are written without EXIF/XMP metadata; Utilities can also remove metadata losslessly and verifies the result.

## Licensing of dependencies

Rust: `image`, `png`, `zune-jpeg`, `image-webp`, `gif`, `tiff`, `jpeg-encoder`, `fast_image_resize`, `kamadak-exif` (BSD-2), `crc32fast`, `ravif`/`rav1e` (BSD-2), `serde`, `thiserror`, `wasm-bindgen`: MIT and/or Apache-2.0 unless noted. Web: Next.js, React, Radix/shadcn, fflate, ONNX Runtime Web (MIT); lucide-react (ISC); `@jsquash/webp` (Apache-2.0).

**libheif-js** (LGPL-3.0) decodes HEIC when the browser can't. It is served unmodified as a separate file (`/vendor/libheif.wasm` plus its licence), so users can replace it. HEIC uses HEVC, which is patent-encumbered in some jurisdictions. Deployers should check whether that applies to them.

Models: U²-Netp (Apache-2.0), BiRefNet-lite (MIT), Real-ESRGAN realesr-general-x4v3 (BSD-3-Clause). Licence texts are in `models/`; see [docs/FEATURES.md](docs/FEATURES.md#ai-models) for sources, hashes and dataset caveats.
