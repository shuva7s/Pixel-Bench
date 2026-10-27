import { FORMATS, type ImageFormat, type PngCompression, type Rgb, type SourceFormat } from "@/lib/shared";

export type AvifSpeed = "fast" | "balanced" | "small";

export interface OutputSettings {
  /** "same" keeps the source format (HEIC, which cannot be written, becomes JPEG). */
  format: ImageFormat | "same";
  /** Quality for lossy output (JPEG, lossy WebP, AVIF), 1–100. */
  quality: number;
  progressive: boolean;
  pngCompression: PngCompression;
  /** WebP: lossless (exact pixels, bigger) or lossy (quality slider). */
  webpLossless: boolean;
  avifSpeed: AvifSpeed;
  /** `#rrggbb` used when transparency must be flattened. */
  background: string;
}

export const DEFAULT_OUTPUT: OutputSettings = {
  format: "same",
  quality: 90,
  progressive: false,
  pngCompression: "default",
  webpLossless: false,
  avifSpeed: "fast",
  background: "#ffffff",
};

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/** The format that will actually be written. */
export function resolveFormat(settings: OutputSettings, source: SourceFormat): ImageFormat {
  if (settings.format !== "same") return settings.format;
  return source === "heic" ? "jpeg" : source;
}

/** Whether the chosen output has a quality setting. */
export function isLossy(settings: OutputSettings, source: SourceFormat): boolean {
  const f = resolveFormat(settings, source);
  return f === "jpeg" || f === "avif" || (f === "webp" && !settings.webpLossless);
}

/** True when the output will flatten transparency that the image actually has. */
export function willFlatten(settings: OutputSettings, source: SourceFormat, hasTransparency: boolean): boolean {
  return hasTransparency && !FORMATS[resolveFormat(settings, source)].supportsAlpha;
}
