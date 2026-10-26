import { expect, test, type Page } from "@playwright/test";
import { unzipSync } from "fflate";

import {
  downloadVia,
  file,
  inspectImage,
  jpeg,
  magic,
  makePng,
  pixels,
  png,
  processImage,
  watchNetwork,
  setSlider,
  choose,
  webp,
  type FileSpec,
} from "./shared";

async function addFiles(page: Page, files: FileSpec[]) {
  await page.goto("/utilities/");
  await page.getByTestId("file-input").setInputFiles(files);
  // Every file is inspected (or rejected) before processing.
  await expect(page.locator('[data-testid="batch-item"][data-status="checking"]')).toHaveCount(0);
}

const item = (page: Page, name: string) => page.getByTestId("batch-item").filter({ hasText: name });

async function processAll(page: Page, count: number) {
  await page.getByRole("button", { name: new RegExp(`Process ${count} file`) }).click();
  await expect(page.locator('[data-testid="batch-item"][data-status="done"]')).toHaveCount(count, { timeout: 60_000 });
}

test("shows file details before processing", async ({ page }) => {
  await addFiles(page, [file("logo.png", png), file("actually-webp.png", webp), file("broken.png", Buffer.from("nope"))]);
  await expect(item(page, "logo.png").getByTestId("item-info")).toContainText("PNG · 64 × 48 · RGBA");
  // The real format is read from the bytes, not the name.
  await expect(item(page, "actually-webp.png").getByTestId("item-info")).toContainText("WebP · 64 × 48");
  await expect(item(page, "broken.png")).toHaveAttribute("data-status", "error");
  await expect(item(page, "broken.png")).toContainText(/Unsupported/);
  await expect(page.getByRole("button", { name: /Process 2 files/ })).toBeEnabled();
});

test("single file: convert transparent PNG to JPEG with flattening", async ({ page }) => {
  const check = watchNetwork(page);
  await addFiles(page, [file("logo.png", png)]);
  await choose(page, "Format", "jpeg");
  await expect(page.getByText(/has transparent pixels|cannot store transparency/).first()).toBeVisible();
  await processAll(page, 1);
  const { bytes, download } = await downloadVia(page, () => page.getByRole("link", { name: "Download logo.jpg" }).click());
  expect(download.suggestedFilename()).toBe("logo.jpg");
  expect(magic(bytes)).toBe("jpeg");
  expect(inspectImage(bytes)).toMatchObject({ format: "jpeg", width: 64, height: 48 });
  check();
});

test("compress keeps the format and reports the real size change", async ({ page }) => {
  await addFiles(page, [file("photo.jpg", jpeg, "image/jpeg")]);
  await setSlider(page, "Quality", 30);
  await processAll(page, 1);
  await expect(item(page, "photo.jpg").getByTestId("item-result")).toContainText(/smaller/);
  const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: "Download photo.jpg" }).click());
  expect(magic(bytes)).toBe("jpeg");
  expect(bytes.length).toBeLessThan(jpeg.length);
});

test("converts all formats both ways and preserves transparency", async ({ page }) => {
  await addFiles(page, [file("art.webp", webp, "image/webp")]);
  for (const format of ["png", "webp", "bmp", "jpeg"] as const) {
    await choose(page, "Format", format);
    await page.getByRole("button", { name: /Process 1 file/ }).click();
    await expect(item(page, "art.webp")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    const ext = format === "jpeg" ? "jpg" : format;
    const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: `Download art.${ext}` }).click());
    expect(magic(bytes)).toBe(format);
    const info = inspectImage(bytes);
    expect([info.width, info.height]).toEqual([64, 48]);
    expect(info.hasAlphaChannel).toBe(format === "png" || format === "webp");
  }
});

