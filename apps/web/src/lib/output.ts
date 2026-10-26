import {
  FORMATS,
  type ImageFormat,
  type OutputEncodeOptions,
  type PngCompression,
  type Rgb,
  type SourceFormat,
} from "@image-tools/engine/shared";

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

/** rav1e speed for each AVIF setting (1 = slowest/smallest, 10 = fastest). */
export const AVIF_SPEED: Record<AvifSpeed, number> = { fast: 10, balanced: 8, small: 6 };

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

/** `quality` overrides the setting (used by the target-size search). */
export function toEncodeOptions(settings: OutputSettings, source: SourceFormat, quality = settings.quality): OutputEncodeOptions {
  const format = resolveFormat(settings, source);
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const background = hexToRgb(settings.background);
  switch (format) {
    case "jpeg":
      return { format, quality: q, progressive: settings.progressive, background };
    case "png":
      return { format, compression: settings.pngCompression };
    case "webp":
      return settings.webpLossless ? { format } : { format, lossy: true, quality: q };
    case "avif":
      return { format, quality: q, speed: AVIF_SPEED[settings.avifSpeed] };
    case "bmp":
      return { format, background };
    case "gif":
    case "tiff":
    case "ico":
      return { format };
  }
}

/** True when the output will flatten transparency that the image actually has. */
export function willFlatten(settings: OutputSettings, source: SourceFormat, hasTransparency: boolean): boolean {
  return hasTransparency && !FORMATS[resolveFormat(settings, source)].supportsAlpha;
}
