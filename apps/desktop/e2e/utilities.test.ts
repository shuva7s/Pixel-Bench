import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { fixture, photo, readSaved, repoFixture, saved } from "./env.ts";
import { decodePng, magic } from "./png.ts";
import { App } from "./wd.ts";

let app: App;
before(async () => (app = await App.launch()));
after(() => app?.quit());

const statuses = () => app.js<string[]>(`return [...document.querySelectorAll('[data-testid="batch-item"]')].map((e) => e.dataset.status)`);

async function processAll(count: number) {
  await app.click("button", new RegExp(`^Process ${count} files?$`));
  await app.waitFor(async () => (await statuses()).filter((s) => s === "done").length === count, `${count} done`, 120_000);
}

test("converts a batch (including HEIC) to a target size and saves it into a folder", async () => {
  await app.goto("utilities");
  await app.addFiles(fixture("a.png", photo(640, 480, 1)), fixture("b.png", photo(500, 400, 2)), repoFixture("sample.heic"));
  await app.waitFor(async () => (await statuses()).every((s) => s === "ready") && (await statuses()).length === 3, "3 files inspected");

  await app.choose("Format", "JPEG");
  await app.click("switch", "Aim for a file size");
  // The quality slider is replaced while a target is set.
  assert.equal(await app.js<number>(`return document.querySelectorAll('[role=slider][aria-label="Quality"]').length`), 0);
  await app.js(`const i = [...document.querySelectorAll('input')].find((e) => e.closest('div')?.parentElement?.textContent?.includes('Target size'));
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '40'); i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await processAll(3);
  const targets = await app.js<string[]>(`return [...document.querySelectorAll('[data-testid="item-target"]')].map((e) => e.textContent)`);
  assert.equal(targets.length, 3);
  assert.ok(
    targets.every((t) => t.startsWith("Target met")),
    JSON.stringify(targets),
  );

  await app.click("button", /^Save all 3 to a folder/);
  await app.waitFor(() => app.text('[data-testid="saved-to"]'), "the saved message");
  const jpegs = saved().filter((f) => /^(a|b|sample)\.jpg$/.test(f));
  assert.deepEqual(jpegs, ["a.jpg", "b.jpg", "sample.jpg"]);
  for (const f of jpegs) {
    const bytes = readSaved(f);
    assert.equal(magic(bytes), "jpeg");
    assert.ok(bytes.length <= 40 * 1024, `${f}: ${bytes.length} bytes`);
  }

  // Saving again never overwrites.
  await app.click("button", /^Save all 3 to a folder/);
  await app.waitFor(async () => saved().includes("a (1).jpg"), "a second copy");
});

test("writes AVIF and lossy WebP natively", async () => {
  await app.click("button", /^Clear all$/);
  await app.addFiles(fixture("c.png", photo(300, 200, 3)));
  await app.waitFor(async () => (await statuses()).join() === "ready", "1 file inspected");
  await app.click("switch", "Aim for a file size"); // back to the quality slider
  for (const [label, kind] of [
    ["AVIF", "avif"],
    ["WebP", "webp"],
  ] as const) {
    await app.choose("Format", label);
    await processAll(1);
    await app.click("button", /^Save result to a folder/);
    await app.waitFor(async () => saved().some((f) => f.startsWith("c.") && magic(readSaved(f)) === kind), `a ${kind} file`);
  }
});

test("AI upscale doubles the size on the native runtime", async () => {
  await app.click("button", /^Clear all$/);
  await app.addFiles(fixture("small.png", photo(60, 40, 4)));
  await app.waitFor(async () => (await statuses()).join() === "ready", "1 file inspected");
  await app.choose("Format", "PNG");
  await app.click("radio", "AI upscale");
  await app.click("radio", "2×");
  await processAll(1);
  const result = (await app.text('[data-testid="item-result"]')) ?? "";
  assert.match(result, /AI \((CPU|GPU)\) · PNG · 120 × 80/);
  await app.click("button", /^Save result to a folder/);
  await app.waitFor(async () => saved().some((f) => f.startsWith("small-120x80")), "the upscaled file");
  const name = saved().find((f) => f.startsWith("small-120x80"))!;
  const out = decodePng(readSaved(name));
  assert.equal(out.width, 120);
  assert.equal(out.height, 80);
});
