// Registry of the AI models the app can run. Every model is pinned by size
// and SHA-256; the checksum is verified in the browser before the model is
// used or cached. See FEATURES.md for sources and licences.

export type ModelId = "u2netp" | "birefnet-lite" | "realesrgan-x4v3";

export interface ModelSpec {
  id: ModelId;
  name: string;
  task: "segment" | "upscale";
  /** Absolute URL, or a path relative to the site root. */
  url: string;
  /** Who serves the file; shown before downloading. */
  host: string;
  bytes: number;
  sha256: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  /** Too large for the CPU path (WebAssembly is limited to 4 GB of memory): WebGPU only. */
  requiresGpu?: boolean;
}

export const MODELS: Record<ModelId, ModelSpec> = {
  u2netp: {
    id: "u2netp",
    name: "U²-Net (small)",
    task: "segment",
    url: "/models/u2netp.onnx",
    host: "this site",
    bytes: 4_574_861,
    sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
    license: "Apache-2.0",
    licenseUrl: "/models/LICENSE-U2Net.txt",
    sourceUrl: "https://github.com/xuebinqin/U-2-Net",
  },
  "birefnet-lite": {
    id: "birefnet-lite",
    name: "BiRefNet-lite",
    task: "segment",
    url: "https://huggingface.co/jiabins0303/birefnet-lite-1024-webgpu/resolve/1ad01cef0f4101a285c5a3e0bd7f15597d93403f/onnx/model_fp16.onnx",
    host: "Hugging Face (huggingface.co)",
    bytes: 114_834_127,
    sha256: "4059896039dfccb0f15b9080ff06d11d90e499449bb045e797055eb8901cf5f4",
    license: "MIT",
    licenseUrl: "/models/LICENSE-BiRefNet.txt",
    sourceUrl: "https://github.com/ZhengPeng7/BiRefNet",
    // Fixed 1024×1024 input; on WebAssembly inference fails with std::bad_alloc.
    requiresGpu: true,
  },
  "realesrgan-x4v3": {
    id: "realesrgan-x4v3",
    name: "Real-ESRGAN general x4v3",
    task: "upscale",
    url: "/models/realesr-general-x4v3.onnx",
    host: "this site",
    bytes: 4_866_396,
    sha256: "f788518cc66e302bc9b6946016e989dd9374f1012d5b6c0c7e753904ef3f99e4",
    license: "BSD-3-Clause",
    licenseUrl: "/models/LICENSE-Real-ESRGAN.txt",
    sourceUrl: "https://github.com/xinntao/Real-ESRGAN",
  },
};

/** Resolves a model or vendor path against the site's base path. */
export function siteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
}

/** Cache Storage bucket for verified models. Not prefixed "pixel-bench-", so app updates keep it. */
export const MODEL_CACHE = "models-v1";
