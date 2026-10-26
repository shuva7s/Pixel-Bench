/**
 * Text and image (logo) overlays, drawn with a 2D canvas on top of the
 * engine's output. All sizes are relative to the image, so previews (on a
 * downscaled copy) and exports (full resolution) look the same.
 */

export type Anchor = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";

export const ANCHORS: Anchor[] = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];

export type FontFamily = "sans" | "serif" | "mono" | "rounded";

export const FONT_STACKS: Record<FontFamily, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  rounded: 'ui-rounded, "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif',
};

export interface TextOverlay {
  kind: "text";
  text: string;
  font: FontFamily;
  bold: boolean;
  /** Font size as a percentage of the image's short side. */
  size: number;
  color: string;
  /** 0–100. */
  opacity: number;
  anchor: Anchor;
  /** Distance from the edges as a percentage of the short side. */
  margin: number;
  shadow: boolean;
}

export interface ImageOverlay {
  kind: "image";
  /** Key of the logo bytes registered with the worker. */
  imageId: string;
  /** Logo width as a percentage of the image width. */
  width: number;
  opacity: number;
  anchor: Anchor;
  margin: number;
  /** Repeat the logo diagonally across the whole image. */
  tile: boolean;
}

export type Overlay = TextOverlay | ImageOverlay;

export const DEFAULT_TEXT: TextOverlay = {
  kind: "text",
  text: "",
  font: "sans",
  bold: true,
  size: 6,
  color: "#ffffff",
  opacity: 85,
  anchor: "bottom-right",
  margin: 3,
  shadow: true,
};

export const DEFAULT_LOGO: Omit<ImageOverlay, "imageId"> = {
  kind: "image",
  width: 20,
  opacity: 70,
  anchor: "bottom-right",
  margin: 3,
  tile: false,
};

/** True when an overlay would draw nothing. */
export function isEmptyOverlay(o: Overlay): boolean {
  return o.kind === "text" ? o.text.trim() === "" || o.opacity <= 0 : o.opacity <= 0 || o.width <= 0;
}

/** Top-left corner for an `ow x oh` box anchored inside a `w x h` image. */
export function placeBox(anchor: Anchor, w: number, h: number, ow: number, oh: number, margin: number): [number, number] {
  const col = anchor.endsWith("left") ? 0 : anchor.endsWith("right") ? 2 : 1;
  const row = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? 2 : 1;
  const x = col === 0 ? margin : col === 2 ? w - ow - margin : (w - ow) / 2;
  const y = row === 0 ? margin : row === 2 ? h - oh - margin : (h - oh) / 2;
  return [x, y];
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function drawText(ctx: Ctx, w: number, h: number, o: TextOverlay) {
  const short = Math.min(w, h);
  const size = Math.max(1, (o.size / 100) * short);
  const margin = (o.margin / 100) * short;
  ctx.save();
  ctx.font = `${o.bold ? "700" : "400"} ${size}px ${FONT_STACKS[o.font]}`;
  ctx.textBaseline = "top";
  ctx.globalAlpha = o.opacity / 100;
  const lines = o.text.split("\n");
  const lineHeight = size * 1.2;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const boxW = Math.max(...widths);
  const boxH = lineHeight * lines.length - (lineHeight - size);
  const [x, y] = placeBox(o.anchor, w, h, boxW, boxH, margin);
  const align = o.anchor.endsWith("left") ? 0 : o.anchor.endsWith("right") ? 1 : 0.5;
  if (o.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = size * 0.15;
    ctx.shadowOffsetY = size * 0.04;
  }
  ctx.fillStyle = o.color;
  lines.forEach((line, i) => ctx.fillText(line, x + (boxW - widths[i]!) * align, y + i * lineHeight));
  ctx.restore();
}

function drawImage(ctx: Ctx, w: number, h: number, o: ImageOverlay, logo: ImageBitmap | undefined) {
  if (!logo) return;
  const short = Math.min(w, h);
  const ow = Math.max(1, (o.width / 100) * w);
  const oh = ow * (logo.height / logo.width);
  ctx.save();
  ctx.globalAlpha = o.opacity / 100;
  if (o.tile) {
    // Diagonal repeating pattern across the whole image.
    const stepX = ow * 1.8;
    const stepY = oh * 2.2;
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 6);
    const reach = Math.hypot(w, h);
    for (let yy = -reach; yy < reach; yy += stepY) {
      const offset = (Math.round(yy / stepY) % 2) * (stepX / 2);
      for (let xx = -reach; xx < reach; xx += stepX) ctx.drawImage(logo, xx + offset, yy, ow, oh);
    }
  } else {
    const [x, y] = placeBox(o.anchor, w, h, ow, oh, (o.margin / 100) * short);
    ctx.drawImage(logo, x, y, ow, oh);
  }
  ctx.restore();
}

/** Draws every overlay in order onto `ctx`, which covers a `w x h` image. */
export function drawOverlays(ctx: Ctx, w: number, h: number, overlays: Overlay[], logos: Map<string, ImageBitmap>) {
  for (const o of overlays) {
    if (isEmptyOverlay(o)) continue;
    if (o.kind === "text") drawText(ctx, w, h, o);
    else drawImage(ctx, w, h, o, logos.get(o.imageId));
  }
}
