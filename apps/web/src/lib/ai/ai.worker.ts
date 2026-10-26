/// <reference lib="webworker" />
// Runs the AI tools (background removal, upscaling) off the main thread. The
// image engine is used here too, for decoding, resizing and encoding.

import { DecodedImage, EngineError, initEngine, toEngineError, type SourceFormat } from "@image-tools/engine";

import { decodeAny } from "../engine/decoding";
import { logos, renderOutput, transferableBuffer } from "../engine/render";
import { serve } from "../engine/rpc";
import { composite, refineMask, resizeMask, segmentInput, segmentOutput, type Backdrop, type EdgeSettings } from "./mask";
import { MODELS, type ModelId } from "./models";
import type { AiMethods, BackdropSpec } from "./protocol";
import { cachedModels, fetchModel, getSession, hasWebGpu, run } from "./runtime";
import { MODEL_SCALE, placeTile, planTiles, tileInput, upscaleAlpha, upscaleProblem } from "./upscale";

/** Square input size of each segmentation model. */
const INPUT_SIZE: Partial<Record<ModelId, number>> = { u2netp: 320, "birefnet-lite": 1024 };

interface View {
  image: DecodedImage;
  rgba: Uint8Array;
  /** The model's mask resized to this view, cached until the next segmentation. */
  mask: Uint8Array | null;
  blur: { amount: number; pixels: Uint8Array } | null;
}

interface Entry {
  image: DecodedImage;
  source: SourceFormat;
  /** Raw model output, square, `size` × `size`. */
  mask: { data: Uint8Array; size: number } | null;
  views: Map<number, View>;
}

const images = new Map<number, Entry>();
let backdropImage: ImageBitmap | null = null;
let nextHandle = 1;
const ready = initEngine();

function entry(handle: number): Entry {
  const e = images.get(handle);
  if (!e) throw new EngineError("ENGINE_NOT_READY", "The image is no longer loaded. Please open it again.");
  return e;
}

function disposeViews(e: Entry) {
  e.views.forEach((v) => v.image !== e.image && v.image.dispose());
  e.views.clear();
}

/** The full image (maxSide 0) or a cached downscaled proxy. */
function view(e: Entry, maxSide: number): View {
  const key = maxSide >= Math.max(e.image.width, e.image.height) ? 0 : maxSide;
  let v = e.views.get(key);
  if (!v) {
    const image = key === 0 ? e.image : e.image.thumbnail(key);
    v = { image, rgba: image.renderRgba([]).pixels, mask: null, blur: null };
    e.views.set(key, v);
  }
  if (!v.mask) {
    if (!e.mask) throw new EngineError("INVALID_OPTIONS", "Remove the background first.");
    v.mask = resizeMask(e.mask.data, e.mask.size, e.mask.size, v.image.width, v.image.height);
  }
  return v;
}

function backdropPixels(v: View, spec: BackdropSpec): Backdrop {
  switch (spec.kind) {
    case "transparent":
      return { kind: "transparent" };
    case "color":
      return { kind: "color", color: spec.color };
    case "blur": {
      if (v.blur?.amount !== spec.amount) {
        v.blur = { amount: spec.amount, pixels: v.image.renderRgba([{ op: "develop", blur: spec.amount }]).pixels };
      }
      return { kind: "pixels", pixels: v.blur.pixels };
    }
    case "image": {
      if (!backdropImage) throw new EngineError("INVALID_OPTIONS", "Choose a background image first.");
      const { width: w, height: h } = v.image;
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d")!;
      // Scale to cover, centred.
      const s = Math.max(w / backdropImage.width, h / backdropImage.height);
      const dw = backdropImage.width * s;
      const dh = backdropImage.height * s;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(backdropImage, (w - dw) / 2, (h - dh) / 2, dw, dh);
      return { kind: "pixels", pixels: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer) };
    }
  }
}

/** Feather is 0..100, where 100 blurs the edge by 1% of the image's long side. */
function refined(v: View, edges: EdgeSettings): Uint8Array {
  const feather = (edges.feather / 100) * 0.01 * Math.max(v.image.width, v.image.height);
  return refineMask(v.mask!, v.image.width, v.image.height, { ...edges, feather });
}

type Handlers = {
  [M in keyof AiMethods]: (
    p: AiMethods[M][0],
    progress: (p: { label: string; fraction: number | null }) => void,
  ) => AiMethods[M][1] | Promise<AiMethods[M][1]>;
};

