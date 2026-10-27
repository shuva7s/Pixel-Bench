"use client";

import { CircleHelp } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A small (?) button that explains a term. Opens on hover and keyboard focus
 * like a tooltip, and also on tap, so it works on touch screens.
 */
export function HelpTip({ term, children }: { term: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${term}?`}
          onClick={(e) => {
            e.preventDefault();
            setOpen(true);
          }}
          // Don't trigger the slider "double-click to reset" behind it.
          onDoubleClick={(e) => e.stopPropagation()}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <CircleHelp aria-hidden className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-xs leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

/** Tooltip for an existing control, e.g. an icon-only button. */
export function Tip({ content, children }: { content: ReactNode; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64 text-xs leading-relaxed">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

/** Plain-language explanations shown next to technical terms. */
export const HELP = {
  // Light
  exposure: "Overall brightness, in camera stops. +1 doubles the light, −1 halves it.",
  contrast: "The difference between light and dark areas. Higher makes the image punchier, lower makes it flatter.",
  highlights: "Brightness of the brightest areas only, such as sky. Lower it to recover detail in bright parts.",
  shadows: "Brightness of the darkest areas only. Raise it to reveal detail in shadows without brightening everything.",
  whites: "Sets how bright the very brightest pixels are (the white point). Higher makes whites cleaner but can clip detail.",
  blacks: "Sets how dark the very darkest pixels are (the black point). Lower gives deeper blacks; higher gives a faded, matte look.",
  // Color
  monochrome: "Converts the photo to black & white. Use the Color mixer's Luminance sliders to control how each colour turns into grey.",
  temperature: "Warms the photo (more yellow) or cools it (more blue). Use it to fix colour casts from indoor light or shade.",
  tint: "Shifts colours towards green or magenta. Use it together with Temperature to correct colour casts.",
  vibrance: "Boosts muted colours more than already-strong ones, so skin tones stay natural. Gentler than Saturation.",
  saturation: "Makes every colour stronger or weaker by the same amount. −100 removes all colour.",
  mixer:
    "Adjust one colour range at a time: Hue changes the shade (e.g. make greens more yellow), Saturation its intensity, Luminance its brightness.",
  // Effects & detail
  clarity:
    "Adds or removes contrast in mid-tones and textures, making details pop (or softening them) without changing overall brightness.",
  vignette: "Darkens (negative) or lightens (positive) the corners to draw attention to the centre.",
  vignetteMidpoint: "How far the vignette reaches towards the centre. Lower values cover more of the image.",
  grain: "Adds film-like noise for a textured, analogue look.",
  sharpening: "Makes edges crisper. Too much creates halos, so zoom into the exported file to judge it.",
  radius: "How wide the sharpened edges are. Small values sharpen fine detail; larger values affect thicker edges.",
  // Geometry
  straighten: "Rotates by a small angle to level a tilted horizon. The image is zoomed slightly so no empty corners appear.",
  aspect: "The shape of the crop: width to height. 1:1 is square, 16:9 is widescreen, 4:5 suits portrait social posts.",
  customAspect: "Enter any width-to-height ratio, e.g. 2.39 : 1 for cinema widescreen or 5 : 7 for a print. Decimals are allowed.",
  // Workspace
  histogram:
    "Shows how many pixels there are at each brightness, dark on the left and bright on the right. Peaks against an edge mean lost detail (clipping).",
  auto: "Analyses the photo and sets Exposure, Contrast, Highlights, Shadows, Whites and Blacks automatically. You can fine-tune afterwards.",
  before: "Shows the original photo so you can compare. Shortcut: \\",
  // Output
  format:
    "JPEG: small files for photos, no transparency. PNG: lossless, keeps transparency, bigger. WebP (lossless): keeps transparency. BMP: uncompressed, very large.",
  jpegQuality:
    "Higher means better quality and bigger files. 75–90 suits most photos; below 60 compression artefacts become visible. Applies to JPEG, lossy WebP and AVIF.",
  webpLossless:
    "Lossless keeps every pixel exactly (good for graphics and screenshots). Off gives much smaller photos with a quality slider.",
  avifSpeed:
    "AVIF encoding is slow. Fast is several times quicker; Smallest squeezes a little more out of the file but can take a long time on big photos.",
  blur: "Softens the whole image. Useful for backgrounds or a dreamy look; the strength scales with the image size.",
  border: "Adds a frame around the photo, sized relative to its short side.",
  frameRatio: "Adds space to two sides so the photo fits this shape without being cropped, e.g. square for Instagram.",
  watermark: "Adds your text or logo on top of the photo, e.g. a copyright notice. Logos keep their transparency.",
  targetSize:
    "Finds the best quality (and, if you allow it, size) that meets the file-size limit. 'At least' is for forms that require a minimum size; files are never padded with junk data.",
  stripOnly:
    "Rewrites JPEG, PNG and WebP files without re-encoding: pixels stay exactly the same, only metadata is removed. Every output is checked afterwards.",
  keepOrientation: "Keeps the rotation flag so photos still display upright. It reveals nothing about you.",
  keepIcc: "Keeps the colour profile so colours look as intended (important for wide-gamut photos). It reveals nothing personal.",
  progressive:
    "Stores the JPEG so it appears blurry first and sharpens as it loads on slow connections. Same quality, often slightly smaller.",
  pngCompression: "How hard to work at shrinking the PNG. The image is never changed (lossless); only speed and file size differ.",
  background: "JPEG and BMP cannot be transparent, so transparent pixels are filled with this colour.",
  // Utilities
  resize:
    "Original keeps the size. Fit shrinks images to fit a box while keeping their shape. Scale resizes every image by a percentage. AI upscale enlarges 2× or 4× with an AI model.",
  upscale: "Normally smaller images are left as they are. Turn this on to enlarge them to fit the box (enlarging cannot add detail).",
  // AI tools
  bgModel:
    "Fast uses a small model (4.6 MB) that works on any device; good for clear subjects. High quality uses BiRefNet-lite: much cleaner hair and edges, but a one-time 110 MB download and a few seconds per photo (about 10 s without graphics-card acceleration).",
  edgeHardness: "0 keeps the soft, semi-transparent edge the AI found (good for hair). Higher values make a crisper cut.",
  edgeShift: "Shrinks (negative) or grows (positive) the cut-out. Shrink a little to remove a halo of the old background.",
  feather: "Softens the edge of the cut-out so it blends into a new background.",
  backdrop: "What goes behind the subject: nothing (transparent PNG), a solid colour, a blurred copy of the photo, or another image.",
  aiUpscale:
    "Enlarges with an AI model (Real-ESRGAN) that sharpens edges and textures instead of just stretching pixels. The extra detail is estimated, not recovered: it can look painted or invent texture, so don’t rely on it for evidence or fine text.",
  aiDevice:
    "Where supported, the model runs on your graphics card (DirectML on Windows, Core ML on macOS), which is usually several times faster. Otherwise it runs on the CPU.",
} as const;
