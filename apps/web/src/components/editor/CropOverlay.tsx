"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { clampRect, dragCorner, type Handle, type Rect } from "@/lib/crop";

type Drag = { kind: "move"; startX: number; startY: number; orig: Rect } | { kind: "corner"; handle: Handle };

const HANDLES: Handle[] = ["nw", "ne", "sw", "se"];
const HANDLE_POS: Record<Handle, string> = {
  nw: "-left-1.5 -top-1.5 cursor-nwse-resize",
  ne: "-right-1.5 -top-1.5 cursor-nesw-resize",
  sw: "-left-1.5 -bottom-1.5 cursor-nesw-resize",
  se: "-right-1.5 -bottom-1.5 cursor-nwse-resize",
};

/**
 * Crop box drawn over the preview. Coordinates are full-resolution pixels of
 * a `width x height` frame; the overlay itself is sized by its parent.
 */
export function CropOverlay({
  rect,
  width,
  height,
  ratio,
  onChange,
}: {
  rect: Rect;
  width: number;
  height: number;
  ratio: number | null;
  onChange: (r: Rect) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const toImage = (e: ReactPointerEvent) => {
    const b = boxRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * width, y: ((e.clientY - b.top) / b.height) * height };
  };

  const start = (e: ReactPointerEvent, d: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = d;
  };

  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toImage(e);
    if (d.kind === "move") {
      onChange(clampRect({ ...d.orig, x: d.orig.x + p.x - d.startX, y: d.orig.y + p.y - d.startY }, width, height));
    } else {
      onChange(dragCorner(rect, d.handle, p.x, p.y, ratio, width, height));
    }
  };

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  return (
    <div
      ref={boxRef}
      className="absolute inset-0 touch-none select-none overflow-hidden"
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      data-testid="crop-overlay"
    >
      <div
        className="absolute border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
        style={{ left: pct(rect.x, width), top: pct(rect.y, height), width: pct(rect.width, width), height: pct(rect.height, height) }}
      >
        <div
          role="presentation"
          className="absolute inset-0 cursor-move"
          onPointerDown={(e) => {
            const p = toImage(e);
            start(e, { kind: "move", startX: p.x, startY: p.y, orig: rect });
          }}
        />
        <div aria-hidden className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="border border-white/25" />
          ))}
        </div>
        {HANDLES.map((h) => (
          <div
            key={h}
            role="presentation"
            className={`absolute h-3.5 w-3.5 rounded-sm border border-black/30 bg-white ${HANDLE_POS[h]}`}
            onPointerDown={(e) => start(e, { kind: "corner", handle: h })}
          />
        ))}
      </div>
    </div>
  );
}
