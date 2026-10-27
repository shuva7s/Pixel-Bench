#!/usr/bin/env node
// Copies libheif (HEIC decoding in the web view) into public/vendor with its
// licence. libheif is LGPL-3.0: it is shipped unmodified as a separate file
// so it can be replaced independently.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const out = fileURLToPath(new URL("../public/vendor", import.meta.url));
mkdirSync(out, { recursive: true });

const heif = dirname(require.resolve("libheif-js/package.json"));
copyFileSync(join(heif, "libheif-wasm", "libheif.wasm"), join(out, "libheif.wasm"));
copyFileSync(join(heif, "LICENSE"), join(out, "libheif-LICENSE.txt"));
console.log("copy-vendor: libheif copied to public/vendor");
