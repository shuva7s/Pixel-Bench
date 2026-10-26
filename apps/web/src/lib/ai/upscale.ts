// Tiled super-resolution helpers. The image is split into tiles with an
// overlapping margin; only each tile's core is kept, so seams fall where both
// neighbours saw the same context.

/** Real-ESRGAN x4v3 always upscales 4×; 2× is produced by averaging 2×2 blocks of the 4× result. */
export const MODEL_SCALE = 4;
export const TILE = 192;
export const TILE_PAD = 16;
/** Output limit, matching the engine's 50 MP cap. */
export const MAX_OUTPUT_PIXELS = 50_000_000;

export type UpscaleFactor = 2 | 4;

export interface Tile {
  /** Core region, in input pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Region fed to the model: the core plus up to TILE_PAD of context on each side. */
  inX: number;
  inY: number;
  inWidth: number;
  inHeight: number;
}

export function planTiles(width: number, height: number, tile = TILE, pad = TILE_PAD): Tile[] {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) {
      const w = Math.min(tile, width - x);
      const h = Math.min(tile, height - y);
      const inX = Math.max(0, x - pad);
      const inY = Math.max(0, y - pad);
      tiles.push({
        x,
        y,
        width: w,
        height: h,
        inX,
        inY,
        inWidth: Math.min(width, x + w + pad) - inX,
        inHeight: Math.min(height, y + h + pad) - inY,
      });
    }
  }
  return tiles;
}

/** Why an upscale is not possible, or null when it is. */
export function upscaleProblem(width: number, height: number, factor: UpscaleFactor): string | null {
  const out = width * factor * (height * factor);
  if (out > MAX_OUTPUT_PIXELS) {
    return `The result would be ${(out / 1e6).toFixed(0)} MP, above the 50 MP limit. Try 2× or a smaller image.`;
  }
  return null;
}

/** RGB of a region as a CHW float tensor in [0, 1]. */
export function tileInput(rgba: Uint8Array, width: number, t: Tile): Float32Array {
  const plane = t.inWidth * t.inHeight;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < t.inHeight; y++) {
    for (let x = 0; x < t.inWidth; x++) {
      const src = ((t.inY + y) * width + t.inX + x) * 4;
      const dst = y * t.inWidth + x;
      out[dst] = rgba[src]! / 255;
      out[plane + dst] = rgba[src + 1]! / 255;
      out[2 * plane + dst] = rgba[src + 2]! / 255;
    }
  }
  return out;
}

/**
 * Writes the core of a 4× model output into the result image (RGB only; alpha
 * is filled separately). For 2×, each 2×2 block is averaged.
 */
export function placeTile(model: Float32Array, t: Tile, out: Uint8Array, outWidth: number, factor: UpscaleFactor) {
  const mw = t.inWidth * MODEL_SCALE;
  const plane = mw * t.inHeight * MODEL_SCALE;
  const step = MODEL_SCALE / factor;
  const offX = (t.x - t.inX) * MODEL_SCALE;
  const offY = (t.y - t.inY) * MODEL_SCALE;
  const w = t.width * factor;
  const h = t.height * factor;
  const norm = 255 / (step * step);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dst = ((t.y * factor + y) * outWidth + t.x * factor + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < step; dy++) {
          const row = (offY + y * step + dy) * mw + offX + x * step;
          for (let dx = 0; dx < step; dx++) sum += Math.min(1, Math.max(0, model[c * plane + row + dx]!));
        }
        out[dst + c] = Math.round(sum * norm);
      }
    }
  }
}

/** Fills the alpha channel of `out` by bilinear upscaling of the source alpha (opaque images stay opaque). */
export function upscaleAlpha(src: Uint8Array, width: number, height: number, out: Uint8Array, factor: UpscaleFactor) {
  const ow = width * factor;
  const oh = height * factor;
  for (let y = 0; y < oh; y++) {
    const fy = Math.max(0, (y + 0.5) / factor - 0.5);
    const y0 = Math.min(height - 1, Math.floor(fy));
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < ow; x++) {
      const fx = Math.max(0, (x + 0.5) / factor - 0.5);
      const x0 = Math.min(width - 1, Math.floor(fx));
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      const a = (px: number, py: number) => src[(py * width + px) * 4 + 3]!;
      const top = a(x0, y0) * (1 - wx) + a(x1, y0) * wx;
      const bottom = a(x0, y1) * (1 - wx) + a(x1, y1) * wx;
      out[(y * ow + x) * 4 + 3] = Math.round(top * (1 - wy) + bottom * wy);
    }
  }
}
