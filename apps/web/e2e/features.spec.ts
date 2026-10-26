import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { DecodedImage, inspectMetadata } from "@image-tools/engine";
import { encodeAvif, initAvifSync } from "@image-tools/engine/avif";

import {
  choose,
  downloadVia,
  file,
  inspectImage,
  magic,
  makePng,
  pixels,
  png,
  previewMean,
  previewSize,
  processImage,
  setSlider,
  type FileSpec,
} from "./shared";

initAvifSync(readFileSync(fileURLToPath(import.meta.resolve("@image-tools/engine/pkg/avif/avif_encoder_bg.wasm"))));

const heic = readFileSync(fileURLToPath(new URL("./fixtures/sample.heic", import.meta.url)));

/** Noisy photo-like JPEG (compresses poorly, so quality matters). */
function noisyJpeg(w: number, h: number, quality = 95): Buffer {
  let seed = 11;
  const px = pixels(w, h, (x, y) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const n = (seed >>> 26) - 32;
    return [(x * 255) / w + n, (y * 255) / h + n, 120 + n, 255];
  });
  return Buffer.from(processImage(makePng(w, h, px), [], { format: "jpeg", quality }).bytes);
}

/** Big-endian EXIF with Make, Orientation=1, and a GPS IFD. */
function exifTiff(): Uint8Array {
  const b: number[] = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8];
  const u16 = (v: number) => b.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const make = "PhoneCam\0";
  const makeOff = 8 + 2 + 3 * 12 + 4;
  const gpsOff = makeOff + make.length;
  u16(3);
  u16(0x010f);
  u16(2);
  u32(make.length);
  u32(makeOff); // Make
  u16(0x0112);
  u16(3);
  u32(1);
  u16(1);
  u16(0); // Orientation = 1
  u16(0x8825);
  u16(4);
  u32(1);
  u32(gpsOff); // GPS IFD
  u32(0);
  for (const c of make) b.push(c.charCodeAt(0));
  u16(1);
  u16(0x0001);
  u16(2);
  u32(2);
  b.push(0x4e, 0, 0, 0); // GPSLatitudeRef = "N"
  u32(0);
  return new Uint8Array(b);
}

function jpegWithExif(): Buffer {
  const base = noisyJpeg(64, 48, 80);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), Buffer.from(exifTiff())]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([base.subarray(0, 2), seg, payload, base.subarray(2)]);
}

async function addFiles(page: Page, files: FileSpec[]) {
  await page.goto("/utilities/");
  await page.getByTestId("file-input").setInputFiles(files);
  await expect(page.locator('[data-testid="batch-item"][data-status="checking"]')).toHaveCount(0, { timeout: 30_000 });
}

const item = (page: Page, name: string) => page.getByTestId("batch-item").filter({ hasText: name });

async function processAll(page: Page, count: number, verb = "Process") {
  await page.getByRole("button", { name: new RegExp(`${verb} ${count} file`) }).click();
  await expect(page.locator('[data-testid="batch-item"][data-status="done"]')).toHaveCount(count, { timeout: 90_000 });
}

const openSection = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();

/** Width/height from an AVIF/HEIC `ispe` box. */
function ispe(bytes: Uint8Array): [number, number] {
  for (let i = 0; i + 16 < bytes.length; i++) {
    if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {
      const v = new DataView(bytes.buffer, bytes.byteOffset + i + 8, 8);
      return [v.getUint32(0), v.getUint32(4)];
    }
  }
  throw new Error("no ispe box");
}

