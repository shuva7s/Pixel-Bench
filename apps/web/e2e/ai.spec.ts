import { expect, test, type Page } from "@playwright/test";
import { DecodedImage } from "@image-tools/engine";

import { downloadVia, errorAlert, file, inspectImage, makePng, pixels } from "./shared";

// Tests tagged @webgpu also run in the "webgpu" project (real GPU, E2E_WEBGPU=1);
// @webgpu-only ones need a GPU. Elsewhere models run on the CPU (WebAssembly).
test.describe.configure({ timeout: 180_000 });

/** "GPU" in the webgpu project, otherwise "CPU". */
const device = () => (test.info().project.name === "webgpu" ? "GPU" : "CPU");

/** A red disc on a textured green/blue background: an easy, unambiguous subject. */
const W = 240;
const H = 180;
const subject = Buffer.from(
  makePng(
    W,
    H,
    pixels(W, H, (x, y) => {
      const inside = ((x - W / 2) / 55) ** 2 + ((y - H / 2) / 60) ** 2 < 1;
      if (inside) return [210, 40, 30, 255];
      return [60 + 30 * Math.sin(x / 9), 140 + 25 * Math.cos(y / 7), 120 + 20 * Math.sin((x + y) / 13), 255];
    }),
  ),
);

function rgbaAt(bytes: Buffer, x: number, y: number): number[] {
  const img = DecodedImage.decode(bytes);
  try {
    const { pixels: px, width } = img.renderRgba([]);
    const i = (y * width + x) * 4;
    return Array.from(px.slice(i, i + 4));
  } finally {
    img.dispose();
  }
}

async function openRemoveBg(page: Page) {
  await page.goto("/remove-bg/");
  await page.getByTestId("file-input").setInputFiles([file("disc.png", subject)]);
}

test("removes the background with the fast model and exports a transparent PNG @webgpu", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith("http://localhost")) external.push(r.url());
  });
  await openRemoveBg(page);
  await expect(page.getByTestId("model-info")).toContainText("U²-Net");
  await expect(page.getByTestId("segment-result")).toContainText(device(), { timeout: 120_000 });

  const { bytes, download } = await downloadVia(page, () => page.getByRole("button", { name: /^Export PNG/ }).click());
  expect(download.suggestedFilename()).toBe("disc-no-bg.png");
  expect(inspectImage(bytes)).toMatchObject({ format: "png", width: W, height: H });
  expect(rgbaAt(bytes, W / 2, H / 2)[3]).toBeGreaterThan(200); // subject kept
  expect(rgbaAt(bytes, 5, 5)[3]).toBeLessThan(40); // background removed
  // The small model is self-hosted: nothing left this site.
  expect(external).toEqual([]);

  // A solid colour behind the subject, without running the model again.
  await page.getByRole("radio", { name: "Colour" }).click();
  await page.getByRole("button", { name: "Use #2563eb" }).click();
  const coloured = await downloadVia(page, () => page.getByRole("button", { name: /^Export PNG/ }).click());
  expect(rgbaAt(coloured.bytes, 5, 5)).toEqual([0x25, 0x63, 0xeb, 255]);
  expect(rgbaAt(coloured.bytes, W / 2, H / 2).slice(0, 3)).toEqual([210, 40, 30]);

  // The mask view shows white for the subject.
  await page.getByRole("radio", { name: "Mask" }).click();
  await expect
    .poll(() =>
      page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext("2d")!.getImageData(c.width / 2, c.height / 2, 1, 1).data;
        return d[0];
      }),
    )
    .toBeGreaterThan(200);
});

test("without WebGPU the high-quality model is unavailable and nothing is downloaded", async ({ page }) => {
  const hf: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("huggingface.co")) hf.push(r.url());
  });
  await openRemoveBg(page);
  await expect(page.getByTestId("segment-result")).toBeVisible({ timeout: 120_000 });
  await page.getByRole("radio", { name: "High quality" }).click();
  await expect(page.getByText("High quality needs WebGPU")).toBeVisible();
  await expect(page.getByTestId("consent")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Run again/ })).toHaveCount(0);
  expect(hf).toEqual([]);
});

