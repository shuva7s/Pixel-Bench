#!/usr/bin/env node
// Minimal static server for the exported site (apps/web/out). Used by
// `pnpm start` and the Playwright tests; production hosting can be any
// static file host.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../out", import.meta.url)));
const port = Number(process.env.PORT ?? 3000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".onnx": "application/octet-stream",
};

// Cross-origin isolation lets the AI runtime use several threads (see public/_headers).
const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function resolveFile(urlPath) {
  const safe = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  const full = join(root, safe);
  if (!full.startsWith(root)) return null;
  for (const candidate of [full, join(full, "index.html"), `${full}.html`]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const file = resolveFile(path) ?? resolveFile("404.html");
  if (!file) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(file.endsWith("404.html") && !path.endsWith("404.html") ? 404 : 200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    ...ISOLATION,
  });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Serving ${root} on http://localhost:${port}`));