test.describe("formats", () => {
  test("writes GIF, TIFF, ICO, AVIF and lossy/lossless WebP", async ({ page }) => {
    test.setTimeout(120_000);
    await addFiles(page, [file("art.png", png)]);
    const sizes: Record<string, number> = {};
    for (const format of ["gif", "tiff", "ico", "avif", "webp"] as const) {
      await choose(page, "Format", format);
      await page.getByRole("button", { name: /Process 1 file/ }).click();
      await expect(item(page, "art.png")).toHaveAttribute("data-status", "done", { timeout: 60_000 });
      const ext = format === "tiff" ? "tiff" : format;
      const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: `Download art.${ext}` }).click());
      expect(magic(bytes)).toBe(format);
      if (format === "avif") expect(ispe(bytes)).toEqual([64, 48]);
      else if (format === "ico") expect(inspectImage(bytes)).toMatchObject({ format: "ico", width: 64, height: 64 });
      else expect(inspectImage(bytes)).toMatchObject({ width: 64, height: 48, hasAlphaChannel: true });
      sizes[format] = bytes.length;
    }
    // Lossless WebP keeps every pixel.
    await page.getByRole("switch", { name: "Lossless WebP" }).click();
    await page.getByRole("button", { name: /Process 1 file/ }).click();
    await expect(item(page, "art.png")).toHaveAttribute("data-status", "done");
    const lossless = await downloadVia(page, () => page.getByRole("link", { name: "Download art.webp" }).click());
    const a = DecodedImage.decode(lossless.bytes).renderRgba([]).pixels;
    const b = DecodedImage.decode(png).renderRgba([]).pixels;
    expect(a).toEqual(b);
  });

  test("opens AVIF and HEIC files decoded in the browser", async ({ page }) => {
    const src = DecodedImage.decode(png);
    const { pixels: px, width, height } = src.renderRgba([]);
    const avif = Buffer.from(await encodeAvif(px, width, height, 80, 10));
    await addFiles(page, [file("photo.avif", avif, "image/avif"), file("phone.heic", heic, "image/heic")]);
    await expect(item(page, "photo.avif").getByTestId("item-info")).toContainText("AVIF · 64 × 48");
    await expect(item(page, "phone.heic").getByTestId("item-info")).toContainText("HEIC · 96 × 64");
    await processAll(page, 2);
    // "Same as original" keeps AVIF; HEIC (not writable) becomes JPEG.
    const out = await downloadVia(page, () => page.getByRole("link", { name: "Download phone.jpg" }).click());
    expect(inspectImage(out.bytes)).toMatchObject({ format: "jpeg", width: 96, height: 64 });
    const a = await downloadVia(page, () => page.getByRole("link", { name: "Download photo.avif" }).click());
    expect(magic(a.bytes)).toBe("avif");
  });

  test("the editor opens HEIC and exports it", async ({ page }) => {
    await page.goto("/edit/");
    await page.getByTestId("file-input").setInputFiles(file("phone.heic", heic, "image/heic"));
    await expect.poll(() => previewSize(page), { timeout: 30_000 }).toEqual([96, 64]);
    const { bytes } = await downloadVia(page, () => page.getByRole("button", { name: /^Export [A-Z]+ · / }).click());
    expect(inspectImage(bytes)).toMatchObject({ format: "jpeg", width: 96, height: 64 });
  });
});

