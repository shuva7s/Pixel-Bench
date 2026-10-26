import { expect, test } from "@playwright/test";

import { downloadVia, file, inspectImage, jpeg, png, previewSize } from "./shared";

test("works offline after the first visit", async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  // Wait until the service worker controls the page and has cached the app.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  });
  await context.setOffline(true);

  // Navigate to both tools with no network at all.
  await page.goto("/utilities/");
  await page.getByTestId("file-input").setInputFiles([file("photo.jpg", jpeg, "image/jpeg")]);
  await expect(page.locator('[data-testid="batch-item"][data-status="ready"]')).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("button", { name: /Process 1 file/ }).click();
  await expect(page.locator('[data-testid="batch-item"][data-status="done"]')).toHaveCount(1, { timeout: 30_000 });
  const { bytes } = await downloadVia(page, () => page.getByRole("link", { name: "Download photo.jpg" }).click());
  expect(inspectImage(bytes)).toMatchObject({ width: 80, height: 60 });

  await page.goto("/edit/");
  await page.getByTestId("file-input").setInputFiles(file("art.png", png));
  await expect.poll(() => previewSize(page)).toEqual([64, 48]);
  await context.setOffline(false);
});
