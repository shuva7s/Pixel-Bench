export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AspectKey = "free" | "original" | "1:1" | "4:3" | "3:2" | "16:9" | "4:5" | "9:16" | "custom";

/** A user-entered ratio such as 2.39 : 1. */
export interface CustomAspect {
  width: number;
  height: number;
}

export const ASPECTS: { key: AspectKey; label: string }[] = [
  { key: "free", label: "Free" },
  { key: "original", label: "Original" },
  { key: "1:1", label: "1:1" },
  { key: "4:3", label: "4:3" },
  { key: "3:2", label: "3:2" },
  { key: "16:9", label: "16:9" },
  { key: "4:5", label: "4:5" },
  { key: "9:16", label: "9:16" },
  { key: "custom", label: "Custom" },
];

/** Largest value accepted on either side of a custom ratio. */
export const MAX_CUSTOM_ASPECT = 100;

/** True when both sides are finite, positive and within range. */
export function isValidCustomAspect(a: CustomAspect): boolean {
  return [a.width, a.height].every((v) => Number.isFinite(v) && v > 0 && v <= MAX_CUSTOM_ASPECT);
}

/** Width / height for an aspect key, or null for free-form (or an invalid custom ratio). */
export function aspectRatio(key: AspectKey, imgW: number, imgH: number, custom?: CustomAspect): number | null {
  if (key === "free") return null;
  if (key === "original") return imgW / imgH;
  if (key === "custom") return custom && isValidCustomAspect(custom) ? custom.width / custom.height : null;
  const [a, b] = key.split(":").map(Number) as [number, number];
  return a / b;
}

/** Largest centred rectangle with the given ratio inside the image. */
export function centeredRect(ratio: number | null, imgW: number, imgH: number): Rect {
  if (ratio === null) return { x: 0, y: 0, width: imgW, height: imgH };
  let width = imgW;
  let height = Math.round(imgW / ratio);
  if (height > imgH) {
    height = imgH;
    width = Math.round(imgH * ratio);
  }
  width = Math.max(1, Math.min(imgW, width));
  height = Math.max(1, Math.min(imgH, height));
  return { x: Math.floor((imgW - width) / 2), y: Math.floor((imgH - height) / 2), width, height };
}

/** Rounds to whole pixels and clamps the rectangle fully inside the image. */
export function clampRect(r: Rect, imgW: number, imgH: number): Rect {
  const width = Math.max(1, Math.min(imgW, Math.round(r.width)));
  const height = Math.max(1, Math.min(imgH, Math.round(r.height)));
  const x = Math.max(0, Math.min(imgW - width, Math.round(r.x)));
  const y = Math.max(0, Math.min(imgH - height, Math.round(r.y)));
  return { x, y, width, height };
}

export function validateRect(r: Rect, imgW: number, imgH: number): string | null {
  const vals = [r.x, r.y, r.width, r.height];
  if (vals.some((v) => !Number.isInteger(v))) return "Crop values must be whole numbers.";
  if (r.width < 1 || r.height < 1) return "The crop area must be at least 1 × 1 px.";
  if (r.x < 0 || r.y < 0 || r.x + r.width > imgW || r.y + r.height > imgH) {
    return `The crop area must stay inside the ${imgW} × ${imgH} image.`;
  }
  return null;
}

export type Handle = "nw" | "ne" | "sw" | "se";

/**
 * Moves one corner to (px, py) in image coordinates, keeping the opposite
 * corner fixed and respecting an optional aspect ratio and image bounds.
 */
export function dragCorner(r: Rect, handle: Handle, px: number, py: number, ratio: number | null, imgW: number, imgH: number): Rect {
  const anchorX = handle.includes("w") ? r.x + r.width : r.x;
  const anchorY = handle.includes("n") ? r.y + r.height : r.y;
  const cx = Math.max(0, Math.min(imgW, px));
  const cy = Math.max(0, Math.min(imgH, py));
  let w = Math.max(1, Math.abs(cx - anchorX));
  let h = Math.max(1, Math.abs(cy - anchorY));
  if (ratio !== null) {
    // Follow the dominant axis, then shrink to fit the available space.
    if (w / h > ratio) h = w / ratio;
    else w = h * ratio;
    const maxW = handle.includes("w") ? anchorX : imgW - anchorX;
    const maxH = handle.includes("n") ? anchorY : imgH - anchorY;
    const f = Math.min(1, maxW / w, maxH / h);
    w *= f;
    h *= f;
  }
  const x = handle.includes("w") ? anchorX - w : anchorX;
  const y = handle.includes("n") ? anchorY - h : anchorY;
  return clampRect({ x, y, width: w, height: h }, imgW, imgH);
}
