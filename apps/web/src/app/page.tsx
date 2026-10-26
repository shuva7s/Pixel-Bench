import { Layers, Scissors, SlidersHorizontal } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";

const TOOLS = [
  {
    href: "/edit/",
    icon: SlidersHorizontal,
    title: "Photo editor",
    text: "Lightroom-style light, colour, crop and effects for a single photo, with a live preview.",
  },
  {
    href: "/utilities/",
    icon: Layers,
    title: "Convert, compress & resize",
    text: "Change formats, shrink file sizes, resize or upscale, and remove metadata, for one image or hundreds.",
  },
  {
    href: "/remove-bg/",
    icon: Scissors,
    title: "Remove background",
    text: "Cut out the subject with an AI model that runs on your device, then keep it transparent or add a new background.",
  },
];

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-12 px-4 py-10 sm:py-16">
      <section className="flex flex-col items-start gap-4">
        <Badge variant="secondary">Free · Local · Private</Badge>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Edit and convert photos without uploading them.</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">Three tools, one engine. Everything runs on your device.</p>
      </section>

      <section aria-label="Tools" className="grid gap-4 lg:grid-cols-3">
        {TOOLS.map(({ href, icon: Icon, title, text }) => (
          <Link key={href} href={href} className="group rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <Card className="h-full transition-colors group-hover:border-foreground/30">
              <CardContent className="flex items-start gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Icon aria-hidden className="size-5" />
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <CardTitle className="text-lg">{title}</CardTitle>
                  <CardDescription>{text}</CardDescription>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>
    </div>
  );
}
