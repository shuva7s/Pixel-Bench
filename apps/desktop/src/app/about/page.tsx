import type { Metadata } from "next";

import { ExternalLink } from "@/components/ExternalLink";

export const metadata: Metadata = {
  title: "Privacy & status",
  description: "How Pixel Bench processes images locally, its limits, the AI models it uses, and which features are available.",
};

const AVAILABLE = [
  "Photo editor — Light: exposure, contrast, highlights, shadows, whites, blacks, plus Auto",
  "Photo editor — Color: temperature, tint, vibrance, saturation, black & white",
  "Photo editor — Color mixer: hue, saturation and luminance for 8 colour bands",
  "Photo editor — Effects and detail: clarity, blur, vignette, grain, sharpening",
  "Photo editor — Crop with aspect presets or a custom ratio, straighten (±45°), rotate, flip",
  "Photo editor — Text and logo watermarks, borders and padding to a shape",
  "Photo editor — Presets, live histogram, before/after, undo/redo, metadata view, export",
  "Utilities — Convert to JPEG, PNG, WebP (lossy or lossless), AVIF, GIF, TIFF, ICO and BMP; open HEIC/HEIF",
  "Utilities — Compress with quality control, or to a target file size (at most / at least)",
  "Utilities — Resize to fit a box or by percentage, or AI upscale 2× / 4×",
  "Utilities — Inspect metadata (camera, dates, GPS) and remove it losslessly from JPEG, PNG and WebP",
  "Utilities — Watermarks, one file or hundreds at once, save all into a folder",
  "Remove background — AI cut-out to a transparent PNG, a colour, a blurred copy or another image",
  "Works fully offline (the optional high-quality AI model is downloaded once)",
];

const PLANNED = ["Tone curve, colour grading, noise reduction, healing and masks", "Animated GIF/WebP and multi-page TIFF editing"];

const LIMITS = [
  ["Maximum file size", "100 MB"],
  ["Maximum dimensions", "20,000 px per side and 50 megapixels (also the AI upscale output limit)"],
  ["WebP output", "At most 16,383 px per side"],
  ["Animated / multi-page", "Animated GIF, PNG and WebP and multi-page TIFF are rejected with a clear message"],
  ["HEIC / AVIF input", "Decoded by your browser where supported, otherwise by libheif (HEIC); HEIC cannot be written"],
  ["Bit depth", "16-bit images are processed at 8 bits per channel"],
  ["Colour profiles", "Converted files are treated as sRGB; lossless metadata removal can keep the profile"],
  ["Editor preview", "Rendered on a reduced-size copy (up to 1400 px); exports always use full resolution"],
  ["Metadata", "Converted and edited files are written without EXIF/XMP; EXIF orientation is applied to the pixels first"],
];

const MODELS = [
  {
    name: "U²-Net small (u2netp)",
    use: "Remove background — Fast",
    size: "4.6 MB, included with the app",
    license: "Apache-2.0",
    href: "https://github.com/xuebinqin/U-2-Net",
  },
  {
    name: "BiRefNet-lite (fp16, WebGPU export)",
    use: "Remove background — High quality",
    size: "110 MB, downloaded from Hugging Face only after you agree",
    license: "MIT",
    href: "https://github.com/ZhengPeng7/BiRefNet",
  },
  {
    name: "Real-ESRGAN realesr-general-x4v3",
    use: "Utilities — AI upscale",
    size: "4.9 MB, included with the app (converted to ONNX from the official weights)",
    license: "BSD-3-Clause",
    href: "https://github.com/xinntao/Real-ESRGAN",
  },
];

export default function AboutPage() {
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-10 sm:py-14">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Privacy & status</h1>
        <p className="mt-2 text-muted-foreground">What happens to your images, and what this release can and can&rsquo;t do.</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Your images stay on your device</h2>
        <p className="text-muted-foreground">
          Pixel Bench is a desktop app. When you open an image, it is processed on your computer by a native image engine written in Rust.
          Results are saved only where you choose. No image data is sent to any server, there is no analytics, and the app does not keep
          copies of your photos.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">AI models</h2>
        <p className="text-muted-foreground">
          Background removal and upscaling run open-source models with ONNX Runtime, on your graphics card where supported (DirectML on
          Windows, Core ML on macOS) and otherwise on the CPU. Two small models are included with the app. The high-quality background model
          is downloaded once, only after you agree, checked against a pinned SHA-256 fingerprint and kept in the app&rsquo;s data folder.
          Your photos are never sent anywhere, including to Hugging Face: downloading that model is an ordinary file download, so Hugging
          Face sees your IP address but no image.
        </p>
        <div className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
          {MODELS.map((m) => (
            <div key={m.name} className="grid gap-1 px-4 py-3 sm:grid-cols-[1fr_auto]">
              <div>
                <p className="font-medium">{m.name}</p>
                <p className="text-muted-foreground">
                  {m.use} · {m.size}
                </p>
              </div>
              <ExternalLink className="self-center text-muted-foreground underline underline-offset-2" href={m.href}>
                {m.license}
              </ExternalLink>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          AI output is an estimate. Cut-outs can miss fine detail or keep bits of background, and upscaling invents plausible detail rather
          than recovering it. The models were trained by their authors on public datasets that may carry their own terms; the model licences
          above cover the weights.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Available now</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {AVAILABLE.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Limits</h2>
        <dl className="divide-y divide-border rounded-xl border border-border bg-card">
          {LIMITS.map(([k, v]) => (
            <div key={k} className="grid gap-1 px-4 py-3 sm:grid-cols-[200px_1fr]">
              <dt className="font-medium">{k}</dt>
              <dd className="text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Third-party components</h2>
        <p className="text-muted-foreground">
          HEIC decoding uses <ExternalLink href="https://github.com/strukturag/libheif">libheif</ExternalLink> (LGPL-3.0), shipped
          unmodified as a separate file so it can be replaced. HEIC images normally contain HEVC video coding, which is covered by patents
          in some countries; whether decoding them needs a licence depends on where you are. AI models run with{" "}
          <ExternalLink href="https://github.com/microsoft/onnxruntime">ONNX Runtime</ExternalLink> (MIT); text watermarks use the Geist
          fonts (SIL Open Font License). The full licence texts are included in the app&rsquo;s <code>licenses</code> folder.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Planned (not available yet)</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {PLANNED.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}