test("batch: resize, isolate failures and download a ZIP", async ({ page }) => {
  const check = watchNetwork(page);
  await addFiles(page, [
    file("a.png", png),
    file("b.jpg", jpeg, "image/jpeg"),
    file("c.webp", webp, "image/webp"),
    file("broken.png", Buffer.from("x")),
  ]);
  await choose(page, "Format", "png");
  await page.getByRole("radio", { name: "Fit", exact: true }).click();
  await page.getByLabel("Max width").fill("32");
  await page.getByLabel("Max height").fill("32");
  await processAll(page, 3);
  await expect(page.locator('[data-status="error"]')).toHaveCount(1);
  await expect(page.getByTestId("batch-summary")).toContainText("3 done");
  await expect(page.getByTestId("batch-summary")).toContainText("1 failed");

  const single = await downloadVia(page, () => page.getByRole("link", { name: "Download a-32x24.png" }).click());
  expect(inspectImage(single.bytes)).toMatchObject({ format: "png", width: 32, height: 24 });

  const zip = await downloadVia(page, () => page.getByRole("button", { name: /Download all as ZIP \(3\)/ }).click());
  expect(zip.download.suggestedFilename()).toBe("images.zip");
  const entries = unzipSync(new Uint8Array(zip.bytes));
  expect(Object.keys(entries).sort()).toEqual(["a-32x24.png", "b-32x24.png", "c-32x24.png"]);
  for (const bytes of Object.values(entries)) expect(inspectImage(bytes)).toMatchObject({ format: "png", width: 32, height: 24 });
  check();
});

test("percentage resize", async ({ page }) => {
  await addFiles(page, [file("photo.jpg", jpeg, "image/jpeg")]);
  await page.getByRole("radio", { name: "Scale", exact: true }).click();
  await setSlider(page, "Scale", 25);
  await processAll(page, 1);
  const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: "Download photo-20x15.jpg" }).click());
  expect(inspectImage(bytes)).toMatchObject({ width: 20, height: 15 });
});

test("oversized image header is rejected before decoding", async ({ page }) => {
  const forged = Buffer.from(makePng(2, 2, new Uint8Array(16), { headerWidth: 15_000, headerHeight: 15_000 }));
  await addFiles(page, [file("huge.png", forged)]);
  await expect(item(page, "huge.png").getByTestId("item-info")).toContainText("15000 × 15000");
  await page.getByRole("button", { name: /Process 1 file/ }).click();
  await expect(item(page, "huge.png")).toHaveAttribute("data-status", "error");
  await expect(item(page, "huge.png")).toContainText(/exceeds the maximum/);
});

test("main thread stays responsive while a large image is processed", async ({ page }) => {
  test.setTimeout(120_000);
  let seed = 3;
  const big = makePng(
    6000,
    4000,
    pixels(6000, 4000, (x, y) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return [(x >> 4) & 255, (y >> 4) & 255, (seed >>> 24) & 63, 255];
    }),
  );
  const bigJpeg = Buffer.from(processImage(big, [], { format: "jpeg", quality: 80 }).bytes);
  await addFiles(page, [file("big.jpg", bigJpeg, "image/jpeg")]);
  await expect(item(page, "big.jpg").getByTestId("item-info")).toContainText("6000 × 4000");
  await choose(page, "Format", "png");
  await page.evaluate(() => {
    const w = window as unknown as { __maxGap: number; __stop: boolean };
    w.__maxGap = 0;
    w.__stop = false;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      w.__maxGap = Math.max(w.__maxGap, now - last);
      last = now;
      if (!w.__stop) setTimeout(tick, 10);
    };
    setTimeout(tick, 10);
  });
  const started = Date.now();
  await page.getByRole("button", { name: /Process 1 file/ }).click();
  await expect(item(page, "big.jpg")).toHaveAttribute("data-status", "done", { timeout: 90_000 });
  const elapsed = Date.now() - started;
  const maxGap = await page.evaluate(() => {
    const w = window as unknown as { __maxGap: number; __stop: boolean };
    w.__stop = true;
    return w.__maxGap;
  });
  console.log(`24 MP JPEG -> PNG: ${elapsed} ms, longest main-thread stall ${maxGap.toFixed(0)} ms`);
  expect(maxGap).toBeLessThan(500);
});

test("utilities work on a phone-sized screen @mobile", async ({ page }) => {
  await addFiles(page, [file("photo.jpg", jpeg, "image/jpeg")]);
  await page.getByRole("radio", { name: "Scale", exact: true }).click();
  await setSlider(page, "Scale", 50);
  await processAll(page, 1);
  const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: "Download photo-40x30.jpg" }).click());
  expect(inspectImage(bytes)).toMatchObject({ width: 40, height: 30 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
