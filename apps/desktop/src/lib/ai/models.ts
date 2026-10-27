// The AI models the app can run (for display). The native side pins and
// verifies every file (crates/ai/src/models.rs). See docs/FEATURES.md for
// sources and licences.

export type ModelId = "u2netp" | "birefnet-lite" | "realesrgan-x4v3";

export interface ModelSpec {
  id: ModelId;
  name: string;
  task: "segment" | "upscale";
  /** Where the file comes from; shown before downloading. */
  host: string;
  /** Shipped inside the app (otherwise downloaded on first use, after consent). */
  bundled: boolean;
  bytes: number;
  sha256: string;
  license: string;
  sourceUrl: string;
}

export const MODELS: Record<ModelId, ModelSpec> = {
  u2netp: {
    id: "u2netp",
    name: "U²-Net (small)",
    task: "segment",
    host: "included with the app",
    bundled: true,
    bytes: 4_574_861,
    sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
    license: "Apache-2.0",
    sourceUrl: "https://github.com/xuebinqin/U-2-Net",
  },
  "birefnet-lite": {
    id: "birefnet-lite",
    name: "BiRefNet-lite",
    task: "segment",
    host: "Hugging Face (huggingface.co)",
    bundled: false,
    bytes: 114_834_127,
    sha256: "4059896039dfccb0f15b9080ff06d11d90e499449bb045e797055eb8901cf5f4",
    license: "MIT",
    sourceUrl: "https://github.com/ZhengPeng7/BiRefNet",
  },
  "realesrgan-x4v3": {
    id: "realesrgan-x4v3",
    name: "Real-ESRGAN general x4v3",
    task: "upscale",
    host: "included with the app",
    bundled: true,
    bytes: 4_866_396,
    sha256: "f788518cc66e302bc9b6946016e989dd9374f1012d5b6c0c7e753904ef3f99e4",
    license: "BSD-3-Clause",
    sourceUrl: "https://github.com/xinntao/Real-ESRGAN",
  },
};
