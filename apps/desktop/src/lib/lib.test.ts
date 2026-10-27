import { describe, expect, it } from "vitest";

import { batchOps, DEFAULT_BATCH_RESIZE } from "./batch";
import {
  autoTone,
  canRedo,
  canUndo,
  computeHistogram,
  DEFAULT_DEVELOP,
  DEFAULT_FRAME,
  editOps,
  framePadding,
  historyReducer,
  initialHistory,
  INITIAL_EDIT,
  isEditNeutral,
  outputSize,
  PRESETS,
  type EditState,
} from "./editor";
import { aspectRatio, centeredRect, clampRect, dragCorner, isValidCustomAspect, validateRect } from "./crop";
import { baseName, formatBytes, outputFileName, precheckFile, sizeChange, uniqueNames } from "./files";
import { flipHorizontal, flipVertical, IDENTITY, orientationOps, orientedSize, rotateBy, type Orientation } from "./orientation";
import { DEFAULT_OUTPUT, hexToRgb, isLossy, resolveFormat, willFlatten } from "./output";
import { DEFAULT_TEXT, isEmptyOverlay } from "./overlay";
import { runPool } from "./pool";

describe("files", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatBytes(-1)).toBe("—");
  });

  it("reports honest size changes", () => {
    expect(sizeChange(1000, 500)).toMatchObject({ kind: "smaller", label: "50% smaller" });
    expect(sizeChange(1000, 1200)).toMatchObject({ kind: "larger", label: "20% larger" });
    expect(sizeChange(1000, 1000)).toMatchObject({ kind: "same" });
    expect(sizeChange(1000, 1095).label).toBe("9.5% larger");
  });

  it("builds safe output names", () => {
    expect(outputFileName("holiday.photo.JPG", "800x600", "webp")).toBe("holiday.photo-800x600.webp");
    expect(outputFileName("a.png", "", "jpeg")).toBe("a.jpg");
    expect(baseName("bad:na*me?.png")).toBe("bad_na_me_");
    expect(baseName(".png")).toBe(".png");
    expect(baseName("")).toBe("image");
  });

  it("deduplicates names case-insensitively", () => {
    expect(uniqueNames(["a.jpg", "A.jpg", "a.jpg", "b.jpg"])).toEqual(["a.jpg", "A (2).jpg", "a (3).jpg", "b.jpg"]);
  });

  it("prechecks files", () => {
    const f = (name: string, size: number, type = "") => new File([new Uint8Array(size)], name, { type });
    expect(precheckFile(f("a.png", 0))).toMatch(/empty/);
    expect(precheckFile(f("notes.txt", 10, "text/plain"))).toMatch(/does not look like an image/);
    expect(precheckFile(f("a.png", 10))).toBeNull();
    expect(precheckFile(f("blob", 10, "image/png"))).toBeNull();
  });
});

describe("output settings", () => {
  it("resolves 'same as original'", () => {
    // HEIC cannot be written: "same as original" becomes JPEG.
    expect(resolveFormat(DEFAULT_OUTPUT, "heic")).toBe("jpeg");
    expect(isLossy({ ...DEFAULT_OUTPUT, format: "png" }, "jpeg")).toBe(false);
    expect(isLossy({ ...DEFAULT_OUTPUT, format: "webp", webpLossless: true }, "jpeg")).toBe(false);
    expect(isLossy({ ...DEFAULT_OUTPUT, format: "avif" }, "jpeg")).toBe(true);
  });

  it("knows when transparency will be flattened", () => {
    expect(willFlatten({ ...DEFAULT_OUTPUT, format: "jpeg" }, "png", true)).toBe(true);
    expect(willFlatten({ ...DEFAULT_OUTPUT, format: "webp" }, "png", true)).toBe(false);
    expect(willFlatten({ ...DEFAULT_OUTPUT, format: "jpeg" }, "png", false)).toBe(false);
    expect(hexToRgb("garbage")).toEqual([255, 255, 255]);
  });
});

