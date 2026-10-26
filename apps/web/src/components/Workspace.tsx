import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Full-height two-pane layout: content on the left, a scrollable options
 * panel on the right. On small screens the left pane is stacked on top
 * (optionally pinned) and the options scroll below it.
 */
export function Workspace({ main, panel, pinMain = false }: { main: ReactNode; panel: ReactNode; pinMain?: boolean }) {
  return (
    <div className="flex flex-1 flex-col lg:h-[calc(100dvh-3.5rem)] lg:flex-none lg:flex-row lg:overflow-hidden">
      <section
        aria-label="Workspace"
        className={cn(
          "relative min-w-0 bg-muted lg:flex-1 lg:overflow-y-auto",
          pinMain && "sticky top-14 z-10 h-[50dvh] shrink-0 border-b lg:relative lg:top-auto lg:z-auto lg:h-auto lg:border-b-0",
        )}
      >
        {main}
      </section>
      <aside aria-label="Options" className="bg-background lg:w-[360px] lg:shrink-0 lg:overflow-y-auto lg:border-l">
        {panel}
      </aside>
    </div>
  );
}

/**
 * Fits a `width x height` box as large as possible inside its parent, which
 * must have a definite size. Uses container query units, so the box always
 * matches the image's aspect ratio and no padding is drawn around the image.
 */
export function FitBox({ width, height, children, className }: { width: number; height: number; children: ReactNode; className?: string }) {
  const ratio = width / height;
  const style: CSSProperties = {
    aspectRatio: `${width} / ${height}`,
    width: `min(100cqw, calc(100cqh * ${ratio}))`,
  };
  return (
    <div className="absolute inset-0 p-3 [container-type:size] sm:p-5">
      <div className="flex h-full w-full items-center justify-center">
        <div className={cn("checker relative shadow-sm", className)} style={style}>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Primary action pinned to the bottom of a scrolling panel. The background
 * fades from transparent to solid so the content scrolling underneath stays
 * visible, hinting that there is more below. Only the actions themselves
 * catch clicks; the faded area passes them through.
 */
export function StickyFooter({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none sticky bottom-0 z-10 mt-auto bg-linear-to-b from-transparent via-background/90 via-45% to-background px-4 pt-10 pb-4">
      <div className="pointer-events-auto flex flex-col gap-2">{children}</div>
    </div>
  );
}

/** Centered intro shown before any image is opened. */
export function EmptyState({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:py-16">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
