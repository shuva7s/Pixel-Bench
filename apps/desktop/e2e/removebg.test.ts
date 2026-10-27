import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { disc, fixture, readSaved, saved } from "./env.ts";
import { decodePng, pixel } from "./png.ts";
import { App } from "./wd.ts";

let app: App;
before(async () => (app = await App.launch()));
after(() => app?.quit());

test("removes the background with the bundled model and exports a transparent PNG", async () => {
  await app.goto("remove-bg");
  await app.addFiles(fixture("disc.png", disc(400, 300)));
  const result = await app.waitFor(() => app.text('[data-testid="segment-result"]'), "the cut-out", 60_000);
  assert.match(result, /U²-Net \(small\) on (CPU|GPU)/);

  await app.click("button", /^Export PNG · 400 × 300$/);
  await app.waitFor(() => app.text('[data-testid="export-result"]'), "the export");
  const out = decodePng(readSaved(saved().find((f) => f.startsWith("disc-no-bg"))!));
  assert.ok(pixel(out, 200, 150)[3] > 200, "the subject is kept");
  assert.ok(pixel(out, 5, 5)[3] < 40, "the background is removed");

  // A colour backdrop re-composites without re-running the model.
  await app.click("radio", "Colour");
  await app.click("button", "Use #2563eb");
  await app.click("button", /^Export PNG · 400 × 300$/);
  await app.waitFor(async () => saved().filter((f) => f.startsWith("disc-no-bg")).length === 2, "the second export");
  const coloured = decodePng(readSaved("disc-no-bg (1).png"));
  assert.deepEqual(pixel(coloured, 5, 5), [0x25, 0x63, 0xeb, 255]);
  assert.deepEqual(pixel(coloured, 200, 150).slice(0, 3), [210, 40, 30]);
});

test("high quality asks before downloading anything", async () => {
  await app.click("radio", "High quality");
  const consent = await app.waitFor(() => app.text('[data-testid="consent"]'), "the consent card");
  assert.match(consent, /110 MB/);
  assert.match(consent, /Hugging Face/);
});