test.describe("target file size", () => {
  test("aiming for a file size replaces the quality slider", async ({ page }) => {
    await addFiles(page, [file("photo.jpg", noisyJpeg(320, 240), "image/jpeg")]);
    await choose(page, "Format", "jpeg");
    const slider = page.getByRole("slider", { name: "Quality" });
    await expect(slider).toBeVisible();
    // The target switch sits directly below the slider.
    const sliderBox = (await slider.boundingBox())!;
    const switchBox = (await page.getByRole("switch", { name: "Aim for a file size" }).boundingBox())!;
    expect(switchBox.y).toBeGreaterThan(sliderBox.y);
    expect(switchBox.y - sliderBox.y).toBeLessThan(80);
    await page.getByRole("switch", { name: "Aim for a file size" }).click();
    await expect(slider).toHaveCount(0);
    await expect(page.getByLabel("Target size")).toBeVisible();
    await page.getByRole("switch", { name: "Aim for a file size" }).click();
    await expect(slider).toBeVisible();
  });

  test("compresses below a limit and reports the result", async ({ page }) => {
    test.setTimeout(120_000);
    const src = noisyJpeg(640, 480);
    await addFiles(page, [file("big.jpg", src, "image/jpeg")]);
    // Target size lives in the (open) "Format & file size" section.
    await page.getByRole("switch", { name: "Aim for a file size" }).click();
    await page.getByLabel("Target size").fill("40");
    await processAll(page, 1);
    await expect(item(page, "big.jpg").getByTestId("item-target")).toContainText("Target met");
    const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: "Download big.jpg" }).click());
    expect(bytes.length).toBeLessThanOrEqual(40 * 1024);
    expect(bytes.length).toBeGreaterThan(20 * 1024); // the best quality that fits, not needlessly small
    expect(inspectImage(bytes)).toMatchObject({ width: 640, height: 480 });
  });

  test("an unreachable minimum is reported honestly, and enlarging can meet it", async ({ page }) => {
    test.setTimeout(120_000);
    await addFiles(page, [file("small.jpg", noisyJpeg(160, 120, 70), "image/jpeg")]);
    // Target size lives in the (open) "Format & file size" section.
    await page.getByRole("switch", { name: "Aim for a file size" }).click();
    await page.getByRole("radio", { name: "At least" }).click();
    await page.getByLabel("Target size").fill("300");
    await processAll(page, 1);
    await expect(item(page, "small.jpg").getByTestId("item-target")).toContainText("Target not met");
    await page.getByRole("switch", { name: "Allow enlarging dimensions" }).click();
    await page.getByRole("button", { name: /Process 1 file/ }).click();
    await expect(item(page, "small.jpg").getByTestId("item-target")).toContainText("Target met", { timeout: 90_000 });
    const name = await item(page, "small.jpg").getByRole("link").getAttribute("download");
    const { bytes } = await downloadVia(page, () => item(page, "small.jpg").getByRole("link").click());
    expect(name).toMatch(/small-\d+x\d+\.jpg/);
    expect(bytes.length).toBeGreaterThanOrEqual(300 * 1024);
  });
});

test.describe("metadata", () => {
  test("shows location data and removes metadata losslessly", async ({ page }) => {
    const src = jpegWithExif();
    expect(inspectMetadata(src)).toMatchObject({ hasGps: true });
    await addFiles(page, [file("trip.jpg", src, "image/jpeg")]);
    await expect(item(page, "trip.jpg").getByLabel("Contains location data")).toBeVisible();
    await page.getByRole("button", { name: "Show details for trip.jpg" }).click();
    await expect(item(page, "trip.jpg").getByTestId("metadata-view")).toContainText("PhoneCam");
    await expect(item(page, "trip.jpg")).toContainText("Contains the location");

    await openSection(page, "Metadata");
    await page.getByRole("switch", { name: "Only remove metadata (lossless)" }).click();
    await processAll(page, 1, "Clean");
    await expect(item(page, "trip.jpg").getByTestId("item-result")).toContainText("metadata removed");
    const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: "Download trip-clean.jpg" }).click());
    const after = inspectMetadata(bytes);
    expect(after.hasGps).toBe(false);
    expect(after.fields.map((f) => f.tag)).not.toContain("Make");
    expect(bytes.includes(Buffer.from("PhoneCam"))).toBe(false);
    // Lossless: decoded pixels are identical to the original's.
    expect(DecodedImage.decode(bytes).renderRgba([]).pixels).toEqual(DecodedImage.decode(src).renderRgba([]).pixels);
  });

  test("the editor shows metadata and exports without it", async ({ page }) => {
    await page.goto("/edit/");
    await page.getByTestId("file-input").setInputFiles(file("trip.jpg", jpegWithExif(), "image/jpeg"));
    await expect(page.getByTestId("preview-canvas")).toBeVisible();
    await openSection(page, "Info & metadata");
    await expect(page.getByTestId("metadata-view")).toContainText("PhoneCam");
    const { bytes } = await downloadVia(page, () => page.getByRole("button", { name: /^Export [A-Z]+ · / }).click());
    expect(inspectMetadata(bytes)).toMatchObject({ hasExif: false, hasGps: false });
  });
});

