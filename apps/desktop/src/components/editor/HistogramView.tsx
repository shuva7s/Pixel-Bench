"use client";

import { useEffect, useRef } from "react";

import type { Histogram } from "@/lib/editor";

const W = 256;
const H = 90;

/** RGB histogram drawn with additive blending, like Lightroom's. */
export function HistogramView({ histogram }: { histogram: Histogram | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (!histogram || histogram.total === 0) return;
    // Ignore the extreme bins when scaling so clipping spikes don't flatten the rest.
    let peak = 1;
    for (const ch of [histogram.r, histogram.g, histogram.b]) {
      for (let i = 1; i < 255; i++) peak = Math.max(peak, ch[i]!);
    }
    ctx.globalCompositeOperation = "lighter";
    const channels: [Uint32Array, string][] = [
      [histogram.r, "rgba(235,70,70,0.75)"],
      [histogram.g, "rgba(70,200,90,0.75)"],
      [histogram.b, "rgba(80,120,240,0.75)"],
    ];
    for (const [bins, color] of channels) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo(i, H - Math.min(1, bins[i]! / peak) * (H - 2));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }, [histogram]);

  const clippedShadows = histogram ? histogram.luma[0]! / Math.max(1, histogram.total) > 0.01 : false;
  const clippedHighlights = histogram ? histogram.luma[255]! / Math.max(1, histogram.total) > 0.01 : false;

  return (
    <div className="relative overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-foreground/10">
      <canvas ref={ref} width={W} height={H} className="block h-[90px] w-full" aria-label="Histogram" role="img" data-testid="histogram" />
      <span
        className={`absolute left-1.5 top-1.5 h-2 w-2 rounded-full ${clippedShadows ? "bg-sky-400" : "bg-white/15"}`}
        title={clippedShadows ? "Shadows are clipping" : "No shadow clipping"}
      />
      <span
        className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full ${clippedHighlights ? "bg-red-400" : "bg-white/15"}`}
        title={clippedHighlights ? "Highlights are clipping" : "No highlight clipping"}
      />
    </div>
  );
}