describe("orientation", () => {
  // Reference: apply ops to a labelled 2x1 grid and compare pixel layouts.
  type Grid = string[][];
  const apply = (g: Grid, o: Orientation): Grid => {
    let out = g.map((r) => [...r]);
    for (const op of orientationOps(o)) {
      if (op.op === "flip") out = out.map((r) => [...r].reverse());
      if (op.op === "rotate") for (let i = 0; i < op.degrees / 90; i++) out = out[0]!.map((_, c) => out.map((r) => r[c]!).reverse());
    }
    return out;
  };
  const rot90 = (g: Grid) => g[0]!.map((_, c) => g.map((r) => r[c]!).reverse());
  const flipH = (g: Grid) => g.map((r) => [...r].reverse());
  const flipV = (g: Grid) => [...g].reverse();
  const src: Grid = [
    ["a", "b", "c"],
    ["d", "e", "f"],
  ];

  it("composes screen-space actions correctly", () => {
    const sequences: [string, (o: Orientation) => Orientation, (g: Grid) => Grid][] = [
      ["r90", (o) => rotateBy(o, 90), rot90],
      ["h", flipHorizontal, flipH],
      ["v", flipVertical, flipV],
      ["r270", (o) => rotateBy(o, 270), (g) => rot90(rot90(rot90(g)))],
    ];
    // Every sequence of up to three actions must match direct application.
    for (const a of sequences)
      for (const b of sequences)
        for (const c of sequences) {
          let o = IDENTITY;
          let g = src;
          for (const [, act, ref] of [a, b, c]) {
            o = act(o);
            g = ref(g);
          }
          expect(apply(src, o), `${a[0]},${b[0]},${c[0]}`).toEqual(g);
        }
  });

  it("reports oriented size", () => {
    expect(orientedSize({ rotate: 90, mirror: false }, 4, 3)).toEqual([3, 4]);
    expect(orientedSize({ rotate: 180, mirror: true }, 4, 3)).toEqual([4, 3]);
    expect(orientationOps(IDENTITY)).toEqual([]);
  });
});

describe("crop geometry", () => {
  it("centres aspect rectangles", () => {
    expect(centeredRect(1, 400, 200)).toEqual({ x: 100, y: 0, width: 200, height: 200 });
    expect(centeredRect(16 / 9, 1000, 1000)).toEqual({ x: 0, y: 218, width: 1000, height: 563 });
    expect(centeredRect(null, 10, 20)).toEqual({ x: 0, y: 0, width: 10, height: 20 });
  });

  it("supports custom aspect ratios and rejects invalid ones", () => {
    expect(aspectRatio("custom", 100, 100, { width: 2.39, height: 1 })).toBeCloseTo(2.39);
    expect(centeredRect(aspectRatio("custom", 1000, 1000, { width: 5, height: 4 }), 1000, 1000)).toEqual({
      x: 0,
      y: 100,
      width: 1000,
      height: 800,
    });
    for (const bad of [
      { width: 0, height: 1 },
      { width: -2, height: 1 },
      { width: NaN, height: 1 },
      { width: 1, height: 101 },
    ]) {
      expect(isValidCustomAspect(bad)).toBe(false);
      expect(aspectRatio("custom", 100, 100, bad)).toBeNull();
    }
    expect(aspectRatio("custom", 100, 100)).toBeNull();
  });

  it("clamps and validates", () => {
    expect(clampRect({ x: -5, y: 90, width: 50, height: 50 }, 100, 100)).toEqual({ x: 0, y: 50, width: 50, height: 50 });
    expect(validateRect({ x: 0, y: 0, width: 100, height: 100 }, 100, 100)).toBeNull();
    expect(validateRect({ x: 1, y: 0, width: 100, height: 100 }, 100, 100)).toMatch(/inside/);
    expect(validateRect({ x: 0, y: 0, width: 0, height: 10 }, 100, 100)).toMatch(/1 × 1/);
    expect(validateRect({ x: 0.5, y: 0, width: 10, height: 10 }, 100, 100)).toMatch(/whole/);
    expect(validateRect({ x: NaN, y: 0, width: 10, height: 10 }, 100, 100)).toMatch(/whole/);
  });

  it("drags corners within bounds and keeps ratios", () => {
    const r = { x: 10, y: 10, width: 20, height: 20 };
    expect(dragCorner(r, "se", 60, 50, null, 100, 100)).toEqual({ x: 10, y: 10, width: 50, height: 40 });
    expect(dragCorner(r, "se", 500, 500, null, 100, 100)).toEqual({ x: 10, y: 10, width: 90, height: 90 });
    const sq = dragCorner(r, "se", 90, 40, 1, 100, 100);
    expect(sq.width).toBe(sq.height);
    const wide = dragCorner(r, "nw", -50, -50, 2, 100, 100);
    expect(wide.x).toBeGreaterThanOrEqual(0);
    expect(wide.width / wide.height).toBeCloseTo(2, 0);
  });
});

