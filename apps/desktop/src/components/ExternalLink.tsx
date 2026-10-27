"use client";

import type { ReactNode } from "react";

import { openExternal } from "@/lib/native/files";

/** A link that opens in the system browser instead of the app window. */
export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      className={className ?? "underline underline-offset-2"}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
