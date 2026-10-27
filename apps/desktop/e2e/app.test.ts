import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { App } from "./wd.ts";

let app: App;
before(async () => (app = await App.launch()));
after(() => app?.quit());

test("opens on the home page with the three tools", async () => {
  assert.match((await app.text("h1")) ?? "", /without uploading/);
  for (const page of ["edit", "utilities", "remove-bg", "about"] as const) {
    await app.goto(page);
    assert.ok(await app.text("h1, h2"), `${page} has a heading`);
  }
});

test("the interface talks to the native backend", async () => {
  const caps = await app.jsAsync<{ gpu: string | null; cached: string[] }>(`
    const body = await window.__TAURI_INTERNALS__.invoke("call", new Uint8Array(0), {
      headers: { "x-call": encodeURIComponent(JSON.stringify({ module: "ai", method: "capabilities", id: 1, args: {} })) },
    });
    const n = new DataView(body).getUint32(0, true);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(body, 4, n)));`);
  // The two small models ship with the app.
  assert.ok(caps.cached.includes("u2netp"), JSON.stringify(caps));
  assert.ok(caps.cached.includes("realesrgan-x4v3"), JSON.stringify(caps));
});