test("the high-quality model asks before downloading and reports failures @webgpu-only", async ({ page }) => {
  const hf: string[] = [];
  await page.route("https://huggingface.co/**", (route) => {
    hf.push(route.request().url());
    return route.abort("internetdisconnected");
  });
  await openRemoveBg(page);
  await expect(page.getByTestId("segment-result")).toBeVisible({ timeout: 120_000 });
  await page.getByRole("radio", { name: "High quality" }).click();
  await expect(page.getByTestId("consent")).toContainText("110 MB");
  await expect(page.getByTestId("consent")).toContainText("Hugging Face");
  expect(hf).toEqual([]);

  await page.getByRole("button", { name: /Download model/ }).click();
  await expect(errorAlert(page)).toContainText("Could not download BiRefNet-lite");
  expect(hf).toHaveLength(1);
  expect(hf[0]).toContain("/resolve/1ad01cef0f4101a285c5a3e0bd7f15597d93403f/");
  // The earlier result is still usable.
  await expect(page.getByRole("button", { name: /^Export PNG/ })).toBeEnabled();
});

test("a tampered model download is rejected @webgpu-only", async ({ page }) => {
  await page.route("https://huggingface.co/**", (route) => route.fulfill({ status: 200, body: Buffer.alloc(1000, 7) }));
  await page.goto("/remove-bg/");
  await page.getByRole("radio", { name: "High quality" }).click();
  // Downloading before any photo is open fetches and verifies the model right away.
  await page.getByRole("button", { name: /Download model/ }).click();
  await expect(errorAlert(page)).toContainText("failed its integrity check");
  // Nothing was cached, so the consent is asked again.
  await expect(page.getByTestId("consent")).toBeVisible();
});

test("AI upscale in Utilities (2× and 4×) @webgpu", async ({ page }) => {
  const small = Buffer.from(
    makePng(
      40,
      30,
      pixels(40, 30, (x, y) => [x * 6, y * 8, ((x ^ y) & 1) * 255, 255]),
    ),
  );
  await page.goto("/utilities/");
  await page.getByTestId("file-input").setInputFiles([file("small.png", small)]);
  await page.getByRole("radio", { name: "AI upscale" }).click();
  await expect(page.getByText("invents plausible detail")).toBeVisible();

  for (const factor of [2, 4]) {
    await page.getByRole("radio", { name: `${factor}×` }).click();
    await page.getByRole("button", { name: /Process 1 file/ }).click();
    const row = page.getByTestId("batch-item");
    await expect(row).toHaveAttribute("data-status", "done", { timeout: 120_000 });
    await expect(row.getByTestId("item-result")).toContainText(`AI (${device()}) · PNG · ${40 * factor} × ${30 * factor}`);
  }
  const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: /^Download small/ }).click());
  expect(inspectImage(bytes)).toMatchObject({ width: 160, height: 120 });
});

test("AI upscale refuses results over 50 MP", async ({ page }) => {
  const big = Buffer.from(
    makePng(
      2000,
      2000,
      pixels(2000, 2000, () => [90, 90, 90, 255]),
    ),
  );
  await page.goto("/utilities/");
  await page.getByTestId("file-input").setInputFiles([file("big.png", big)]);
  await page.getByRole("radio", { name: "AI upscale" }).click();
  await page.getByRole("radio", { name: "4×" }).click();
  await expect(page.getByText("too large for 4×")).toBeVisible();
});

test("high-quality background removal with the real model @webgpu-only", async ({ page }) => {
  // Downloads 110 MB from Hugging Face; opt in with E2E_NETWORK=1.
  test.skip(process.env.E2E_NETWORK !== "1", "set E2E_NETWORK=1 to download the real model");
  test.setTimeout(300_000);
  await page.goto("/remove-bg/");
  await page.getByRole("radio", { name: "High quality" }).click();
  await page.getByTestId("file-input").setInputFiles([file("disc.png", subject)]);
  // The first run asks to download; later runs in the same browser may find the model cached.
  const consent = page.getByRole("button", { name: /Download model/ });
  await expect(consent.or(page.getByTestId("ai-progress")).or(page.getByTestId("segment-result")).first()).toBeVisible({ timeout: 30_000 });
  if (await consent.isVisible()) await consent.click();
  await expect(page.getByTestId("segment-result")).toContainText("BiRefNet-lite on GPU", { timeout: 280_000 });
  const { bytes } = await downloadVia(page, () => page.getByRole("button", { name: /^Export PNG/ }).click());
  expect(rgbaAt(bytes, W / 2, H / 2)[3]).toBeGreaterThan(200);
  expect(rgbaAt(bytes, 5, 5)[3]).toBeLessThan(40);
});