const handlers: Handlers = {
  async capabilities() {
    return { webgpu: await hasWebGpu(), cached: await cachedModels() };
  },
  async prepare({ model }, progress) {
    await fetchModel(MODELS[model], progress);
  },
  async open({ bytes }) {
    const { image, info } = await decodeAny(new Uint8Array(bytes));
    const handle = nextHandle++;
    images.set(handle, { image, source: info.format, mask: null, views: new Map() });
    return { handle, info, hasTransparency: image.hasTransparency() };
  },
  async segment({ handle, model, device }, progress) {
    const e = entry(handle);
    const size = INPUT_SIZE[model];
    if (!size) throw new EngineError("INVALID_OPTIONS", `${MODELS[model].name} is not a background-removal model.`);
    const session = await getSession(model, device, progress);
    progress({ label: session.backend === "webgpu" ? "Finding the subject (GPU)" : "Finding the subject (CPU)", fraction: null });
    const input = e.image.renderRgba([
      { op: "resize", size: { mode: "exact", width: size, height: size }, filter: model === "u2netp" ? "lanczos3" : "bilinear" },
    ]).pixels;
    const start = performance.now();
    const raw = await run(session, segmentInput(input, size, model), [1, 3, size, size]);
    const ms = performance.now() - start;
    const data = segmentOutput(raw.subarray(0, size * size), model);
    e.mask = { data, size };
    e.views.forEach((v) => (v.mask = null));
    // Fewer than 0.1% of pixels kept: no subject found (or the device computed garbage).
    let kept = 0;
    for (const v of data) if (v >= 128) kept++;
    return { backend: session.backend, ms, empty: kept < data.length / 1000 };
  },
  preview({ handle, maxSide, edges, backdrop, mask }) {
    const v = view(entry(handle), maxSide);
    const alpha = refined(v, edges);
    let pixels: Uint8Array;
    if (mask) {
      pixels = new Uint8Array(alpha.length * 4);
      for (let i = 0; i < alpha.length; i++) {
        pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = alpha[i]!;
        pixels[i * 4 + 3] = 255;
      }
    } else {
      pixels = composite(v.rgba, alpha, backdropPixels(v, backdrop));
    }
    return { pixels: transferableBuffer(pixels), width: v.image.width, height: v.image.height };
  },
  async render({ handle, edges, backdrop, output, target }) {
    const e = entry(handle);
    const v = view(e, 0);
    const pixels = composite(v.rgba, refined(v, edges), backdropPixels(v, backdrop));
    // The full-size copies are large; drop them once the export is done.
    e.views.delete(0);
    const out = DecodedImage.fromRgba(pixels, v.image.width, v.image.height);
    try {
      return await renderOutput(out, e.source, [], output, [], target);
    } finally {
      out.dispose();
    }
  },
  async setBackdrop({ bytes }) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    backdropImage?.close();
    backdropImage = bitmap;
    return { width: bitmap.width, height: bitmap.height };
  },
  close({ handle }) {
    const e = images.get(handle);
    if (!e) return;
    disposeViews(e);
    e.image.dispose();
    images.delete(handle);
  },
  async upscale({ bytes, factor, device, output, overlays, target }, progress) {
    const { image, info } = await decodeAny(new Uint8Array(bytes));
    let result: DecodedImage | null = null;
    try {
      const problem = upscaleProblem(image.width, image.height, factor);
      if (problem) throw new EngineError("TOO_LARGE", problem);
      const session = await getSession("realesrgan-x4v3", device, progress);
      const src = image.renderRgba([]).pixels;
      const ow = image.width * factor;
      const oh = image.height * factor;
      const out = new Uint8Array(ow * oh * 4);
      const tiles = planTiles(image.width, image.height);
      const label = session.backend === "webgpu" ? "Upscaling (GPU)" : "Upscaling (CPU)";
      for (const [i, t] of tiles.entries()) {
        progress({ label, fraction: i / tiles.length });
        const y = await run(session, tileInput(src, image.width, t), [1, 3, t.inHeight, t.inWidth]);
        if (y.length !== 3 * t.inWidth * t.inHeight * MODEL_SCALE * MODEL_SCALE) {
          throw new EngineError("INFERENCE_FAILED", "The upscaling model returned an unexpected size.");
        }
        placeTile(y, t, out, ow, factor);
      }
      progress({ label: "Encoding", fraction: null });
      if (image.hasTransparency()) upscaleAlpha(src, image.width, image.height, out, factor);
      else for (let i = 3; i < out.length; i += 4) out[i] = 255;
      result = DecodedImage.fromRgba(out, ow, oh);
      const r = await renderOutput(result, info.format, [], output, overlays, target);
      return { ...r, sourceInfo: info, lossless: false, backend: session.backend };
    } finally {
      result?.dispose();
      image.dispose();
    }
  },
  async setLogo({ id, bytes }) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    logos.get(id)?.close();
    logos.set(id, bitmap);
    return { width: bitmap.width, height: bitmap.height };
  },
};

serve<AiMethods>(
  handlers,
  (err) => {
    const e = toEngineError(err);
    return { code: e.code, message: e.message };
  },
  ready,
);
