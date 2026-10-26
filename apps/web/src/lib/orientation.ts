import type { Operation } from "@image-tools/engine/shared";

/**
 * An orientation as "optionally mirror horizontally, then rotate clockwise".
 * Every combination of quarter turns and flips reduces to one of these eight.
 */
export interface Orientation {
  rotate: 0 | 90 | 180 | 270;
  mirror: boolean;
}

export const IDENTITY: Orientation = { rotate: 0, mirror: false };

const norm = (deg: number) => (((deg % 360) + 360) % 360) as Orientation["rotate"];

/** Applies an action in screen space, i.e. to what the user currently sees. */
export function rotateBy(o: Orientation, degrees: 90 | 180 | 270): Orientation {
  return { rotate: norm(o.rotate + degrees), mirror: o.mirror };
}

export function flipHorizontal(o: Orientation): Orientation {
  // H∘R(θ) = R(−θ)∘H
  return { rotate: norm(-o.rotate), mirror: !o.mirror };
}

export function flipVertical(o: Orientation): Orientation {
  // V = R(180)∘H
  return { rotate: norm(180 - o.rotate), mirror: !o.mirror };
}

export function orientationOps(o: Orientation): Operation[] {
  const ops: Operation[] = [];
  if (o.mirror) ops.push({ op: "flip", direction: "horizontal" });
  if (o.rotate !== 0) ops.push({ op: "rotate", degrees: o.rotate });
  return ops;
}

export function orientedSize(o: Orientation, width: number, height: number): [number, number] {
  return o.rotate === 90 || o.rotate === 270 ? [height, width] : [width, height];
}
