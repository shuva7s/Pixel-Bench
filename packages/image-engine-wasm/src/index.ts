import init, {
  initSync,
  EngineImage,
  inspect as rawInspect,
  inspectMetadata as rawInspectMetadata,
  limits as rawLimits,
  stripMetadata as rawStripMetadata,
  process as rawProcess,
  type EncodedOutput,
  type InitInput,
} from "../pkg/image_engine.js";
import { EngineError, toEngineError } from "./errors";
import {
  FORMATS,
  type EncodeOptions,
  type EncodedResult,
  type EngineLimits,
  type ImageFormat,
  type ImageInfo,
  type MetadataReport,
  type Operation,
} from "./types";

export * from "./shared";

function guard<T>(fn: () => T): T {
  if (!ready) throw new EngineError("ENGINE_NOT_READY", "The image engine has not been initialised.");
  try {
    return fn();
  } catch (err) {
    throw toEngineError(err);
  }
}

let ready = false;

/** Loads and instantiates the WASM module (browser: fetches the .wasm file). */
export async function initEngine(source?: InitInput | Promise<InitInput>): Promise<void> {
  if (ready) return;
  await init(source === undefined ? undefined : { module_or_path: source });
  ready = true;
}

/** Synchronous initialisation from already-loaded bytes (used in Node tests). */
export function initEngineSync(module: BufferSource | WebAssembly.Module): void {
  if (ready) return;
  initSync({ module });
  ready = true;
}

export function engineLimits(): EngineLimits {
  return guard(() => JSON.parse(rawLimits()) as EngineLimits);
}

/** Reads format, dimensions and colour layout from the header only. */
export function inspectImage(bytes: Uint8Array): ImageInfo {
  return guard(() => JSON.parse(rawInspect(bytes)) as ImageInfo);
}

/** EXIF fields and other metadata blocks in a file. */
export function inspectMetadata(bytes: Uint8Array): MetadataReport {
  return guard(() => JSON.parse(rawInspectMetadata(bytes)) as MetadataReport);
}

/**
 * Removes metadata without re-encoding (JPEG, PNG, WebP). Throws unless the
 * result is verifiably clean.
 */
export function stripMetadata(bytes: Uint8Array, opts: { keepOrientation: boolean; keepIcc: boolean }): Uint8Array {
  return guard(() => rawStripMetadata(bytes, opts.keepOrientation, opts.keepIcc));
}

function toResult(out: EncodedOutput): EncodedResult {
  try {
    const format = out.format as ImageFormat;
    const spec = FORMATS[format];
    return {
      bytes: out.takeBytes(),
      format,
      mimeType: spec.mimeType,
      extension: spec.extension,
      width: out.width,
      height: out.height,
    };
  } finally {
    out.free();
  }
}

/** One-shot decode → operations → encode. */
export function processImage(bytes: Uint8Array, ops: Operation[], encode: EncodeOptions): EncodedResult {
  return guard(() => toResult(rawProcess(bytes, JSON.stringify(ops), JSON.stringify(encode))));
}

export interface RgbaPixels {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/**
 * A decoded image held in WASM memory. Call `dispose()` when done; the
 * memory is not reclaimed by the JS garbage collector promptly.
 */
export class DecodedImage {
  #inner: EngineImage | null;

  private constructor(inner: EngineImage) {
    this.#inner = inner;
  }

  static decode(bytes: Uint8Array): DecodedImage {
    return guard(() => new DecodedImage(EngineImage.decode(bytes)));
  }

  /** Wraps straight-alpha RGBA pixels decoded elsewhere (e.g. by the browser). */
  static fromRgba(pixels: Uint8Array, width: number, height: number): DecodedImage {
    return guard(() => new DecodedImage(EngineImage.fromRgba(pixels, width, height)));
  }

  #get(): EngineImage {
    if (!this.#inner) throw new EngineError("ENGINE_NOT_READY", "This image has been disposed.");
    return this.#inner;
  }

  get width(): number {
    return this.#get().width;
  }
  get height(): number {
    return this.#get().height;
  }
  get format(): ImageFormat {
    return this.#get().format as ImageFormat;
  }
  hasTransparency(): boolean {
    return guard(() => this.#get().hasTransparency());
  }

  thumbnail(maxSide: number): DecodedImage {
    return guard(() => new DecodedImage(this.#get().thumbnail(maxSide)));
  }

  render(ops: Operation[], encode: EncodeOptions): EncodedResult {
    return guard(() => toResult(this.#get().render(JSON.stringify(ops), JSON.stringify(encode))));
  }

  renderRgba(ops: Operation[]): RgbaPixels {
    return guard(() => {
      const frame = this.#get().renderRgba(JSON.stringify(ops));
      try {
        return { pixels: frame.takePixels(), width: frame.width, height: frame.height };
      } finally {
        frame.free();
      }
    });
  }

  dispose(): void {
    this.#inner?.free();
    this.#inner = null;
  }
}
