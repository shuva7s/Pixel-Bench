import { describe, expect, it } from "vitest";

import { boxBlur, composite, refineMask, resizeMask, segmentInput, segmentOutput } from "./mask";
import { MODELS } from "./models";
import { MODEL_SCALE, placeTile, planTiles, tileInput, upscaleAlpha, upscaleProblem, type Tile } from "./upscale";

describe("segmentation pre/post-processing", () => {
  it("normalises BiRefNet input with x/255 and ImageNet stats, CHW", () => {
    const rgba = new Uint8Array([255, 0, 128, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const x = segmentInput(rgba, 2, "birefnet-lite");
    expect(x).toHaveLength(12);
    expect(x[0]).toBeCloseTo((1 - 0.485) / 0.229, 5); // R of pixel 0
    expect(x[4 + 1]).toBeCloseTo((1 - 0.456) / 0.224, 5); // G of pixel 1
    expect(x[8 + 2]).toBeCloseTo((0 - 0.406) / 0.225, 5); // B of pixel 2
  });

  it("divides U²-Net input by the image maximum", () => {
    const rgba = new Uint8Array([100, 50, 0, 255]);
    const x = segmentInput(rgba, 1, "u2netp");
    expect(x[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(x[1]).toBeCloseTo((0.5 - 0.456) / 0.224, 5);
  });

  it("maps logits through a sigmoid and U²-Net output through min-max", () => {
    expect(Array.from(segmentOutput(new Float32Array([-20, 0, 20]), "birefnet-lite"))).toEqual([0, 128, 255]);
    expect(Array.from(segmentOutput(new Float32Array([0.2, 0.6, 1.0]), "u2netp"))).toEqual([0, 128, 255]);
  });
});

describe("mask refinement", () => {
  const ramp = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));

  it("leaves the mask unchanged with neutral settings", () => {
    expect(refineMask(ramp, 256, 1, { hardness: 0, shift: 0, feather: 0 })).toEqual(ramp);
  });

  it("hardness 100 makes a near-binary cut around the midpoint", () => {
    const hard = refineMask(ramp, 256, 1, { hardness: 100, shift: 0, feather: 0 });
    expect(hard[100]).toBe(0);
    expect(hard[160]).toBe(255);
  });

  it("positive shift grows the subject, negative trims it", () => {
    const grow = refineMask(ramp, 256, 1, { hardness: 100, shift: 30, feather: 0 });
    const trim = refineMask(ramp, 256, 1, { hardness: 100, shift: -30, feather: 0 });
    expect(grow[100]).toBe(255);
    expect(trim[160]).toBe(0);
  });

  it("box blur preserves flat areas and softens a step", () => {
    const step = new Uint8Array(20).map((_, i) => (i < 10 ? 0 : 255));
    const out = boxBlur(step, 20, 1, 2);
    expect(out[0]).toBe(0);
    expect(out[19]).toBe(255);
    expect(out[9]).toBeGreaterThan(0);
    expect(out[10]).toBeLessThan(255);
  });

  it("resizes masks bilinearly", () => {
    const m = resizeMask(new Uint8Array([0, 255]), 2, 1, 4, 1);
    expect(m[0]).toBe(0);
    expect(m[3]).toBe(255);
    expect(m[1]).toBeGreaterThan(0);
  });
});

describe("composite", () => {
  const fg = new Uint8Array([200, 100, 50, 255, 10, 20, 30, 255]);
  const mask = new Uint8Array([255, 0]);

  it("transparent: copies colour and uses the mask as alpha", () => {
    expect(Array.from(composite(fg, mask, { kind: "transparent" }))).toEqual([200, 100, 50, 255, 10, 20, 30, 0]);
  });

  it("colour: blends over an opaque colour", () => {
    expect(Array.from(composite(fg, mask, { kind: "color", color: [0, 0, 255] }))).toEqual([200, 100, 50, 255, 0, 0, 255, 255]);
  });

  it("pixels: blends over another image", () => {
    const bg = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(Array.from(composite(fg, new Uint8Array([128, 0]), { kind: "pixels", pixels: bg })).slice(4)).toEqual([4, 5, 6, 255]);
  });
});

describe("tiled upscaling", () => {
  it("covers the image exactly once with clamped context", () => {
    const tiles = planTiles(500, 300, 192, 16);
    let area = 0;
    for (const t of tiles) {
      area += t.width * t.height;
      expect(t.inX).toBeGreaterThanOrEqual(0);
      expect(t.inX + t.inWidth).toBeLessThanOrEqual(500);
      expect(t.x - t.inX).toBeLessThanOrEqual(16);
    }
    expect(area).toBe(500 * 300);
    expect(tiles).toHaveLength(3 * 2);
  });

  it("assembles tiles into a seamless image (identity model)", () => {
    // A fake 4× model: nearest-neighbour enlargement. The assembled result must equal enlarging the whole image.
    const w = 7;
    const h = 5;
    const src = new Uint8Array(w * h * 4).map((_, i) => (i * 37) % 251);
    for (const factor of [2, 4] as const) {
      const out = new Uint8Array(w * factor * h * factor * 4);
      for (const t of planTiles(w, h, 3, 1)) placeTile(fakeModel(tileInput(src, w, t), t), t, out, w * factor, factor);
      for (let y = 0; y < h * factor; y++) {
        for (let x = 0; x < w * factor; x++) {
          const s = (Math.floor(y / factor) * w + Math.floor(x / factor)) * 4;
          const d = (y * w * factor + x) * 4;
          expect([out[d], out[d + 1], out[d + 2]]).toEqual([src[s], src[s + 1], src[s + 2]]);
        }
      }
    }
  });

  it("upscales alpha and enforces the output limit", () => {
    const src = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255]);
    const out = new Uint8Array(4 * 2 * 4);
    upscaleAlpha(src, 2, 1, out, 2);
    expect(out[3]).toBe(0);
    expect(out[15]).toBe(255);
    expect(upscaleProblem(2000, 1500, 4)).toBeNull(); // 48 MP
    expect(upscaleProblem(2000, 2000, 4)).toMatch(/50 MP/); // 64 MP
  });
});

function fakeModel(input: Float32Array, t: Tile): Float32Array {
  const w = t.inWidth * MODEL_SCALE;
  const h = t.inHeight * MODEL_SCALE;
  const out = new Float32Array(3 * w * h);
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        out[c * w * h + y * w + x] =
          input[c * t.inWidth * t.inHeight + Math.floor(y / MODEL_SCALE) * t.inWidth + Math.floor(x / MODEL_SCALE)]!;
  return out;
}

describe("model registry", () => {
  it("pins every model by size and SHA-256", () => {
    for (const m of Object.values(MODELS)) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.bytes).toBeGreaterThan(1_000_000);
      expect(m.licenseUrl).toMatch(/^\/models\/LICENSE-/);
    }
  });
});
