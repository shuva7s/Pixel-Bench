#!/usr/bin/env node
// Copies third-party WASM files that are served as-is (not bundled) into
// public/vendor, together with their licences. libheif is LGPL-3.0: it is
// shipped unmodified as a separate file so it can be replaced independently.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const out = fileURLToPath(new URL("../public/vendor", import.meta.url));
mkdirSync(out, { recursive: true });

const heif = dirname(require.resolve("libheif-js/package.json"));
copyFileSync(join(heif, "libheif-wasm", "libheif.wasm"), join(out, "libheif.wasm"));
copyFileSync(join(heif, "LICENSE"), join(out, "libheif-LICENSE.txt"));
// ONNX Runtime Web (MIT), loaded at runtime (not bundled) and only by the AI
// tools. The "webgpu" build uses the native WebGPU execution provider (plus
// the CPU one). The default JSEP build was tested and rejected: it can't run
// U²-Net (MaxPool ceil_mode) and returns garbage for BiRefNet on GPUs with 8
// storage buffers per stage.
// (Its package "exports" hide package.json, so resolve the folder directly.)
const ortDir = fileURLToPath(new URL("../node_modules/onnxruntime-web/dist", import.meta.url));
const ortOut = join(out, "ort");

rmSync(ortOut, { recursive: true, force: true });
mkdirSync(ortOut, { recursive: true });
for (const f of ["ort.webgpu.min.mjs", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"])
  copyFileSync(join(ortDir, f), join(ortOut, f));
copyFileSync(fileURLToPath(new URL("../third-party/onnxruntime-LICENSE.txt", import.meta.url)), join(ortOut, "LICENSE.txt"));

// Self-hosted AI models with their licences (see /models/SHA256SUMS).
const models = fileURLToPath(new URL("../../../models", import.meta.url));
const modelsOut = fileURLToPath(new URL("../public/models", import.meta.url));
mkdirSync(modelsOut, { recursive: true });
for (const f of readdirSync(models)) copyFileSync(join(models, f), join(modelsOut, f));
console.log("copy-vendor: libheif, onnxruntime-web and models copied to public/");
