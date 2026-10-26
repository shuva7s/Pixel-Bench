import { describe, expect, it } from "vitest";

import { fitToTarget, MAX_ATTEMPTS, parseSize, type EncodeAt } from "./target";

/** A fake encoder whose size grows with quality and with pixel count. */
function fakeEncoder(baseAtQ100: number): { encode: EncodeAt; calls: () => number } {
  let n = 0;
  return {
    encode: async (q, s) => {
      n++;
      const size = Math.round(baseAtQ100 * (0.05 + 0.95 * (q / 100) ** 2) * s * s);
      return new Uint8Array(size);
    },
    calls: () => n,
  };
}

describe("target file size", () => {
  it("finds the highest quality under the target", async () => {
    const f = fakeEncoder(1_000_000);
    const r = await fitToTarget(f.encode, { bytes: 300_000, mode: "atMost", allowResize: false }, true);
    expect(r.met).toBe(true);
    expect(r.bytes.length).toBeLessThanOrEqual(300_000);
    expect(r.bytes.length).toBeGreaterThan(280_000); // close to the target, not needlessly small
    expect(r.scale).toBe(1);
    expect(f.calls()).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  it("reports honestly when quality alone cannot reach it", async () => {
    const f = fakeEncoder(1_000_000);
    const r = await fitToTarget(f.encode, { bytes: 10_000, mode: "atMost", allowResize: false }, true);
    expect(r.met).toBe(false);
    expect(r.quality).toBe(1);
    expect(r.reason).toMatch(/Allow resizing/);
  });

  it("shrinks dimensions when allowed", async () => {
    const f = fakeEncoder(1_000_000);
    const r = await fitToTarget(f.encode, { bytes: 10_000, mode: "atMost", allowResize: true }, true);
    expect(r.met).toBe(true);
    expect(r.scale).toBeLessThan(1);
    expect(r.bytes.length).toBeLessThanOrEqual(10_000);
  });

  it("reaches a minimum size with the lowest sufficient quality", async () => {
    const f = fakeEncoder(1_000_000);
    const r = await fitToTarget(f.encode, { bytes: 500_000, mode: "atLeast", allowResize: false }, true);
    expect(r.met).toBe(true);
    expect(r.bytes.length).toBeGreaterThanOrEqual(500_000);
    expect(r.bytes.length).toBeLessThan(540_000);
  });

  it("enlarges for a minimum size only when allowed, and never pads", async () => {
    const f = fakeEncoder(100_000);
    const no = await fitToTarget(f.encode, { bytes: 1_000_000, mode: "atLeast", allowResize: false }, true);
    expect(no.met).toBe(false);
    expect(no.bytes.length).toBe(100_000); // q100, unpadded
    const yes = await fitToTarget(f.encode, { bytes: 1_000_000, mode: "atLeast", allowResize: true }, true);
    expect(yes.met).toBe(true);
    expect(yes.scale).toBeGreaterThan(1);
  });

  it("learns how size grows with scale (upscaled images compress well)", async () => {
    // Size grows with scale^1.2 rather than scale^2, like smooth upscaled photos.
    const encode: EncodeAt = async (q, s) => new Uint8Array(Math.round(40_000 * (0.05 + 0.95 * (q / 100) ** 2) * s ** 1.2));
    // Needs ~3x enlargement: reachable within the 4x cap.
    const r = await fitToTarget(encode, { bytes: 150_000, mode: "atLeast", allowResize: true }, true);
    expect(r.met).toBe(true);
    expect(r.bytes.length).toBeGreaterThanOrEqual(150_000);
    expect(r.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
    // Would need ~5.4x: honestly reported as unreachable.
    const far = await fitToTarget(encode, { bytes: 300_000, mode: "atLeast", allowResize: true }, true);
    expect(far.met).toBe(false);
    expect(far.reason).toMatch(/largest allowed size/);
    const shrink = await fitToTarget(encode, { bytes: 1_000, mode: "atMost", allowResize: true }, true);
    expect(shrink.met).toBe(true);
    expect(shrink.bytes.length).toBeLessThanOrEqual(1_000);
  });

  it("lossless formats change size only through dimensions", async () => {
    const f = fakeEncoder(1_000_000);
    const no = await fitToTarget(f.encode, { bytes: 200_000, mode: "atMost", allowResize: false }, false);
    expect(no.met).toBe(false);
    expect(no.reason).toMatch(/lossless/);
    const yes = await fitToTarget(f.encode, { bytes: 200_000, mode: "atMost", allowResize: true }, false);
    expect(yes.met).toBe(true);
    expect(yes.quality).toBe(100);
  });

  it("rejects invalid targets and parses units", async () => {
    await expect(fitToTarget(fakeEncoder(1).encode, { bytes: 0, mode: "atMost", allowResize: false }, true)).rejects.toThrow();
    expect(parseSize(200, "KB")).toBe(204_800);
    expect(parseSize(1.5, "MB")).toBe(1_572_864);
  });
});
