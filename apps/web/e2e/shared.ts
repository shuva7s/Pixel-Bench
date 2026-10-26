// Shared fixtures and helpers for the end-to-end tests. Tests run against the
// production static export in a real browser; every download is validated
// independently (magic bytes + dimensions via the engine in Node).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, type Download, type Page } from "@playwright/test";
import { initEngineSync, inspectImage, processImage } from "@image-tools/engine";
import { magic, makePng, pixels, samplePng } from "@image-tools/engine/test-fixtures";

initEngineSync(readFileSync(fileURLToPath(import.meta.resolve("@image-tools/engine/pkg/image_engine_bg.wasm"))));

export { inspectImage, magic, makePng, pixels, processImage };

/** 64x48 with transparent pixels. */
export const png = Buffer.from(samplePng(64, 48));
/** 80x60 opaque colourful gradient. */
export const opaquePng = Buffer.from(
  makePng(
    80,
    60,
    pixels(80, 60, (x, y) => [x * 3, y * 4, 120, 255]),
  ),
);
/** 80x60 dark image (for Auto). */
export const darkPng = Buffer.from(
  makePng(
    80,
    60,
    pixels(80, 60, (x, y) => [20 + (x % 20), 18 + (y % 15), 25, 255]),
  ),
);
export const jpeg = Buffer.from(processImage(opaquePng, [], { format: "jpeg", quality: 92 }).bytes);
export const webp = Buffer.from(processImage(png, [], { format: "webp" }).bytes);

export type FileSpec = { name: string; mimeType: string; buffer: Buffer };
export const file = (name: string, buffer: Buffer, mimeType = "image/png"): FileSpec => ({ name, mimeType, buffer });

/** Error notices, excluding Next's (empty) route-announcer live region. */
export const errorAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

/**
 * Fails the test if the page talks to anything except the local server, or
 * if any local resource (including RSC prefetches) fails to load.
 */
export function watchNetwork(page: Page) {
  const external: string[] = [];
  const failed: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname) && !["data:", "blob:"].includes(url.protocol)) external.push(r.url());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  return () => {
    expect(external, "no external network requests").toEqual([]);
    expect(failed, "no failed requests").toEqual([]);
  };
}

export async function readDownload(download: Download): Promise<Buffer> {
  return readFileSync((await download.path())!);
}

/** Clicks `trigger` and returns the downloaded file. */
export async function downloadVia(page: Page, trigger: () => Promise<unknown>): Promise<{ bytes: Buffer; download: Download }> {
  const [download] = await Promise.all([page.waitForEvent("download"), trigger()]);
  return { bytes: await readDownload(download), download };
}

/** Average RGB of the editor preview canvas. */
export function previewMean(page: Page): Promise<[number, number, number]> {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]!;
      g += d[i + 1]!;
      b += d[i + 2]!;
    }
    const n = d.length / 4 || 1;
    return [r / n, g / n, b / n] as [number, number, number];
  });
}

export async function previewSize(page: Page): Promise<[number, number]> {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => [c.width, c.height] as [number, number]);
}

const slider = (page: Page, name: string) => page.getByRole("slider", { name, exact: true });

export async function sliderValue(page: Page, name: string): Promise<number> {
  return Number(await slider(page, name).getAttribute("aria-valuenow"));
}

/**
 * Sets a Radix slider like a keyboard user: from its current value, PageUp /
 * PageDown (10 steps) then arrow keys. The step comes from the slider's
 * `data-step`, so no intermediate values are produced by measuring it.
 */
export async function setSlider(page: Page, name: string, target: number) {
  const thumb = slider(page, name);
  const step = Number(await thumb.evaluate((el) => el.closest("[data-step]")?.getAttribute("data-step") ?? "1"));
  await thumb.focus();
  const steps = Math.round((target - (await sliderValue(page, name))) / step);
  const [big, small] = steps >= 0 ? ["PageUp", "ArrowRight"] : ["PageDown", "ArrowLeft"];
  const n = Math.abs(steps);
  for (let i = 0; i < Math.floor(n / 10); i++) await thumb.press(big);
  for (let i = 0; i < n % 10; i++) await thumb.press(small);
  await expect.poll(() => sliderValue(page, name)).toBeCloseTo(target, 5);
}

const FORMAT_LABELS: Record<string, string> = {
  jpeg: "JPEG",
  png: "PNG",
  webp: "WebP",
  avif: "AVIF",
  gif: "GIF",
  tiff: "TIFF",
  bmp: "BMP",
  ico: "ICO (icon)",
};

/** Picks an option in a shadcn (Radix) select by its label. */
export async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: FORMAT_LABELS[option] ?? option, exact: true }).click();
}
