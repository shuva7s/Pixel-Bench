import { FORMATS, type ImageFormat } from "@/lib/shared";

/** Mirrors the Rust engine's DEFAULT_LIMITS.max_input_bytes. */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const MAX_BATCH_FILES = 200;

export const ACCEPT_ATTR =
  ".jpg,.jpeg,.jfif,.png,.webp,.bmp,.gif,.tif,.tiff,.ico,.avif,.heic,.heif,image/jpeg,image/png,image/webp,image/bmp,image/gif,image/tiff,image/x-icon,image/avif,image/heic,image/heif";

const KNOWN_IMAGE_EXT = /\.(jpe?g|jfif|png|webp|bmp|gif|tiff?|ico|avif|heic|heif)$/i;

/**
 * Cheap pre-checks before reading a file. The authoritative format check is
 * done by the engine from the file's magic bytes.
 */
export function precheckFile(file: File): string | null {
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_INPUT_BYTES) {
    return `"${file.name}" is ${formatBytes(file.size)}; the maximum is ${formatBytes(MAX_INPUT_BYTES)}.`;
  }
  const looksLikeImage = file.type.startsWith("image/") || KNOWN_IMAGE_EXT.test(file.name);
  if (!looksLikeImage) return `"${file.name}" does not look like an image file.`;
  return null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export interface SizeChange {
  /** Negative when the output is smaller. */
  percent: number;
  kind: "smaller" | "larger" | "same";
  label: string;
}

export function sizeChange(before: number, after: number): SizeChange {
  if (before <= 0) return { percent: 0, kind: "same", label: "—" };
  const percent = ((after - before) / before) * 100;
  const rounded = Math.abs(percent) < 0.05 ? 0 : percent;
  if (rounded === 0) return { percent: 0, kind: "same", label: "Same size" };
  const abs = Math.abs(rounded).toFixed(Math.abs(rounded) < 10 ? 1 : 0);
  return rounded < 0
    ? { percent: rounded, kind: "smaller", label: `${abs}% smaller` }
    : { percent: rounded, kind: "larger", label: `${abs}% larger` };
}

export function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  // Strip characters that are invalid in file names on common platforms.
  const cleaned = stem.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim();
  return cleaned || "image";
}

export function outputFileName(inputName: string, suffix: string, format: ImageFormat): string {
  return `${baseName(inputName)}${suffix ? `-${suffix}` : ""}.${FORMATS[format].extension}`;
}

/** Makes names unique within a set: "a.png", "a (2).png", ... */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf(".");
    const candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}
