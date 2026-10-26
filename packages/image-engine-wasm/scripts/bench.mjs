#!/usr/bin/env node
// Benchmarks the real WASM module in Node (V8, same engine as Chromium).
// Usage: pnpm --filter @image-tools/engine bench
import { readFileSync } from "node:fs";

import { EngineImage, initSync, process as processRaw } from "../pkg/image_engine.js";

initSync({ module: readFileSync(new URL("../pkg/image_engine_bg.wasm", import.meta.url)) });

const W = 6000;
const H = 4000;

// Build a photo-like test image (smooth gradients + mild noise) as BMP so
// the input decode cost is negligible and not codec-dependent.
function makeBmp(w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write("BM", 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  let seed = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const n = (seed >>> 28) - 8;
      const o = 54 + y * row + x * 3;
      buf[o] = Math.max(0, Math.min(255, ((x * 255) / w + n) | 0));
      buf[o + 1] = Math.max(0, Math.min(255, ((y * 255) / h + n) | 0));
      buf[o + 2] = Math.max(0, Math.min(255, (((x + y) * 128) / (w + h) + 64 + n) | 0));
    }
  }
  return new Uint8Array(buf);
}

function time(label, fn, runs = 3) {
  fn(); // warm-up
  const samples = [];
  let out;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const extra = out?.size ? `  → ${(out.size / 1024 / 1024).toFixed(2)} MB` : "";
  console.log(`${label.padEnd(44)} ${samples[Math.floor(runs / 2)].toFixed(0).padStart(6)} ms${extra}`);
}

const bmp = makeBmp(W, H);
const jpeg = (() => {
  const o = processRaw(bmp, "[]", '{"format":"jpeg","quality":85}');
  return o.takeBytes();
})();
console.log(`Test image: ${W}x${H} (${((W * H) / 1e6).toFixed(0)} MP); JPEG input ${(jpeg.length / 1024 / 1024).toFixed(2)} MB\n`);

const img = EngineImage.decode(bmp);
const enc = (json) => () => {
  const o = img.render("[]", json);
  const size = o.takeBytes().length;
  o.free();
  return { size };
};

time("decode JPEG", () => EngineImage.decode(jpeg).free());
time("encode JPEG q85", enc('{"format":"jpeg","quality":85}'));
time("encode JPEG q85 progressive", enc('{"format":"jpeg","quality":85,"progressive":true}'));
time("encode PNG fast", enc('{"format":"png","compression":"fast"}'));
time("encode PNG default", enc('{"format":"png","compression":"default"}'), 1);
time("encode WebP lossless", enc('{"format":"webp"}'), 1);
time("encode BMP", enc('{"format":"bmp"}'));
const ops = (o) => () => img.renderRgba(JSON.stringify([o])).free();
time("resize to 50% (Lanczos3)", ops({ op: "resize", size: { mode: "percent", percent: 50 }, filter: "lanczos3" }));
time("resize to 1920 px (Lanczos3)", ops({ op: "resize", size: { mode: "fit", maxWidth: 1920, maxHeight: 1920 } }));
time("rotate 90°", ops({ op: "rotate", degrees: 90 }));
time("flip horizontal", ops({ op: "flip", direction: "horizontal" }));
time("crop to centre quarter", ops({ op: "crop", x: 1500, y: 1000, width: 3000, height: 2000 }));
time("straighten 3°", ops({ op: "straighten", degrees: 3 }));
const light = { op: "develop", exposure: 0.5, contrast: 20, highlights: -30, shadows: 25, temperature: 10, vibrance: 20 };
time("develop: light + colour", ops(light));
time("develop: + colour mixer", ops({ ...light, mixerHue: [10, 0, 0, 20, 0, -10, 0, 0], mixerSaturation: [0, 0, 0, -20, 0, 30, 0, 0] }));
time("develop: + clarity + sharpen", ops({ ...light, clarity: 30, sharpenAmount: 60 }));
time("develop: + vignette + grain", ops({ ...light, vignette: -30, grain: 20 }));
for (const side of [1400, 1200]) {
  const t = img.thumbnail(side);
  const all = JSON.stringify([{ ...light, mixerHue: [10, 0, 0, 0, 0, 0, 0, 0], clarity: 30, sharpenAmount: 60, vignette: -20 }]);
  time(`editor preview ${side}px: everything on`, () => t.renderRgba(all).free(), 5);
  t.free();
}
img.free();
