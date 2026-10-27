/**
 * Target file size settings. The search itself runs in the native engine
 * (crates/app-core/src/target.rs).
 */

export type TargetMode = "atMost" | "atLeast";

export interface TargetSpec {
  bytes: number;
  mode: TargetMode;
  /** Allow changing dimensions when quality alone cannot reach the target. */
  allowResize: boolean;
}

/** Parses "200", "200 KB", "1.5 MB" into bytes (KB = 1024 bytes). */
export function parseSize(value: number, unit: "KB" | "MB"): number {
  return Math.round(value * (unit === "MB" ? 1024 * 1024 : 1024));
}
