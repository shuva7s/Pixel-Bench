import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Fully static site: all processing happens in the browser, so no server is
  // needed and the output can be hosted on any static host.
  output: "export",
  basePath: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@image-tools/engine"],
  // libheif's Emscripten loader has a Node-only branch that requires `fs`;
  // it never runs in the browser, so resolve it to an empty module.
  turbopack: {
    resolveAlias: {
      fs: { browser: "./src/lib/empty-module.ts" },
    },
  },
  reactStrictMode: true,
};

export default nextConfig;
