// AVIF encoder (Rust rav1e via ravif), shipped as a separate WASM module so
// it is only downloaded when AVIF output is actually chosen.
import init, { encodeAvif as rawEncodeAvif, initSync } from "../pkg/avif/avif_encoder.js";
import { toEngineError } from "./errors";

let ready: Promise<void> | null = null;

export function initAvif(): Promise<void> {
  ready ??= init().then(() => undefined);
  return ready;
}

/** Synchronous initialisation from already-loaded bytes (Node tests). */
export function initAvifSync(module: BufferSource | WebAssembly.Module): void {
  initSync({ module });
  ready = Promise.resolve();
}

/**
 * Encodes straight-alpha RGBA as AVIF. `quality` 1–100; `speed` 1 (slowest,
 * smallest) – 10 (fastest).
 */
export async function encodeAvif(rgba: Uint8Array, width: number, height: number, quality: number, speed: number): Promise<Uint8Array> {
  await initAvif();
  try {
    return rawEncodeAvif(rgba, width, height, quality, speed);
  } catch (err) {
    throw toEngineError(err);
  }
}
