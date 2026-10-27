"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/edit/", label: "Editor", title: "Photo editor" },
  { href: "/utilities/", label: "Utilities", title: "Convert, compress & resize" },
  { href: "/remove-bg/", label: "Remove BG", title: "Remove background" },
  { href: "/about/", label: "Privacy", title: "Privacy & status" },
];

function Logo() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6 shrink-0">
      <rect x="2" y="2" width="20" height="20" rx="6" className="fill-primary" />
      <path d="M6 16l3.5-4.5 2.5 3 2-2.5L18 16z" className="fill-primary-foreground" />
      <circle cx="15.5" cy="8.5" r="1.8" className="fill-primary-foreground" />
    </svg>
  );
}

/** Top bar; shows the current tool's name next to the app name. */
export function AppHeader() {
  const pathname = usePathname();
  const current = SECTIONS.find((s) => pathname.startsWith(s.href.replace(/\/$/, "")));
  const Title = current?.href === "/about/" ? "p" : "h1";
  return (
    <header className="sticky top-0 z-30 h-14 shrink-0 border-b bg-background/90 backdrop-blur">
      <nav aria-label="Main" className="flex h-full items-center gap-3 px-4">
        <Link href="/" aria-label="Pixel Bench home" className="flex shrink-0 items-center gap-2 font-semibold">
          <Logo />
          <span className={cn("hidden", current ? "md:inline" : "sm:inline")}>Pixel Bench</span>
        </Link>
        {current ? (
          <>
            <span aria-hidden className="hidden text-muted-foreground sm:inline">
              /
            </span>
            {/* Tool pages have no other visible heading, so the title is their h1. */}
            {/* On phones the highlighted nav link shows the page, so the title is only read out. */}
            <Title className="sr-only min-w-0 truncate text-base font-medium sm:not-sr-only" data-testid="page-title">
              {current.title}
            </Title>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5 text-sm sm:gap-1">
          {SECTIONS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              aria-current={current?.href === s.href ? "page" : undefined}
              className={cn(
                "rounded-md px-2 py-1.5 whitespace-nowrap text-muted-foreground sm:px-2.5 transition-colors hover:bg-muted hover:text-foreground",
                current?.href === s.href && "bg-muted text-foreground",
              )}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
