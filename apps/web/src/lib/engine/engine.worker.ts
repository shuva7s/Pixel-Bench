/// <reference lib="webworker" />
// Runs the image engine off the main thread. One request at a time per worker
// (messages are processed sequentially), so memory use is bounded.

import {
  DecodedImage,
  EngineError,
  FORMATS,
  initEngine,
  inspectMetadata,
  stripMetadata,
  toEngineError,
  type ImageFormat,
  type MetadataReport,
  type SourceFormat,
} from "@image-tools/engine";

import { decodeAny, inspectAny } from "./decoding";
import type { EngineMethods } from "./protocol";
import { applyOverlays, logos, renderOutput, transferableBuffer } from "./render";
import { serve } from "./rpc";

interface Entry {
  image: DecodedImage;
  source: SourceFormat;
  /** Downscaled proxies for previews, keyed by maximum side. */
  proxies: Map<number, DecodedImage>;
}

const images = new Map<number, Entry>();

let nextHandle = 1;
const ready = initEngine();

function entry(handle: number): Entry {
  const e = images.get(handle);
  if (!e) throw new EngineError("ENGINE_NOT_READY", "The image is no longer loaded. Please open it again.");
  return e;
}

function safeMetadata(bytes: Uint8Array): MetadataReport | null {
  try {
    return inspectMetadata(bytes);
  } catch {
    return null;
  }
}

type Handlers = { [M in keyof EngineMethods]: (p: EngineMethods[M][0]) => EngineMethods[M][1] | Promise<EngineMethods[M][1]> };

const handlers: Handlers = {
  async open({ bytes }) {
    const data = new Uint8Array(bytes);
    const { image, info } = await decodeAny(data);
    const handle = nextHandle++;
    images.set(handle, { image, source: info.format, proxies: new Map() });
    return { handle, info, hasTransparency: image.hasTransparency(), metadata: safeMetadata(data) };
  },
  inspect({ bytes }) {
    const data = new Uint8Array(bytes);
    return { info: inspectAny(data), metadata: safeMetadata(data) };
  },
  render({ handle, ops, output, overlays, target }) {
    const e = entry(handle);
    return renderOutput(e.image, e.source, ops, output, overlays, target);
  },
  preview({ handle, ops, maxSide, overlays }) {
    const e = entry(handle);
    let proxy = e.proxies.get(maxSide);
    if (!proxy) {
      proxy = e.image.thumbnail(maxSide);
      e.proxies.set(maxSide, proxy);
    }
    const px = applyOverlays(proxy.renderRgba(ops), overlays ?? []);
    return { pixels: transferableBuffer(px.pixels), width: px.width, height: px.height };
  },
  async setLogo({ id, bytes }) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    logos.get(id)?.close();
    logos.set(id, bitmap);
    return { width: bitmap.width, height: bitmap.height };
  },
  close({ handle }) {
    const e = images.get(handle);
    e?.proxies.forEach((p) => p.dispose());
    e?.image.dispose();
    images.delete(handle);
  },
  async process({ bytes, ops, output, overlays, target, strip }) {
    const data = new Uint8Array(bytes);
    if (strip) {
      // Metadata only: the image data is copied unchanged.
      const sourceInfo = inspectAny(data);
      const out = stripMetadata(data, strip);
      const format = sourceInfo.format as ImageFormat;
      return {
        bytes: transferableBuffer(out),
        format,
        mimeType: FORMATS[format].mimeType,
        extension: FORMATS[format].extension,
        width: sourceInfo.width,
        height: sourceInfo.height,
        sourceInfo,
        lossless: true,
      };
    }
    const { image, info } = await decodeAny(data);
    try {
      const r = await renderOutput(image, info.format, ops, output, overlays, target);
      return { ...r, sourceInfo: info, lossless: false };
    } finally {
      image.dispose();
    }
  },
};

serve<EngineMethods>(
  handlers,
  (err) => {
    const e = toEngineError(err);
    return { code: e.code, message: e.message };
  },
  ready,
);
