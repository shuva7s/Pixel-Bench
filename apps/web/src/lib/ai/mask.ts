// Pre/post-processing for background removal. Pure functions on typed arrays
// so they run in a worker and can be unit tested.

import type { ModelId } from "./models";

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * Converts square RGBA pixels into the model's normalised CHW float input.
 * BiRefNet expects x/255; U²-Net divides by the image maximum first (as in
 * the reference implementation). Both then apply ImageNet mean/std.
 */
export function segmentInput(rgba: Uint8Array | Uint8ClampedArray, size: number, model: ModelId): Float32Array {
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  let scale = 1 / 255;
  if (model === "u2netp") {
    let max = 0;
    for (let i = 0; i < plane * 4; i++) if ((i & 3) !== 3 && rgba[i]! > max) max = rgba[i]!;
    scale = 1 / Math.max(max, 1);
  }
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (rgba[i * 4 + c]! * scale - MEAN[c]!) / STD[c]!;
  }
  return out;
}

/** Turns the raw model output into an 8-bit alpha mask (BiRefNet: logits → sigmoid; U²-Net: min-max). */
export function segmentOutput(raw: Float32Array, model: ModelId): Uint8Array {
  const out = new Uint8Array(raw.length);
  if (model === "u2netp") {
    let min = Infinity;
    let max = -Infinity;
    for (const v of raw) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = Math.max(max - min, 1e-6);
    for (let i = 0; i < raw.length; i++) out[i] = Math.round(((raw[i]! - min) / range) * 255);
  } else {
    for (let i = 0; i < raw.length; i++) out[i] = Math.round(255 / (1 + Math.exp(-raw[i]!)));
  }
  return out;
}

export interface EdgeSettings {
  /** 0 = the model's soft edge, 100 = a hard cut. */
  hardness: number;
  /** -50..50: negative trims the subject, positive grows it. */
  shift: number;
  /** Blur radius in pixels of the final image. */
  feather: number;
}

export const DEFAULT_EDGES: EdgeSettings = { hardness: 0, shift: 0, feather: 0 };

/** Applies hardness/shift as a tone curve, then feathers with a blur. */
export function refineMask(mask: Uint8Array, width: number, height: number, edges: EdgeSettings): Uint8Array {
  const threshold = 0.5 - edges.shift / 100;
  const span = 1 - (Math.min(100, Math.max(0, edges.hardness)) / 100) * 0.98;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const a = (v / 255 - threshold) / span + 0.5;
    lut[v] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  // The identity curve: keep the model's alpha untouched.
  const out = edges.hardness === 0 && edges.shift === 0 ? mask.slice() : mask.map((v) => lut[v]!);
  const radius = Math.round(edges.feather);
  return radius > 0 ? boxBlur(boxBlur(out, width, height, radius), width, height, radius) : out;
}

/** Separable box blur of a single-channel image (two passes ≈ a triangle filter). */
export function boxBlur(src: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const pass = (from: Uint8Array, to: Uint8Array, len: number, lines: number, step: number, lineStep: number) => {
    const n = 2 * radius + 1;
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += from[base + Math.min(len - 1, Math.max(0, k)) * step]!;
      for (let i = 0; i < len; i++) {
        to[base + i * step] = Math.round(sum / n);
        sum += from[base + Math.min(len - 1, i + radius + 1) * step]! - from[base + Math.max(0, i - radius) * step]!;
      }
    }
  };
  pass(src, tmp, width, height, 1, width);
  pass(tmp, out, height, width, width, 1);
  return out;
}

export type Backdrop =
  | { kind: "transparent" }
  | { kind: "color"; color: [number, number, number] }
  /** RGBA pixels of the same size as the foreground (a blurred copy or another image). */
  | { kind: "pixels"; pixels: Uint8Array };

/** Places the masked foreground over the backdrop. Returns new RGBA pixels. */
export function composite(fg: Uint8Array, mask: Uint8Array, backdrop: Backdrop): Uint8Array {
  const out = new Uint8Array(fg.length);
  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    const a = (mask[p]! * fg[i + 3]!) / 255;
    if (backdrop.kind === "transparent") {
      out[i] = fg[i]!;
      out[i + 1] = fg[i + 1]!;
      out[i + 2] = fg[i + 2]!;
      out[i + 3] = Math.round(a);
      continue;
    }
    const t = a / 255;
    const bg = backdrop.kind === "color" ? backdrop.color : [backdrop.pixels[i]!, backdrop.pixels[i + 1]!, backdrop.pixels[i + 2]!];
    const bgA = backdrop.kind === "color" ? 255 : backdrop.pixels[i + 3]!;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(fg[i + c]! * t + bg[c]! * (1 - t));
    out[i + 3] = Math.round(a + bgA * (1 - t));
  }
  return out;
}

/** Bilinear resize of a single-channel mask. */
export function resizeMask(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(sh - 1, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(sw - 1, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const top = src[y0 * sw + x0]! * (1 - wx) + src[y0 * sw + x1]! * wx;
      const bottom = src[y1 * sw + x0]! * (1 - wx) + src[y1 * sw + x1]! * wx;
      out[y * dw + x] = Math.round(top * (1 - wy) + bottom * wy);
    }
  }
  return out;
}
