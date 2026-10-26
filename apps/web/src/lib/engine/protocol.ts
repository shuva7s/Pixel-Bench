import type { ImageFormat, ImageInfo, MetadataReport, Operation } from "@image-tools/engine/shared";

import type { OutputSettings } from "../output";
import type { Overlay } from "../overlay";
import type { TargetSpec } from "../target";

export interface OpenResult {
  handle: number;
  info: ImageInfo;
  hasTransparency: boolean;
  /** Null when the format's metadata cannot be inspected (AVIF/HEIC). */
  metadata: MetadataReport | null;
}

export interface TargetOutcome {
  met: boolean;
  reason?: string;
  quality: number;
  scale: number;
  attempts: number;
}

export interface RenderResult {
  bytes: ArrayBuffer;
  format: ImageFormat;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  /** Present when a target size was requested. */
  target?: TargetOutcome;
}

export interface PreviewResult {
  pixels: ArrayBuffer;
  width: number;
  height: number;
}

export interface InspectResult {
  info: ImageInfo;
  metadata: MetadataReport | null;
}

export interface BatchResult extends RenderResult {
  sourceInfo: ImageInfo;
  /** True when the file was rewritten without re-encoding (metadata only). */
  lossless: boolean;
}

export interface StripSpec {
  keepOrientation: boolean;
  keepIcc: boolean;
}

export interface RenderParams {
  ops: Operation[];
  output: OutputSettings;
  overlays?: Overlay[];
  target?: TargetSpec;
}

/** Request name → [params, result]. */
export interface EngineMethods {
  /** Inspect + decode; keeps the decoded image in the worker. */
  open: [{ bytes: ArrayBuffer }, OpenResult];
  /** Header-level inspection plus metadata; nothing is kept. */
  inspect: [{ bytes: ArrayBuffer }, InspectResult];
  render: [{ handle: number } & RenderParams, RenderResult];
  /** Renders `ops` (and overlays) on a cached downscaled proxy and returns RGBA pixels. */
  preview: [{ handle: number; ops: Operation[]; maxSide: number; overlays?: Overlay[] }, PreviewResult];
  /** Registers a logo image for image overlays. */
  setLogo: [{ id: string; bytes: ArrayBuffer }, { width: number; height: number }];
  close: [{ handle: number }, void];
  /** One-shot job for Utilities: decode/transform/encode, or strip metadata losslessly. */
  process: [{ bytes: ArrayBuffer; strip?: StripSpec } & RenderParams, BatchResult];
}
