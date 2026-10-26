import type { Metadata } from "next";

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
  "Utilities — Watermarks, one file or hundreds at once, ZIP download",
  "Remove background — AI cut-out to a transparent PNG, a colour, a blurred copy or another image",
  "Works offline after the first visit (AI models once they have been used)",
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
    size: "4.6 MB, served by this site",
    license: "Apache-2.0",
    href: "/models/LICENSE-U2Net.txt",
  },
  {
    name: "BiRefNet-lite (fp16, WebGPU export)",
    use: "Remove background — High quality",
    size: "110 MB, downloaded from Hugging Face only after you agree; needs WebGPU",
    license: "MIT",
    href: "/models/LICENSE-BiRefNet.txt",
  },
  {
    name: "Real-ESRGAN realesr-general-x4v3",
    use: "Utilities — AI upscale",
    size: "4.9 MB, served by this site (converted to ONNX from the official weights)",
    license: "BSD-3-Clause",
    href: "/models/LICENSE-Real-ESRGAN.txt",
  },
];

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

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
          Pixel Bench is a static website. When you open an image, your browser reads it into memory and hands it to an image engine written
          in Rust and compiled to WebAssembly, running in a background worker on this page. The processed file is created in memory and
          offered to you as a download. No image data is sent to any server, there is no analytics, and nothing is stored after you close
          the tab.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">AI models</h2>
        <p className="text-muted-foreground">
          Background removal and upscaling run open-source models with ONNX Runtime Web, on your graphics card (WebGPU) when available and
          otherwise on the CPU. Models are downloaded only when you first use the tool, checked against a pinned SHA-256 fingerprint, and
          kept in your browser&rsquo;s storage. Your photos are never sent anywhere, including to Hugging Face: downloading the high-quality
          model is an ordinary file download, so Hugging Face sees your IP address but no image.
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
              <a className="self-center text-muted-foreground underline underline-offset-2" href={`${base}${m.href}`}>
                {m.license}
              </a>
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
          HEIC decoding uses libheif (LGPL-3.0), shipped unmodified as a separate file (
          <a className="underline underline-offset-2" href={`${base}/vendor/libheif-LICENSE.txt`}>
            licence
          </a>
          ) so it can be replaced. HEIC images normally contain HEVC video coding, which is covered by patents in some countries; whether
          decoding them needs a licence depends on where you are. ONNX Runtime Web is MIT-licensed (
          <a className="underline underline-offset-2" href={`${base}/vendor/ort/LICENSE.txt`}>
            licence
          </a>
          ).
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
