import type { BandValues, Develop, Operation, Padding } from "@/lib/shared";

import type { AspectKey, CustomAspect, Rect } from "./crop";
import { IDENTITY, orientationOps, orientedSize, type Orientation } from "./orientation";
import { hexToRgb } from "./output";
import { isEmptyOverlay, type Overlay } from "./overlay";

export type DevelopSettings = Required<Develop>;

const zeros = (): BandValues => [0, 0, 0, 0, 0, 0, 0, 0];

/** Neutral settings; must match `Develop::default()` in the Rust engine. */
export const DEFAULT_DEVELOP: DevelopSettings = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
  mixerHue: zeros(),
  mixerSaturation: zeros(),
  mixerLuminance: zeros(),
  monochrome: false,
  clarity: 0,
  blur: 0,
  sharpenAmount: 0,
  sharpenRadius: 1,
  vignette: 0,
  vignetteMidpoint: 50,
  grain: 0,
};

export interface EditState {
  orientation: Orientation;
  /** -45..45 degrees. */
  straighten: number;
  /** In oriented full-resolution pixels; null means the whole image. */
  crop: Rect | null;
  aspect: AspectKey;
  /** Used when `aspect` is "custom". */
  customAspect: CustomAspect;
  develop: DevelopSettings;
  frame: FrameSettings;
  overlays: Overlay[];
}

export type FrameRatio = "none" | "1:1" | "4:5" | "3:2" | "16:9" | "9:16";

/** Border and padding added around the finished image. */
export interface FrameSettings {
  /** Border width as a percentage of the image's short side (0 = none). */
  border: number;
  /** Extra padding so the result has this aspect ratio (no cropping). */
  ratio: FrameRatio;
  /** `#rrggbb`; `transparent` gives clear padding. */
  color: string;
  transparent: boolean;
}

export const DEFAULT_FRAME: FrameSettings = { border: 0, ratio: "none", color: "#ffffff", transparent: false };

const FRAME_RATIOS: Record<Exclude<FrameRatio, "none">, number> = { "1:1": 1, "4:5": 4 / 5, "3:2": 3 / 2, "16:9": 16 / 9, "9:16": 9 / 16 };

/**
 * Padding for a `w x h` image: a uniform border first, then extra space on
 * two sides so the result matches the requested ratio.
 */
export function framePadding(f: FrameSettings, w: number, h: number): Padding | null {
  const b = Math.round((Math.max(0, f.border) / 100) * Math.min(w, h));
  let [top, right, bottom, left] = [b, b, b, b];
  if (f.ratio !== "none") {
    const r = FRAME_RATIOS[f.ratio];
    const bw = w + 2 * b;
    const bh = h + 2 * b;
    if (bw / bh < r) {
      const extra = Math.round(bh * r) - bw;
      left += Math.floor(extra / 2);
      right += Math.ceil(extra / 2);
    } else if (bw / bh > r) {
      const extra = Math.round(bw / r) - bh;
      top += Math.floor(extra / 2);
      bottom += Math.ceil(extra / 2);
    }
  }
  if (top + right + bottom + left === 0) return null;
  const [cr, cg, cb] = hexToRgb(f.color);
  return { top, right, bottom, left, color: f.transparent ? [0, 0, 0, 0] : [cr, cg, cb, 255] };
}

export const INITIAL_EDIT: EditState = {
  orientation: IDENTITY,
  straighten: 0,
  crop: null,
  aspect: "free",
  customAspect: { width: 3, height: 2 },
  develop: DEFAULT_DEVELOP,
  frame: DEFAULT_FRAME,
  overlays: [],
};

export function isDevelopNeutral(d: DevelopSettings): boolean {
  return JSON.stringify(d) === JSON.stringify(DEFAULT_DEVELOP);
}

export function isEditNeutral(s: EditState): boolean {
  return (
    s.orientation.rotate === 0 &&
    !s.orientation.mirror &&
    s.straighten === 0 &&
    s.crop === null &&
    isDevelopNeutral(s.develop) &&
    framePadding(s.frame, 100, 100) === null &&
    s.overlays.every(isEmptyOverlay)
  );
}

/** Size of the image after rotation/flip (straighten keeps the size). */
export function frameSize(s: EditState, width: number, height: number): [number, number] {
  return orientedSize(s.orientation, width, height);
}

/** Size after crop, before the frame (border/padding). */
function contentSize(s: EditState, width: number, height: number): [number, number] {
  return s.crop ? [s.crop.width, s.crop.height] : frameSize(s, width, height);
}

/** Final output size of an edit, including border and padding. */
export function outputSize(s: EditState, width: number, height: number): [number, number] {
  const [w, h] = contentSize(s, width, height);
  const p = framePadding(s.frame, w, h);
  return p ? [w + p.left + p.right, h + p.top + p.bottom] : [w, h];
}

/**
 * Engine operations for an edit of a `width x height` source.
 * `cropping: true` shows the uncropped, unframed frame for the crop overlay.
 */
export function editOps(s: EditState, width: number, height: number, cropping = false): Operation[] {
  const ops: Operation[] = orientationOps(s.orientation);
  if (s.straighten !== 0) ops.push({ op: "straighten", degrees: s.straighten });
  if (!cropping && s.crop) ops.push({ op: "crop", ...s.crop });
  if (!isDevelopNeutral(s.develop)) ops.push({ op: "develop", ...s.develop });
  if (!cropping) {
    const [w, h] = contentSize(s, width, height);
    const p = framePadding(s.frame, w, h);
    if (p) ops.push({ op: "pad", ...p });
  }
  return ops;
}

