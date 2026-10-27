// AI upscaling limits, mirrored from crates/ai/src/upscale.rs so the UI can
// warn before a file is processed.

export type UpscaleFactor = 2 | 4;

/** Output limit, matching the engine's 50 MP cap. */
export const MAX_OUTPUT_PIXELS = 50_000_000;

/** Why an upscale is not possible, or null when it is. */
export function upscaleProblem(width: number, height: number, factor: UpscaleFactor): string | null {
  const out = width * factor * (height * factor);
  if (out > MAX_OUTPUT_PIXELS) {
    return `The result would be ${(out / 1e6).toFixed(0)} MP, above the 50 MP limit. Try 2× or a smaller image.`;
  }
  return null;
}