test.describe("editor additions", () => {
  test("border and padding change the output size", async ({ page }) => {
    await page.goto("/edit/");
    await page.getByTestId("file-input").setInputFiles(file("photo.png", png)); // 64x48
    await expect(page.getByTestId("preview-canvas")).toBeVisible();
    await openSection(page, "Border & padding");
    await choose(page, "Pad to shape", "Square (1:1)");
    await expect(page.getByTestId("geometry-summary")).toContainText("Output 64 × 64 px");
    const { bytes } = await downloadVia(page, () => page.getByRole("button", { name: /^Export [A-Z]+ · / }).click());
    expect(inspectImage(bytes)).toMatchObject({ width: 64, height: 64 });
  });

  test("text watermark and blur change the pixels", async ({ page }) => {
    await page.goto("/edit/");
    const flat = Buffer.from(
      makePng(
        200,
        120,
        pixels(200, 120, () => [40, 60, 80, 255]),
      ),
    );
    await page.getByTestId("file-input").setInputFiles(file("flat.png", flat));
    await expect.poll(() => previewSize(page)).toEqual([200, 120]);
    const before = await previewMean(page);
    await openSection(page, "Text & watermark");
    await page.getByRole("button", { name: "Add text" }).click();
    await page.getByLabel("Watermark text").fill("SAMPLE");
    await setSlider(page, "Text size", 20);
    // White text brightens the flat image.
    await expect.poll(async () => (await previewMean(page))[0]).toBeGreaterThan(before[0] + 2);
    const { bytes } = await downloadVia(page, () => page.getByRole("button", { name: /^Export [A-Z]+ · / }).click());
    const out = DecodedImage.decode(bytes).renderRgba([]).pixels;
    const changed = out.some((v, i) => i % 4 === 0 && v > 200);
    expect(changed).toBe(true);

    await openSection(page, "Effects");
    await setSlider(page, "Blur", 60);
    await expect(page.getByRole("button", { name: "Reset effects" })).toBeVisible();
  });
});

test.describe("batch workflow", () => {
  test("watermarks every file in a batch", async ({ page }) => {
    const flat = Buffer.from(
      makePng(
        160,
        100,
        pixels(160, 100, () => [20, 20, 20, 255]),
      ),
    );
    await addFiles(page, [file("one.png", flat), file("two.png", flat)]);
    await openSection(page, "Watermark");
    await page.getByRole("button", { name: "Add text" }).click();
    await page.getByLabel("Watermark text").fill("COPY");
    await processAll(page, 2);
    for (const n of ["one", "two"]) {
      const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: `Download ${n}.png` }).click());
      const out = DecodedImage.decode(bytes).renderRgba([]).pixels;
      expect(
        out.some((v, i) => i % 4 === 0 && v > 150),
        n,
      ).toBe(true);
    }
  });

  test("cancel now stops a running batch without errors", async ({ page }) => {
    test.setTimeout(120_000);
    const big = noisyJpeg(2400, 1800, 90);
    await addFiles(
      page,
      Array.from({ length: 8 }, (_, i) => file(`p${i}.jpg`, big, "image/jpeg")),
    );
    await choose(page, "Format", "avif"); // slow on purpose
    await page.getByRole("button", { name: /Process 8 files/ }).click();
    await expect(page.getByTestId("progress")).toBeVisible();
    await page.getByRole("button", { name: "Cancel now" }).click();
    await expect(page.getByRole("button", { name: /Process 8 files/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="batch-item"][data-status="error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="batch-item"][data-status="processing"]')).toHaveCount(0);
  });
});
