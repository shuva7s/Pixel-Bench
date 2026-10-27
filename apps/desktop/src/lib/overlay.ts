/**
 * Text and image (logo) overlays. They are drawn by the native engine
 * (crates/app-core/src/overlay.rs); sizes are relative to the image, so
 * previews and exports look the same.
 */

export type Anchor = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";

export const ANCHORS: Anchor[] = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];

export type FontFamily = "sans" | "serif" | "mono" | "rounded";

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
