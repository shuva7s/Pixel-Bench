/// <reference lib="webworker" />
// Codecs that run in the engine worker but outside the main Rust engine:
// AVIF/HEIC decoding (browser decoder, or libheif for HEIC), lossy WebP
// (libwebp) and AVIF encoding (separate Rust module). Each is loaded only
// when first needed, so the common path stays small.

import { EngineError, type ImageInfo, type SourceFormat } from "@image-tools/engine/shared";

export interface Pixels {
  pixels: Uint8Array;
  width: number;
  height: number;
}

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);

/**
 * Identifies ISO-BMFF images the Rust engine cannot decode, from the `ftyp`
 * box. Returns null for anything else.
 */
export function sniffContainer(b: Uint8Array): { format: "avif" | "heic"; animated: boolean } | null {
  if (b.length < 16 || ascii(b, 4, 8) !== "ftyp") return null;
  const size = Math.min(b.length, new DataView(b.buffer, b.byteOffset).getUint32(0));
  const brands = [ascii(b, 8, 12)];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(b, i, i + 4));
  if (brands.includes("avis")) return { format: "avif", animated: true };
  if (brands.includes("avif")) return { format: "avif", animated: false };
  if (brands.some((x) => HEIC_BRANDS.has(x))) return { format: "heic", animated: brands.includes("hevs") || brands.includes("msf1") };
  if (brands.includes("mif1")) return { format: "heic", animated: false };
  return null;
}

/** Reads the first `ispe` (image spatial extent) box: the primary image size. */
function readIspe(b: Uint8Array): [number, number] | null {
  for (let i = 4; i + 16 <= b.length; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      const v = new DataView(b.buffer, b.byteOffset + i + 8, 8);
      return [v.getUint32(0), v.getUint32(4)];
    }
  }
  return null;
}

/** Header-level info for AVIF/HEIC without decoding pixels. */
export function inspectContainer(b: Uint8Array, kind: { format: "avif" | "heic"; animated: boolean }): ImageInfo {
  const [width, height] = readIspe(b) ?? [0, 0];
  if (!width || !height) throw new EngineError("DECODE_FAILED", `The ${kind.format.toUpperCase()} file has no readable image size.`);
  return {
    format: kind.format,
    mimeType: kind.format === "avif" ? "image/avif" : "image/heic",
    width,
    height,
    colorModel: "rgba",
    bitsPerChannel: 8,
    hasAlphaChannel: kind.format === "avif",
    orientationCorrected: false,
    animated: kind.animated,
    byteSize: b.length,
  };
}

/** Decodes with the browser's own decoder (AVIF everywhere; HEIC in Safari). */
async function decodeWithBrowser(bytes: Uint8Array, mime: string): Promise<Pixels> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    throw new EngineError("UNSUPPORTED_FORMAT", "This browser cannot decode this image format.");
  }
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), {
    colorSpaceConversion: "default",
    premultiplyAlpha: "none",
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
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
      fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/vendor/libheif.wasm`).then((r) => {
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

export type BrowserDecodable = Extract<SourceFormat, "avif" | "heic">;

// ---------------------------------------------------------------------------
// Encoders loaded on demand.
// ---------------------------------------------------------------------------

/** Lossy WebP via libwebp (BSD-3), loaded on first use. */
export async function encodeLossyWebp({ pixels, width, height }: Pixels, quality: number): Promise<Uint8Array> {
  if (width > 16383 || height > 16383) {
    throw new EngineError("TOO_LARGE", `WebP images can be at most 16383 px per side; this image is ${width}x${height}.`);
  }
  const { default: encode } = await import("@jsquash/webp/encode");
  const data = new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength), width, height);
  try {
    return new Uint8Array(await encode(data, { quality, method: 4 }));
  } catch (err) {
    throw new EngineError("ENCODE_FAILED", `WebP encoding failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** AVIF via the separate Rust module, loaded on first use. */
export async function encodeAvifPixels({ pixels, width, height }: Pixels, quality: number, speed: number): Promise<Uint8Array> {
  const { encodeAvif } = await import("@image-tools/engine/avif");
  return encodeAvif(pixels, width, height, quality, speed);
}
