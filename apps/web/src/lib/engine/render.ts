// Rendering + encoding shared by the engine and AI workers.

import {
  DecodedImage,
  EngineError,
  FORMATS,
  type EncodeOptions,
  type ImageFormat,
  type Operation,
  type SourceFormat,
} from "@image-tools/engine";

import { isLossy, toEncodeOptions, type OutputSettings } from "../output";
import { drawOverlays, isEmptyOverlay, type Overlay } from "../overlay";
import { fitToTarget, type TargetSpec } from "../target";
import { encodeAvifPixels, encodeLossyWebp, type Pixels } from "./codecs";
import { MAX_PIXELS, MAX_SIDE } from "./decoding";
import type { RenderResult } from "./protocol";

/** Logo images for image overlays, registered by id. */
export const logos = new Map<string, ImageBitmap>();

interface Encoded {
  bytes: Uint8Array;
  format: ImageFormat;
  width: number;
  height: number;
}

/** Draws overlays onto RGBA pixels with an OffscreenCanvas. */
export function applyOverlays(px: Pixels, overlays: Overlay[]): Pixels {
  const visible = overlays.filter((o) => !isEmptyOverlay(o));
  if (visible.length === 0) return px;
  const canvas = new OffscreenCanvas(px.width, px.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new EngineError("ENCODE_FAILED", "Could not create a canvas for text and watermarks.");
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(px.pixels.buffer as ArrayBuffer, px.pixels.byteOffset, px.pixels.byteLength), px.width, px.height),
    0,
    0,
  );
  drawOverlays(ctx, px.width, px.height, visible, logos);
  const data = ctx.getImageData(0, 0, px.width, px.height).data;
  return { pixels: new Uint8Array(data.buffer), width: px.width, height: px.height };
}

/**
 * Renders `ops` and encodes for `output`. Pixels only leave the Rust engine
 * when a JS-side step is needed (overlays, lossy WebP, AVIF).
 */
async function encodeImage(
  image: DecodedImage,
  source: SourceFormat,
  ops: Operation[],
  output: OutputSettings,
  overlays: Overlay[],
  quality?: number,
): Promise<Encoded> {
  const enc = toEncodeOptions(output, source, quality);
  const needsPixels = overlays.some((o) => !isEmptyOverlay(o)) || enc.format === "avif" || "lossy" in enc;
  if (!needsPixels) {
    const r = image.render(ops, enc as EncodeOptions);
    return { bytes: r.bytes, format: r.format, width: r.width, height: r.height };
  }
  const px = applyOverlays(image.renderRgba(ops), overlays);
  if (enc.format === "avif") {
    return { bytes: await encodeAvifPixels(px, enc.quality, enc.speed), format: "avif", width: px.width, height: px.height };
  }
  if ("lossy" in enc) {
    return { bytes: await encodeLossyWebp(px, enc.quality), format: "webp", width: px.width, height: px.height };
  }
  const tmp = DecodedImage.fromRgba(px.pixels, px.width, px.height);
  try {
    const r = tmp.render([], enc);
    return { bytes: r.bytes, format: r.format, width: r.width, height: r.height };
  } finally {
    tmp.dispose();
  }
}

/** Encodes, optionally searching quality/dimensions for a target size. */
export async function renderOutput(
  image: DecodedImage,
  source: SourceFormat,
  ops: Operation[],
  output: OutputSettings,
  overlays: Overlay[] = [],
  target?: TargetSpec,
): Promise<RenderResult> {
  const finish = (r: Encoded, extra: Partial<RenderResult> = {}): RenderResult => ({
    bytes: transferableBuffer(r.bytes),
    format: r.format,
    mimeType: FORMATS[r.format].mimeType,
    extension: FORMATS[r.format].extension,
    width: r.width,
    height: r.height,
    ...extra,
  });
  if (!target) return finish(await encodeImage(image, source, ops, output, overlays));

  let last: Encoded | null = null;
  const pixels = image.width * image.height;
  const maxScale = Math.max(0.05, Math.min(4, Math.sqrt(MAX_PIXELS / pixels), MAX_SIDE / Math.max(image.width, image.height)));
  const withScale = (scale: number): Operation[] =>
    scale === 1 ? ops : [...ops, { op: "resize", size: { mode: "percent", percent: scale * 100 }, filter: "lanczos3" }];
  const outcome = await fitToTarget(
    async (q, scale) => {
      last = await encodeImage(image, source, withScale(scale), output, overlays, q);
      return last.bytes;
    },
    target,
    isLossy(output, source),
    maxScale,
  );
  // Re-encode the chosen settings only if the last attempt was a different one.
  const final =
    last && (last as Encoded).bytes === outcome.bytes
      ? (last as Encoded)
      : await encodeImage(image, source, withScale(outcome.scale), output, overlays, outcome.quality);
  return finish(final, {
    target: { met: outcome.met, reason: outcome.reason, quality: outcome.quality, scale: outcome.scale, attempts: outcome.attempts },
  });
}

export function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  return (bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
}
