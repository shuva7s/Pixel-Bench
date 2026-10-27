import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";

import { AppHeader } from "@/components/AppHeader";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Pixel Bench — private image tools", template: "%s · Pixel Bench" },
  description: "Free photo editor, image converter and background remover that runs entirely on your computer. No uploads, no accounts.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans antialiased", GeistSans.variable)}>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <TooltipProvider delayDuration={300}>
          <AppHeader />
          <main id="main" className="flex min-h-0 flex-1 flex-col">
            {children}
          </main>
        </TooltipProvider>
      </body>
    </html>
  );
}
