// Shared test environment: fixture files and saved outputs, with their paths
// as the test (Windows or Linux) and as the app (Linux / WSL) see them.

import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { encodePng, image, type Image } from "./png.ts";

const OUT = process.env.E2E_OUT!;
const OUT_APP = process.env.E2E_OUT_APP!;

/** Writes a fixture and returns its path for the app. */
export function fixture(name: string, bytes: Buffer | Image): string {
  writeFileSync(join(OUT, "fixtures", name), Buffer.isBuffer(bytes) ? bytes : encodePng(bytes));
  return `${OUT_APP}/fixtures/${name}`;
}

/** Copies a file from e2e/fixtures and returns its path for the app. */
export function repoFixture(name: string): string {
  copyFileSync(new URL(`./fixtures/${name}`, import.meta.url), join(OUT, "fixtures", name));
  return `${OUT_APP}/fixtures/${name}`;
}

/** Names of files saved by the app so far. */
export function saved(): string[] {
  return readdirSync(join(OUT, "saved")).sort();
}

export function readSaved(name: string): Buffer {
  return readFileSync(join(OUT, "saved", name));
}

/** A red disc on a textured green/blue background: an unambiguous subject. */
export function disc(w = 400, h = 300): Image {
  return image(w, h, (x, y) => {
    const inside = ((x - w / 2) / (w * 0.23)) ** 2 + ((y - h / 2) / (h * 0.33)) ** 2 < 1;
    return inside ? [210, 40, 30, 255] : [60 + 30 * Math.sin(x / 9), 140 + 25 * Math.cos(y / 7), 120, 255];
  });
}

/** Smooth photo-like gradient with some texture. */
export function photo(w: number, h: number, seed = 1): Image {
  let s = seed;
  return image(w, h, (x, y) => {
    s = (s * 1103515245 + 12345) >>> 0;
    const n = (s >>> 27) - 16;
    return [(x * 255) / w + n, (y * 255) / h + n, 128 + 60 * Math.sin((x + y) / 17) + n, 255];
  });
}