/** Overlays to draw (none while cropping). */
export function editOverlays(s: EditState, cropping = false): Overlay[] {
  return cropping ? [] : s.overlays.filter((o) => !isEmptyOverlay(o));
}

// ---------------------------------------------------------------------------
// Undo / redo. Rapid changes (slider drags) are merged into one step: a step
// is committed when `commit` is dispatched or before undo/redo.
// ---------------------------------------------------------------------------

export interface History {
  past: EditState[];
  /** Last committed state (top of the undo stack). */
  committed: EditState;
  present: EditState;
  future: EditState[];
}

export type HistoryAction =
  { type: "set"; state: EditState } | { type: "commit" } | { type: "undo" } | { type: "redo" } | { type: "reset"; state: EditState };

const MAX_HISTORY = 100;

function commit(h: History): History {
  if (h.present === h.committed) return h;
  return { ...h, past: [...h.past, h.committed].slice(-MAX_HISTORY), committed: h.present };
}

export function historyReducer(h: History, a: HistoryAction): History {
  switch (a.type) {
    case "set":
      return { ...h, present: a.state, future: [] };
    case "commit":
      return commit(h);
    case "undo": {
      const c = commit(h);
      const prev = c.past.at(-1);
      if (!prev) return c;
      return { past: c.past.slice(0, -1), committed: prev, present: prev, future: [c.present, ...c.future] };
    }
    case "redo": {
      const c = commit(h);
      const [next, ...rest] = c.future;
      if (!next) return c;
      return { past: [...c.past, c.present], committed: next, present: next, future: rest };
    }
    case "reset":
      return { past: [], committed: a.state, present: a.state, future: [] };
  }
}

export const initialHistory = (state: EditState = INITIAL_EDIT): History => ({ past: [], committed: state, present: state, future: [] });

export const canUndo = (h: History) => h.past.length > 0 || h.present !== h.committed;
export const canRedo = (h: History) => h.future.length > 0;

// ---------------------------------------------------------------------------
// Histogram and Auto tone.
// ---------------------------------------------------------------------------

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  total: number;
}

export function computeHistogram(rgba: Uint8Array | Uint8ClampedArray): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]! === 0) continue;
    const R = rgba[i]!;
    const G = rgba[i + 1]!;
    const B = rgba[i + 2]!;
    r[R]!++;
    g[G]!++;
    b[B]!++;
    luma[(54 * R + 183 * G + 19 * B + 128) >> 8]!++;
    total++;
  }
  return { r, g, b, luma, total };
}

function percentile(bins: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += bins[i]!;
    if (acc >= target) return i;
  }
  return 255;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, step = 1) => Math.round(v / step) * step;

/**
 * Lightroom-style "Auto": derives light settings from the histogram of the
 * *unedited* image. Returns only the fields it sets; values stay editable.
 */
export function autoTone(h: Histogram): Partial<DevelopSettings> {
  if (h.total === 0) return {};
  let linSum = 0;
  for (let i = 0; i < 256; i++) linSum += h.luma[i]! * toLinear(i);
  const meanLin = Math.max(linSum / h.total, 1e-4);
  // Aim for a mid-grey average (sRGB ≈ 118, linear ≈ 0.18).
  const exposure = round(clamp(Math.log2(0.18 / meanLin) * 0.8, -1.5, 1.5), 0.05);
  const lo = percentile(h.luma, h.total, 0.005);
  const hi = percentile(h.luma, h.total, 0.995);
  const spread = hi - lo;
  return {
    exposure,
    contrast: round(clamp((180 - spread) / 6, -10, 30)),
    // Pull back highlights / open shadows when the exposure shift pushes them.
    highlights: round(clamp(exposure > 0 ? -40 * exposure - (hi > 245 ? 15 : 0) : hi > 245 ? -20 : 0, -60, 0)),
    shadows: round(clamp(exposure < 0 ? -30 * exposure : lo < 10 ? 15 : 0, 0, 50)),
    whites: round(clamp((245 - hi) / 2, -30, 40)),
    blacks: round(clamp((8 - lo) / 1.5, -40, 20)),
    vibrance: 10,
  };
}

// ---------------------------------------------------------------------------
// Presets: each sets only the fields it lists, like Lightroom presets.
// ---------------------------------------------------------------------------

export interface Preset {
  id: string;
  name: string;
  settings: Partial<DevelopSettings>;
}

export const PRESETS: Preset[] = [
  { id: "vivid", name: "Vivid", settings: { contrast: 15, vibrance: 35, saturation: 10, clarity: 15 } },
  { id: "soft", name: "Soft", settings: { contrast: -15, highlights: -20, shadows: 20, clarity: -15 } },
  { id: "warm", name: "Warm", settings: { temperature: 25, tint: 5, vibrance: 10 } },
  { id: "cool", name: "Cool", settings: { temperature: -25, tint: -3 } },
  { id: "matte", name: "Matte", settings: { contrast: -10, blacks: 35, saturation: -10 } },
  {
    id: "moody",
    name: "Moody",
    settings: { exposure: -0.3, contrast: 20, highlights: -30, shadows: -10, saturation: -20, temperature: -10, vignette: -30 },
  },
  { id: "vintage", name: "Vintage", settings: { temperature: 20, saturation: -25, blacks: 25, vignette: -25, grain: 20 } },
  { id: "bw", name: "B&W", settings: { monochrome: true, contrast: 20, clarity: 15 } },
  { id: "bw-soft", name: "B&W Soft", settings: { monochrome: true, contrast: -10, blacks: 15, grain: 15 } },
];
