// AVIF and HEIC decoding for the desktop app. The native engine has no
// decoder for these (the only ones are C libraries), so the app's web view
// decodes them (its system decoder, or libheif for HEIC) and the pixels go to
// Rust.

import { EngineError } from "@/lib/shared";

export interface Pixels {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/** Decodes with the system decoder of the web view (AVIF; HEIC on macOS). */
async function decodeWithBrowser(bytes: Uint8Array, mime: string): Promise<Pixels> {
  if (typeof createImageBitmap !== "function") {
    throw new EngineError("UNSUPPORTED_FORMAT", "This system cannot decode this image format.");
  }
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), {
    colorSpaceConversion: "default",
    premultiplyAlpha: "none",
  });
  try {
    const canvas =
      typeof OffscreenCanvas === "undefined"
        ? Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height })
        : new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new EngineError("DECODE_FAILED", "Could not create a canvas to decode the image.");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(target: { data: Uint8ClampedArray; width: number; height: number }, cb: (r: unknown) => void): void;
  free?(): void;
}
interface Libheif {
  HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] };
}

let libheif: Promise<Libheif> | null = null;

/** libheif (LGPL-3.0), served as a separate, unmodified file and loaded on demand. */
function loadLibheif(): Promise<Libheif> {
  libheif ??= (async () => {
    const [{ default: factory }, wasm] = await Promise.all([
      import("libheif-js/libheif-wasm/libheif.js") as Promise<{ default: (opts: { wasmBinary: ArrayBuffer }) => Libheif }>,
      fetch("/vendor/libheif.wasm").then((r) => {
        if (!r.ok) throw new EngineError("DECODE_FAILED", "Could not load the HEIC decoder.");
        return r.arrayBuffer();
      }),
    ]);
    const lib = factory({ wasmBinary: wasm });
    // Emscripten modules may expose a `ready` promise.
    const ready = (lib as unknown as { ready?: Promise<unknown> }).ready;
    if (ready) await ready;
    return lib;
  })();
  libheif.catch(() => (libheif = null));
  return libheif;
}

async function decodeHeicWithLibheif(bytes: Uint8Array): Promise<Pixels> {
  const lib = await loadLibheif();
  const images = new lib.HeifDecoder().decode(bytes);
  const image = images[0];
  if (!image) throw new EngineError("DECODE_FAILED", "The HEIC file contains no image.");
  const width = image.get_width();
  const height = image.get_height();
  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) =>
    image.display({ data, width, height }, (r) =>
      r ? resolve() : reject(new EngineError("DECODE_FAILED", "The HEIC image could not be decoded.")),
    ),
  );
  for (const img of images) img.free?.();
  return { pixels: new Uint8Array(data.buffer), width, height };
}

/** Decodes AVIF or HEIC to RGBA. */
export async function decodeContainer(bytes: Uint8Array, format: "avif" | "heic"): Promise<Pixels> {
  if (format === "avif") return decodeWithBrowser(bytes, "image/avif");
  try {
    return await decodeWithBrowser(bytes, "image/heic");
  } catch {
    return decodeHeicWithLibheif(bytes);
  }
}
