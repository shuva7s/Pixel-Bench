import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, grepInvert: /@webgpu-only/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
    // AI on a real GPU. Needs Google Chrome installed (Playwright's bundled
    // Chromium has no WebGPU adapter here); opt in with E2E_WEBGPU=1.
    ...(process.env.E2E_WEBGPU === "1"
      ? [
          {
            name: "webgpu",
            use: { ...devices["Desktop Chrome"], channel: "chrome", launchOptions: { args: ["--enable-unsafe-webgpu"] } },
            grep: /@webgpu/,
          },
        ]
      : []),
  ],
  // Tests run against the production static export (`pnpm build` first).
  webServer: {
    command: "node scripts/serve.mjs",
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
