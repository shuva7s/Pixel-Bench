import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static files loaded by the desktop app's window (Tauri); all processing
  // happens in the native Rust backend.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // libheif's Emscripten loader has a Node-only branch that requires `fs`;
  // it never runs in the web view, so resolve it to an empty module.
  turbopack: {
    resolveAlias: {
      fs: { browser: "./src/lib/empty-module.ts" },
    },
  },
  reactStrictMode: true,
};

export default nextConfig;
