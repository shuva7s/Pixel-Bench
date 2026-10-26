/**
 * Bounded search for an output size target. The encoder is injected, so the
 * same logic drives JPEG, lossy WebP, AVIF and lossless formats.
 *
 * - "atMost": the largest file that does not exceed the target (the usual
 *   "compress below 200 KB" case).
 * - "atLeast": the smallest file that reaches the target (some upload forms
 *   require a minimum size). Files are never padded with meaningless bytes;
 *   only quality and, if allowed, dimensions are increased.
 */

export type TargetMode = "atMost" | "atLeast";

export interface TargetSpec {
  bytes: number;
  mode: TargetMode;
  /** Allow changing dimensions when quality alone cannot reach the target. */
  allowResize: boolean;
}

export interface TargetResult {
  bytes: Uint8Array;
  quality: number;
  /** Linear scale applied to both sides (1 = unchanged). */
  scale: number;
  met: boolean;
  /** Plain-language explanation when the target was not met. */
  reason?: string;
  attempts: number;
}

export type EncodeAt = (quality: number, scale: number) => Promise<Uint8Array>;

/** Total encodes allowed (each can take seconds on large images). */
export const MAX_ATTEMPTS = 16;
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;

export async function fitToTarget(encodeAt: EncodeAt, spec: TargetSpec, lossy: boolean, maxScale = MAX_SCALE): Promise<TargetResult> {
  if (!Number.isFinite(spec.bytes) || spec.bytes <= 0) throw new Error("The target size must be greater than 0.");
  const atMost = spec.mode === "atMost";
  let attempts = 0;
  const cache = new Map<string, Uint8Array>();
  const keyOf = (q: number, s: number) => `${q}@${s.toFixed(4)}`;
  const run = async (q: number, s: number) => {
    const hit = cache.get(keyOf(q, s));
    if (hit) return hit;
    attempts++;
    const out = await encodeAt(q, s);
    cache.set(keyOf(q, s), out);
    return out;
  };
  const ok = (size: number) => (atMost ? size <= spec.bytes : size >= spec.bytes);
  const result = (bytes: Uint8Array, quality: number, scale: number, reason?: string): TargetResult => ({
    bytes,
    quality,
    scale,
    met: ok(bytes.length),
    reason: ok(bytes.length) ? undefined : reason,
    attempts,
  });

  // The quality that gives the most room: lowest when shrinking, highest when growing.
  const extremeQ = lossy ? (atMost ? 1 : 100) : 100;

  /** Best quality at `scale` for the target, by binary search. */
  const searchQuality = async (scale: number) => {
    let lo = 1;
    let hi = 100;
    let best: { q: number; out: Uint8Array } | null = null;
    let closest: { q: number; out: Uint8Array } | null = null;
    const consider = (q: number, out: Uint8Array) => {
      if (!closest || Math.abs(out.length - spec.bytes) < Math.abs(closest.out.length - spec.bytes)) closest = { q, out };
      if (ok(out.length) && (!best || (atMost ? q > best.q : q < best.q))) best = { q, out };
    };
    while (lo <= hi && attempts < MAX_ATTEMPTS) {
      const q = Math.round((lo + hi) / 2);
      const out = await run(q, scale);
      consider(q, out);
      // Size grows with quality.
      if (atMost === ok(out.length)) lo = q + 1;
      else hi = q - 1;
    }
    // An already-measured extreme quality is a valid answer if the budget ran out.
    const extreme = cache.get(keyOf(extremeQ, scale));
    if (extreme) consider(extremeQ, extreme);
    return { best: best as { q: number; out: Uint8Array } | null, closest: closest! };
  };

  /**
   * Finds a scale at which `quality` meets the target. Learns how size grows
   * with scale (size ∝ scale^k) from the measurements instead of assuming k = 2:
   * upscaled images, for example, compress better than their pixel count suggests.
   */
  const searchScale = async (quality: number): Promise<number | null> => {
    const points = [{ s: 1, size: (await run(quality, 1)).length }];
    if (ok(points[0]!.size)) return 1;
    for (let round = 0; round < 6 && attempts < MAX_ATTEMPTS; round++) {
      const last = points.at(-1)!;
      let k = 2;
      const prev = points.at(-2);
      if (prev) {
        const measured = Math.log(last.size / prev.size) / Math.log(last.s / prev.s);
        if (Number.isFinite(measured) && measured > 0.3) k = measured;
      }
      const guess = last.s * (spec.bytes / last.size) ** (1 / k) * (atMost ? 0.97 : 1.03);
      const next = Math.min(maxScale, Math.max(MIN_SCALE, guess));
      if (Math.abs(next - last.s) < 1e-3) break;
      const size = (await run(quality, next)).length;
      points.push({ s: next, size });
      if (ok(size)) return next;
    }
    return null;
  };

  if (lossy) {
    let { best, closest } = await searchQuality(1);
    let scale = 1;
    if (!best && spec.allowResize) {
      const found = await searchScale(extremeQ);
      if (found !== null) {
        scale = found;
        ({ best, closest } = await searchQuality(scale));
      }
    }
    if (best) return result(best.out, best.q, scale);
    return result(
      closest.out,
      closest.q,
      scale,
      atMost
        ? spec.allowResize
          ? "Even the lowest quality at the smallest allowed size is above the target."
          : "Even the lowest quality is above the target. Allow resizing to go smaller."
        : spec.allowResize
          ? "Even the highest quality at the largest allowed size is below the target."
          : "Even the highest quality is below the target. Allow enlarging to go bigger.",
    );
  }

  // Lossless formats have no quality: only dimensions can change.
  const scale = spec.allowResize ? ((await searchScale(100)) ?? null) : null;
  if (scale !== null) return result((await run(100, scale))!, 100, scale);
  const out = await run(100, 1);
  return result(
    out,
    100,
    1,
    spec.allowResize
      ? "The target could not be reached within the allowed size range."
      : "This format is lossless, so only resizing can change its size. Allow resizing, or choose JPEG, WebP or AVIF.",
  );
}

/** Parses "200", "200 KB", "1.5 MB" into bytes (KB = 1024 bytes). */
export function parseSize(value: number, unit: "KB" | "MB"): number {
  return Math.round(value * (unit === "MB" ? 1024 * 1024 : 1024));
}
