import type { ImageInfo } from "@image-tools/engine/shared";

import type { BatchResult, PreviewResult, RenderResult } from "../engine/protocol";
import type { OutputSettings } from "../output";
import type { Overlay } from "../overlay";
import type { TargetSpec } from "../target";
import type { EdgeSettings } from "./mask";
import type { ModelId } from "./models";
import type { UpscaleFactor } from "./upscale";

export type Backend = "webgpu" | "wasm";
export type DevicePreference = "auto" | "cpu";

/** What goes behind the cut-out subject. */
export type BackdropSpec =
  | { kind: "transparent" }
  | { kind: "color"; color: [number, number, number] }
  /** The original photo, blurred (0..100, relative to the image size). */
  | { kind: "blur"; amount: number }
  /** The image registered with `setBackdrop`, scaled to cover. */
  | { kind: "image" };

export interface SegmentResult {
  backend: Backend;
  /** Inference time in milliseconds (excluding download). */
  ms: number;
  /** The mask keeps (almost) nothing. */
  empty: boolean;
}

export interface UpscaleResult extends BatchResult {
  backend: Backend;
}

/** Request name → [params, result]. */
export interface AiMethods {
  /** WebGPU availability and models already on this device. */
  capabilities: [void, { webgpu: boolean; cached: ModelId[] }];
  /** Downloads/verifies a model ahead of use. */
  prepare: [{ model: ModelId }, void];
  open: [{ bytes: ArrayBuffer }, { handle: number; info: ImageInfo; hasTransparency: boolean }];
  /** Runs background segmentation; the mask is kept with the image. */
  segment: [{ handle: number; model: ModelId; device: DevicePreference }, SegmentResult];
  /** Composites on a downscaled proxy. `mask: true` returns the mask as grey pixels instead. */
  preview: [{ handle: number; maxSide: number; edges: EdgeSettings; backdrop: BackdropSpec; mask?: boolean }, PreviewResult];
  render: [{ handle: number; edges: EdgeSettings; backdrop: BackdropSpec; output: OutputSettings; target?: TargetSpec }, RenderResult];
  setBackdrop: [{ bytes: ArrayBuffer }, { width: number; height: number }];
  close: [{ handle: number }, void];
  /** One-shot AI upscale for Utilities. */
  upscale: [
    {
      bytes: ArrayBuffer;
      factor: UpscaleFactor;
      device: DevicePreference;
      output: OutputSettings;
      overlays?: Overlay[];
      target?: TargetSpec;
    },
    UpscaleResult,
  ];
  setLogo: [{ id: string; bytes: ArrayBuffer }, { width: number; height: number }];
}
