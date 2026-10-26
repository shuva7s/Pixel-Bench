import { expect, test, type Page } from "@playwright/test";

import {
  darkPng,
  downloadVia,
  errorAlert,
  file,
  inspectImage,
  jpeg,
  magic,
  opaquePng,
  previewMean,
  previewSize,
  watchNetwork,
  setSlider,
  sliderValue,
  choose,
  type FileSpec,
} from "./shared";

async function openEditor(page: Page, f: FileSpec) {
  await page.goto("/edit/");
  await page.getByTestId("file-input").setInputFiles(f);
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  // Wait for the first engine-rendered preview.
  await expect.poll(() => previewSize(page)).not.toEqual([300, 150]);
}

async function exportImage(page: Page) {
  const result = await downloadVia(page, () => page.getByRole("button", { name: /^Export [A-Z]+ · / }).click());
  await expect(page.getByTestId("export-result")).toBeVisible();
  return result;
}

test("landing page offers the three tools @mobile", async ({ page }) => {
  const check = watchNetwork(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("without uploading");
  await expect(page.getByRole("link", { name: /Photo editor/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Convert, compress & resize/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Remove background/ })).toBeVisible();
  await page.getByRole("link", { name: /Photo editor/ }).click();
  await expect(page).toHaveURL(/\/edit\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Photo editor");
  check();
});

test("light sliders change the engine preview and the export", async ({ page }) => {
  const check = watchNetwork(page);
  await openEditor(page, file("photo.jpg", jpeg, "image/jpeg"));
  expect(await previewSize(page)).toEqual([80, 60]);
  // Histogram is collapsed by default.
  await expect(page.getByTestId("histogram")).toHaveCount(0);
  await page.getByRole("button", { name: "Histogram" }).click();
  await expect(page.getByTestId("histogram")).toBeVisible();
  const before = await previewMean(page);

  await setSlider(page, "Exposure", 1.5);
  await expect.poll(async () => (await previewMean(page))[0]).toBeGreaterThan(before[0] + 20);

  const { bytes, download } = await exportImage(page);
  expect(download.suggestedFilename()).toBe("photo-edited.jpg");
  expect(magic(bytes)).toBe("jpeg");
  expect(inspectImage(bytes)).toMatchObject({ width: 80, height: 60 });
  check();
});

test("crop with aspect preset, straighten and rotate", async ({ page }) => {
  await openEditor(page, file("photo.png", opaquePng));
  await page.getByRole("radio", { name: "1:1" }).click();
  await expect(page.getByTestId("crop-overlay")).toBeVisible();
  await expect(page.getByTestId("geometry-summary")).toContainText("Output 60 × 60 px");
  await page.getByRole("button", { name: "Done cropping" }).click();
  await expect(page.getByTestId("crop-overlay")).toHaveCount(0);
  await expect.poll(() => previewSize(page)).toEqual([60, 60]);

  await setSlider(page, "Straighten", 5);
  await expect(page.getByTestId("geometry-summary")).toContainText("straightened 5.0°");
  let { bytes } = await exportImage(page);
  expect(inspectImage(bytes)).toMatchObject({ width: 60, height: 60 });

  // Rotating changes the frame, so the crop is cleared.
  await page.getByRole("button", { name: "Rotate right" }).click();
  await expect(page.getByTestId("geometry-summary")).toContainText("Output 60 × 80 px · rotated 90°");
  await expect.poll(() => previewSize(page)).toEqual([60, 80]);
  ({ bytes } = await exportImage(page));
  expect(inspectImage(bytes)).toMatchObject({ width: 60, height: 80 });
});

test("undo and redo restore slider values", async ({ page }) => {
  await openEditor(page, file("photo.png", opaquePng));
  await setSlider(page, "Contrast", 40);
  await expect.poll(() => sliderValue(page, "Contrast")).toBe(40);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => sliderValue(page, "Contrast")).toBe(0);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect.poll(() => sliderValue(page, "Contrast")).toBe(40);
  await page.keyboard.press("Control+z");
  await expect.poll(() => sliderValue(page, "Contrast")).toBe(0);
});

test("black & white, presets and colour mixer", async ({ page }) => {
  await openEditor(page, file("photo.png", opaquePng));
  await page.getByRole("button", { name: "Presets" }).click();
  await page.getByRole("button", { name: "B&W", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Black & white" })).toBeChecked();
  await expect
    .poll(async () => {
      const [r, g, b] = await previewMean(page);
      return Math.abs(r - g) < 1 && Math.abs(g - b) < 1;
    })
    .toBe(true);
  await choose(page, "Format", "png");
  const { bytes } = await exportImage(page);
  expect(inspectImage(bytes)).toMatchObject({ format: "png", colorModel: "grayscale" });

  // Colour mixer opens and its sliders drive the preview.
  await page.getByRole("switch", { name: "Black & white" }).click();
  await page.getByRole("button", { name: "Color mixer" }).click();
  await page.getByRole("radio", { name: "Saturation" }).click();
  for (const band of ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"]) await setSlider(page, band, -100);
  await expect
    .poll(async () => {
      const [r, g, b] = await previewMean(page);
      return Math.max(r, g, b) - Math.min(r, g, b);
    })
    .toBeLessThan(6);
});

test("auto tone brightens a dark photo", async ({ page }) => {
  await openEditor(page, file("dark.png", darkPng));
  const before = await previewMean(page);
  await page.getByRole("button", { name: "Presets" }).click();
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await expect.poll(async () => sliderValue(page, "Exposure")).toBeGreaterThan(0.5);
  await expect.poll(async () => (await previewMean(page))[0]).toBeGreaterThan(before[0] + 15);
});

test("before view shows the original and reset all clears edits", async ({ page }) => {
  await openEditor(page, file("photo.png", opaquePng));
  await setSlider(page, "Saturation", 80);
  await page.getByRole("button", { name: /Before/ }).click();
  await expect(page.getByRole("img", { name: "Original" })).toBeVisible();
  await page.getByRole("button", { name: /Before/ }).click();
  await page.getByRole("button", { name: /Reset all/ }).click();
  await expect.poll(() => sliderValue(page, "Saturation")).toBe(0);
});

test("editor rejects invalid files with clear errors", async ({ page }) => {
  await page.goto("/edit/");
  await page.getByTestId("file-input").setInputFiles(file("notes.txt", Buffer.from("hello"), "text/plain"));
  await expect(errorAlert(page)).toContainText("does not look like an image");
  await page.getByTestId("file-input").setInputFiles(file("fake.png", Buffer.from("definitely not a png file")));
  await expect(errorAlert(page)).toContainText(/Unsupported or unrecognised image format/);
  await page.getByTestId("file-input").setInputFiles(file("ok.png", opaquePng));
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
});

test("editor works on a phone-sized screen @mobile", async ({ page }) => {
  await openEditor(page, file("photo.png", opaquePng));
  await setSlider(page, "Exposure", 0.5);
  const { bytes } = await exportImage(page);
  expect(inspectImage(bytes)).toMatchObject({ width: 80, height: 60 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("help tooltips explain technical terms on hover and on tap @mobile", async ({ page }, info) => {
  await openEditor(page, file("photo.jpg", jpeg, "image/jpeg"));
  const help = page.getByRole("button", { name: "What is Exposure?" });
  if (info.project.name === "mobile") await help.tap();
  else await help.hover();
  // Radix renders a visible copy and a screen-reader copy of each tooltip.
  const tip = (text: string) => page.getByRole("tooltip").filter({ hasText: text });
  await expect(tip("camera stops").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip("camera stops")).toHaveCount(0);

  // Output settings explain their jargon too.
  const progressive = page.getByRole("button", { name: "What is Progressive JPEG?" });
  await progressive.scrollIntoViewIfNeeded();
  if (info.project.name === "mobile") await progressive.tap();
  else await progressive.focus();
  await expect(tip("blurry first").first()).toBeVisible();
});

/** True when the element is fully inside its accordion section (not clipped). */
function insideSection(page: Page, locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((el) => {
    const section = el.closest('[data-slot="accordion-content"]')!;
    const a = el.getBoundingClientRect();
    const b = section.getBoundingClientRect();
    return a.height > 0 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  });
}

test("sections grow with their content instead of clipping it", async ({ page }) => {
  await openEditor(page, file("photo.jpg", jpeg, "image/jpeg"));
  // Regression: the first change adds a "Reset color" button, which used to push
  // the Saturation slider out of the (fixed-height) section.
  await setSlider(page, "Saturation", 30);
  await expect(page.getByRole("button", { name: "Reset color" })).toBeVisible();
  await expect.poll(() => insideSection(page, page.getByRole("slider", { name: "Saturation", exact: true }))).toBe(true);

  // Content that appears later in a section must not be clipped either.
  await choose(page, "Format", "gif");
  const notice = page.getByText(/limited to 256 colours/);
  await expect.poll(() => insideSection(page, notice)).toBe(true);
});

test("custom aspect ratio crops to the entered ratio", async ({ page }) => {
  await openEditor(page, file("photo.png", opaquePng)); // 80x60
  await page.getByRole("radio", { name: "Custom" }).click();
  await expect(page.getByTestId("custom-aspect")).toBeVisible();
  await page.getByLabel("Ratio width").fill("2");
  await page.getByLabel("Ratio height").fill("1");
  await expect(page.getByTestId("geometry-summary")).toContainText("Output 80 × 40 px");

  // Decimals work.
  await page.getByLabel("Ratio width").fill("1.5");
  await expect(page.getByTestId("geometry-summary")).toContainText("Output 80 × 53 px");

  // An incomplete ratio warns and keeps the last valid crop.
  await page.getByLabel("Ratio height").fill("0");
  await expect(page.getByText(/Enter two numbers between 0 and 100/)).toBeVisible();
  await expect(page.getByTestId("geometry-summary")).toContainText("Output 80 × 53 px");
  await page.getByLabel("Ratio height").fill("1");

  await page.getByRole("button", { name: "Done cropping" }).click();
  const { bytes } = await exportImage(page);
  expect(inspectImage(bytes)).toMatchObject({ width: 80, height: 53 });
});
