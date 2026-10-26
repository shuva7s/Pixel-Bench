import type { Operation } from "@image-tools/engine/shared";
import { zipSync } from "fflate";

import { uniqueNames } from "./files";

/** Mirrors the Rust engine's DEFAULT_LIMITS.max_side (the engine re-validates). */
export const MAX_OUTPUT_SIDE = 20_000;

export interface BatchResize {
  enabled: boolean;
  mode: "fit" | "percent";
  maxWidth: number;
  maxHeight: number;
  allowUpscale: boolean;
  percent: number;
}

export const DEFAULT_BATCH_RESIZE: BatchResize = {
  enabled: false,
  mode: "fit",
  maxWidth: 1920,
  maxHeight: 1920,
  allowUpscale: false,
  percent: 50,
};

export function batchOps(r: BatchResize): { ops: Operation[] } | { error: string } {
  if (!r.enabled) return { ops: [] };
  if (r.mode === "percent") {
    if (!Number.isFinite(r.percent) || r.percent <= 0 || r.percent > 400) return { error: "Scale must be between 1% and 400%." };
    return { ops: [{ op: "resize", size: { mode: "percent", percent: r.percent }, filter: "lanczos3" }] };
  }
  const ok = (v: number) => Number.isInteger(v) && v >= 1 && v <= MAX_OUTPUT_SIDE;
  if (!ok(r.maxWidth) || !ok(r.maxHeight)) {
    return { error: `Maximum width and height must be whole numbers from 1 to ${MAX_OUTPUT_SIDE.toLocaleString()}.` };
  }
  return {
    ops: [
      {
        op: "resize",
        size: { mode: "fit", maxWidth: r.maxWidth, maxHeight: r.maxHeight, allowUpscale: r.allowUpscale },
        filter: "lanczos3",
      },
    ],
  };
}

/** Builds an uncompressed ZIP (images are already compressed). */
export async function buildZip(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const names = uniqueNames(files.map((f) => f.name));
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (let i = 0; i < files.length; i++) {
    entries[names[i]!] = [new Uint8Array(await files[i]!.blob.arrayBuffer()), { level: 0 }];
  }
  const zipped = zipSync(entries);
  return new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}