describe("batch", () => {
  it("builds resize ops", () => {
    expect(batchOps(DEFAULT_BATCH_RESIZE)).toEqual({ ops: [] });
    expect(batchOps({ ...DEFAULT_BATCH_RESIZE, enabled: true })).toMatchObject({
      ops: [{ op: "resize", size: { mode: "fit", maxWidth: 1920 } }],
    });
    expect(batchOps({ ...DEFAULT_BATCH_RESIZE, enabled: true, maxWidth: 0 })).toHaveProperty("error");
    expect(batchOps({ ...DEFAULT_BATCH_RESIZE, enabled: true, mode: "percent", percent: 0 })).toHaveProperty("error");
  });

  it("pool bounds concurrency and isolates failures", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (n === 3) throw new Error("boom");
      done.push(n);
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 4, 5, 6, 7]);
  });

  it("pool stops starting work when aborted", async () => {
    const ctl = new AbortController();
    const started: number[] = [];
    await runPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n);
        if (n === 2) ctl.abort();
      },
      ctl.signal,
    );
    expect(started).toEqual([1, 2]);
  });
});

describe("editor", () => {
  it("builds engine ops in pipeline order and skips neutral steps", () => {
    expect(editOps(INITIAL_EDIT, 400, 300)).toEqual([]);
    const s: EditState = {
      ...INITIAL_EDIT,
      orientation: { rotate: 90, mirror: true },
      straighten: 2.5,
      crop: { x: 1, y: 2, width: 30, height: 40 },
      develop: { ...DEFAULT_DEVELOP, exposure: 0.5 },
      frame: { ...DEFAULT_FRAME, border: 10 },
    };
    const ops = editOps(s, 400, 300);
    expect(ops.map((o) => o.op)).toEqual(["flip", "rotate", "straighten", "crop", "develop", "pad"]);
    // While cropping: no crop and no frame, so coordinates refer to the frame.
    expect(editOps(s, 400, 300, true).map((o) => o.op)).toEqual(["flip", "rotate", "straighten", "develop"]);
    expect(outputSize(s, 400, 300)).toEqual([36, 46]); // 30x40 + 3 px border each side
    expect(outputSize({ ...s, crop: null, frame: DEFAULT_FRAME }, 400, 300)).toEqual([300, 400]);
    expect(isEditNeutral(INITIAL_EDIT)).toBe(true);
    expect(isEditNeutral(s)).toBe(false);
    expect(isEditNeutral({ ...INITIAL_EDIT, overlays: [{ ...DEFAULT_TEXT, text: "  " }] })).toBe(true);
    expect(isEditNeutral({ ...INITIAL_EDIT, overlays: [{ ...DEFAULT_TEXT, text: "Hi" }] })).toBe(false);
  });

  it("pads to a ratio without cropping", () => {
    // 400x300 to square: 50 px above and below.
    expect(framePadding({ ...DEFAULT_FRAME, ratio: "1:1" }, 400, 300)).toMatchObject({ top: 50, bottom: 50, left: 0, right: 0 });
    // Portrait 300x400 to 16:9: wide padding left and right.
    const p = framePadding({ ...DEFAULT_FRAME, ratio: "16:9" }, 300, 400)!;
    expect(p.top + p.bottom).toBe(0);
    expect((300 + p.left + p.right) / 400).toBeCloseTo(16 / 9, 2);
    // Border plus ratio; transparent colour.
    const q = framePadding({ border: 5, ratio: "1:1", color: "#ff0000", transparent: true }, 200, 100)!;
    expect(200 + q.left + q.right).toBe(100 + q.top + q.bottom);
    expect(q.color).toEqual([0, 0, 0, 0]);
    expect(framePadding(DEFAULT_FRAME, 10, 10)).toBeNull();
    expect(framePadding({ ...DEFAULT_FRAME, ratio: "1:1" }, 50, 50)).toBeNull();
  });

  it("treats invisible overlays as empty", () => {
    expect(isEmptyOverlay({ ...DEFAULT_TEXT, text: "x", opacity: 0 })).toBe(true);
    expect(isEmptyOverlay({ ...DEFAULT_TEXT, text: "  " })).toBe(true);
    expect(isEmptyOverlay({ ...DEFAULT_TEXT, text: "©" })).toBe(false);
  });

  it("merges rapid changes into one undo step and supports redo", () => {
    const a = { ...INITIAL_EDIT, straighten: 1 };
    const b = { ...INITIAL_EDIT, straighten: 2 };
    let h = initialHistory();
    expect(canUndo(h)).toBe(false);
    // A slider drag: several sets, then one commit.
    h = historyReducer(h, { type: "set", state: a });
    h = historyReducer(h, { type: "set", state: b });
    expect(canUndo(h)).toBe(true);
    h = historyReducer(h, { type: "commit" });
    expect(h.past).toHaveLength(1);
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toBe(INITIAL_EDIT);
    expect(canRedo(h)).toBe(true);
    h = historyReducer(h, { type: "redo" });
    expect(h.present).toBe(b);
    // Undo before the debounce commits still works.
    h = historyReducer(h, { type: "set", state: a });
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toBe(b);
    // A new change clears the redo stack.
    h = historyReducer(h, { type: "set", state: INITIAL_EDIT });
    expect(canRedo(h)).toBe(false);
  });

  it("computes histograms and ignores transparent pixels", () => {
    const h = computeHistogram(new Uint8Array([255, 0, 0, 255, 10, 10, 10, 255, 99, 99, 99, 0]));
    expect(h.total).toBe(2);
    expect(h.r[255]).toBe(1);
    expect(h.g[0]).toBe(1);
    expect(h.luma[10]).toBe(1);
  });

  it("auto brightens dark images and darkens bright ones", () => {
    const flat = (v: number) => computeHistogram(new Uint8Array(Array.from({ length: 400 }, (_, i) => (i % 4 === 3 ? 255 : v))));
    const dark = autoTone(flat(30));
    const bright = autoTone(flat(230));
    expect(dark.exposure!).toBeGreaterThan(0.5);
    expect(bright.exposure!).toBeLessThan(0);
    for (const k of ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"] as const) {
      expect(Number.isFinite(dark[k] as number)).toBe(true);
    }
    expect(Math.abs(dark.exposure!)).toBeLessThanOrEqual(1.5);
    expect(autoTone(computeHistogram(new Uint8Array()))).toEqual({});
  });

  it("presets only use valid develop fields and ranges", () => {
    for (const p of PRESETS) {
      for (const [k, v] of Object.entries(p.settings)) {
        expect(k in DEFAULT_DEVELOP, `${p.id}.${k}`).toBe(true);
        if (typeof v === "number") expect(Math.abs(v)).toBeLessThanOrEqual(k === "exposure" ? 5 : 100);
      }
    }
  });
});
