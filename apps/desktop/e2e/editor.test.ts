import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { fixture, photo, readSaved, saved } from "./env.ts";
import { decodePng } from "./png.ts";
import { App } from "./wd.ts";

let app: App;
before(async () => (app = await App.launch()));
after(() => app?.quit());

const previewMean = () =>
  app.js<number>(`
    const c = document.querySelector('[data-testid="preview-canvas"]');
    if (!c || !c.width) return 0;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 4) / 3;`);

test("edits a photo with a live preview and exports it at full size", async () => {
  await app.goto("edit");
  await app.addFiles(fixture("portrait.png", photo(320, 240)));
  const before = await app.waitFor(previewMean, "the first preview");

  await app.setSlider("Exposure", 15);
  await app.waitFor(async () => (await previewMean()) > before + 15, "a brighter preview");

  await app.click("button", /^Export [A-Z]+ · /);
  await app.waitFor(() => app.text('[data-testid="export-result"]'), "the export");
  const files = saved().filter((f) => f.startsWith("portrait-edited"));
  assert.equal(files.length, 1, JSON.stringify(saved()));
  const out = decodePng(readSaved(files[0]!));
  assert.equal(out.width, 320);
  assert.equal(out.height, 240);
  // The export carries the edit, like the preview.
  const mean = out.data.reduce((s, v, i) => (i % 4 === 3 ? s : s + v), 0) / (out.width * out.height * 3);
  assert.ok(mean > before + 15, `export mean ${mean.toFixed(1)} vs original ${before.toFixed(1)}`);
  assert.equal(await app.errors(), "");
});
