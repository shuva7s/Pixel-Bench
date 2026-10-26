#!/usr/bin/env node
// Next.js 16.4 static export writes per-segment prefetch payloads as nested
// directories (e.g. `__next.tools/$d$tool/__PAGE__.txt`), while its client
// router requests the flattened name (`__next.tools.$d$tool.__PAGE__.txt`).
// Static hosts then answer 404 for every link prefetch. This step writes a
// flattened copy next to each nested file so any static host serves them.
import { copyFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../out", import.meta.url));
let copied = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (name.startsWith("__next.")) flatten(dir, full);
    else walk(full);
  }
}

/** Copies every file below `segmentDir` to `<parent>/<dotted path>`. */
function flatten(parent, segmentDir) {
  const stack = [segmentDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else {
        const dotted = relative(parent, full).split(sep).join(".");
        copyFileSync(full, join(parent, dotted));
        copied++;
      }
    }
  }
}

walk(out);
console.log(`fix-export: wrote ${copied} flattened segment prefetch files`);
