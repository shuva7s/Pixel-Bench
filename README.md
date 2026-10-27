# Pixel Bench

A free, private image toolkit for **Windows, macOS and Linux**. It is a desktop app built with [Tauri 2](https://tauri.app): a native Rust backend does all the work (image engine, encoders, AI models via ONNX Runtime), and a React/TypeScript interface runs in the system web view. Nothing is uploaded, and there is no account, API key or analytics. Everything works offline. The only optional download is the high-quality background-removal model, fetched once after you agree.

See [docs/FEATURES.md](docs/FEATURES.md) for exactly what works and what is tested, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.

## What it does

**Photo editor**: Lightroom-style editing of one photo with a live preview.

| Panel         | Controls                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Presets       | Auto (histogram-based), Vivid, Soft, Warm, Cool, Matte, Moody, Vintage, B&W, B&W Soft           |
| Crop & rotate | Crop by dragging, aspect presets or a custom ratio, straighten ±45°, 90° rotate, flip           |
| Light         | Exposure, Contrast, Highlights, Shadows, Whites, Blacks                                         |
| Color         | Temperature, Tint, Vibrance, Saturation, Black & white                                          |
| Color mixer   | Hue, Saturation, Luminance for red, orange, yellow, green, aqua, blue, purple, magenta          |
| Effects       | Clarity, Blur, Vignette (amount, midpoint), Grain                                               |
| Detail        | Sharpening (amount, radius)                                                                     |
| Border        | Border width and padding to a shape (1:1, 4:5, 3:2, 16:9, 9:16), colour or transparent          |
| Text & logo   | Text and logo watermarks with anchor, size, opacity and shadow                                  |
| Info          | Metadata of the original (camera, dates, GPS)                                                   |
| Export        | Any output format, quality, background; renders at full resolution and saves with a Save dialog |

**Utilities**: day-to-day jobs for one file or hundreds.

- Convert to JPEG, PNG, WebP (lossy or lossless), AVIF, GIF, TIFF, ICO or BMP; open all of these plus HEIC/HEIF.
- Compress with a quality slider, or aim for a file size ("at most" / "at least", optionally resizing) instead.
- Resize to fit a box or by percentage (Lanczos3), or **AI upscale** 2×/4× with Real-ESRGAN.
- Inspect metadata (camera, dates, GPS) and remove it losslessly from JPEG, PNG and WebP.
- Watermark every file; process files in parallel; save one by one or all into a folder (existing files are never overwritten).

**Remove background**: an AI cut-out to a transparent PNG, a colour, a blurred copy of the photo or another image, with edge hardness, shift and feather.

- "Fast" (U²-Netp, 4.6 MB) is included with the app.
- "High quality" (BiRefNet-lite, 110 MB) is downloaded from Hugging Face only after you agree, and verified by SHA-256.
- Both run on the GPU where supported (DirectML on Windows, Core ML on macOS), otherwise on the CPU. On the CPU, High quality takes about 10 s per photo and Fast about 0.25 s.

## Repository layout

```
crates/image-core/       Image engine: decode, inspect, ops (develop, crop, straighten, resize…), encode, metadata, limits
crates/app-core/         Desktop backend: open images, previews, every output format (incl. libwebp, rav1e),
                         target file size, text/logo watermarks, batch jobs
crates/ai/               ONNX Runtime models: background removal, Real-ESRGAN upscaling, verified model downloads
crates/avif-encoder/     AVIF encoding (rav1e via ravif, multi-threaded)
apps/desktop/            Tauri app: src-tauri/ (Rust shell, one `call` command) + src/ (Next.js static UI, shadcn/ui)
models/                  Bundled ONNX models with licences and SHA256SUMS
scripts/convert_esrgan.py  Reproducible Real-ESRGAN → ONNX conversion with a parity check
.github/workflows/       Cloud builds: tests + installers for Windows, macOS and Linux
```

## Requirements

| Tool    | Version           | Notes                                                                                                                                           |
| ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js | 24.x (≥ 20.9)     | builds the interface                                                                                                                            |
| pnpm    | 12.15             | `packageManager` is pinned                                                                                                                      |
| Rust    | stable (1.99)     | `rust-toolchain.toml` adds rustfmt and clippy                                                                                                   |
| OS deps | see Tauri's guide | Linux: `libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev nasm`; Windows/macOS: `nasm` for the AVIF encoder's assembly |

ONNX Runtime itself is downloaded automatically by the `ort` crate at build time (prebuilt, verified by hash).

### Windows with Smart App Control

Smart App Control blocks executables compiled on the machine, which includes every Rust build script. On such PCs:

- **Develop and test in WSL2** as a Linux app. Tauri windows open on the Windows desktop through WSLg. Build the interface on Windows (`pnpm --filter desktop build`), then build and run the app in WSL with `cargo run -p pixel-bench --features tauri/custom-protocol`.
- **Get Windows and macOS installers from CI.** Push to GitHub, and `.github/workflows/desktop.yml` builds them on GitHub's machines. Download them from the run's _Artifacts_.
- Unsigned installers trigger SmartScreen/Gatekeeper warnings, and Smart App Control may refuse an unsigned app altogether. Code signing (for example Azure Trusted Signing on Windows, or an Apple Developer ID on macOS) removes these warnings. It is not set up yet.

## Commands

```sh
pnpm install

# Interface (Windows or anywhere with Node)
pnpm --filter desktop build      # static UI → apps/desktop/out
pnpm --filter desktop test       # UI unit tests (Vitest)
pnpm --filter desktop typecheck
pnpm --filter desktop lint

# Native (macOS, Linux, Windows without Smart App Control — or inside WSL)
cargo test --workspace --release # engine, encoders, target size, watermarks, AI (runs the real models)
cargo clippy --workspace --all-targets -- -D warnings
cd apps/desktop && pnpm tauri dev    # live-reloading app (runs `next dev` + the Rust shell)
cd apps/desktop && pnpm tauri build  # installers in target/release/bundle/
```

To include BiRefNet in the Rust tests, set `BIREFNET_DIR` to a folder that contains `birefnet-lite-fp16.onnx`.

## Privacy

- Images are processed on your computer by the Rust backend. Nothing is sent over the network.
- The only network request the app can make is the opt-in BiRefNet download from Hugging Face. It is pinned to a commit, verified by SHA-256 before use, and explained before it starts.
- No analytics, accounts or telemetry. Results are saved only where you choose.
- Converted and edited files are written without EXIF/XMP metadata; Utilities can also remove metadata losslessly and verifies the result.

## Licensing of dependencies

- **Rust:** `image`, `png`, `zune-jpeg`, `image-webp`, `gif`, `tiff`, `jpeg-encoder`, `fast_image_resize`, `kamadak-exif` (BSD-2), `ravif`/`rav1e` (BSD-2), `webp`/libwebp (BSD-3), `tiny-skia` (BSD-3), `ab_glyph`, `fontdb`, `rayon`, `ort` and ONNX Runtime (MIT), `ureq`, `sha2`, `serde`, `thiserror`, Tauri. All are MIT and/or Apache-2.0 unless noted.
- **Interface:** Next.js, React, Radix/shadcn, Tauri JS API (MIT); lucide-react (ISC).
- **Fonts:** Geist and Geist Mono (SIL OFL 1.1), bundled for text watermarks.
- **libheif-js** (LGPL-3.0) decodes HEIC when the system cannot. It ships unmodified as a separate file (`/vendor/libheif.wasm` plus its licence), so it can be replaced. HEIC uses HEVC, which is patent-encumbered in some jurisdictions; check whether that applies to you.
- **Models:** U²-Netp (Apache-2.0), BiRefNet-lite (MIT), Real-ESRGAN realesr-general-x4v3 (BSD-3-Clause). Licence texts are in `models/` and in the app's `licenses` folder. See [docs/FEATURES.md](docs/FEATURES.md#ai-models) for sources, hashes and dataset caveats.
