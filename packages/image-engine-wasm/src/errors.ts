import type { EngineErrorCode } from "./types";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

const KNOWN_CODES = new Set<string>([
  "EMPTY_INPUT",
  "UNSUPPORTED_FORMAT",
  "ANIMATED_NOT_SUPPORTED",
  "MULTI_PAGE_NOT_SUPPORTED",
  "DECODE_FAILED",
  "ENCODE_FAILED",
  "TOO_LARGE",
  "INVALID_DIMENSIONS",
  "INVALID_CROP",
  "INVALID_OPTIONS",
]);

/** Normalises anything thrown by the WASM module into an EngineError. */
export function toEngineError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) {
    return new EngineError("ENGINE_CRASHED", "The image engine ran out of memory or crashed. Try a smaller image.");
  }
  if (err instanceof Error && KNOWN_CODES.has(err.name)) {
    return new EngineError(err.name as EngineErrorCode, err.message);
  }
  return new EngineError("ENGINE_CRASHED", err instanceof Error ? err.message : String(err));
}
