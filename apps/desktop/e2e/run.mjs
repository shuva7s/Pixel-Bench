#!/usr/bin/env node
// Runs the end-to-end tests against the real desktop app via tauri-driver.
//
// Linux (CI): needs a debug build (`cargo build -p pixel-bench --features
// tauri/custom-protocol`), tauri-driver, WebKitWebDriver and xvfb.
// Windows with WSL: the same, built inside WSL; this script starts the driver
// in WSL and the tests talk to it over localhost.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("./.output", import.meta.url));
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/saved`, { recursive: true });
mkdirSync(`${out}/fixtures`, { recursive: true });

const onWindows = process.platform === "win32";
const wsl = (cmd) => spawnSync("wsl.exe", ["-d", "Ubuntu", "-e", "bash", "-lc", cmd], { encoding: "utf8" }).stdout.trim();
// Paths as the app sees them.
const appOut = onWindows ? wsl(`wslpath -a '${out.replace(/\\/g, "/")}'`) : out;
const app =
  process.env.E2E_APP ??
  (onWindows
    ? wsl('echo "${CARGO_TARGET_DIR:-$HOME/.cache/image-tools-target}/debug/pixel-bench"')
    : fileURLToPath(new URL("../../../target/debug/pixel-bench", import.meta.url)));

const driverEnv = `PIXEL_BENCH_TEST_SAVE_DIR='${appOut}/saved' WEBKIT_DISABLE_DMABUF_RENDERER=1`;
const driverCmd = `xvfb-run -a -s '-screen 0 1400x900x24' tauri-driver --port 4444`;
if (onWindows) wsl("pkill -x tauri-driver; pkill -x WebKitWebDriver; pkill -f '/debug/pixel-bench$'; true");
const driver = onWindows
  ? spawn(
      "wsl.exe",
      [
        "-d",
        "Ubuntu",
        "-e",
        "bash",
        "-lc",
        `export ${driverEnv}; exec ${driverCmd.replace("tauri-driver", "$HOME/.cargo/bin/tauri-driver")}`,
      ],
      { stdio: "ignore" },
    )
  : spawn("bash", ["-lc", `export ${driverEnv}; exec ${driverCmd}`], { stdio: "ignore" });

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try {
    ready = (await fetch("http://127.0.0.1:4444/status")).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!ready) {
  console.error("tauri-driver did not start on port 4444");
  driver.kill();
  process.exit(1);
}

const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `${here}${f}`);
const tests = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...process.argv.slice(2), ...files], {
  stdio: "inherit",
  env: { ...process.env, E2E_APP: app, E2E_OUT: out, E2E_OUT_APP: appOut },
});
driver.kill();
if (onWindows) wsl("pkill -x tauri-driver; pkill -x WebKitWebDriver; pkill -f '/debug/pixel-bench$'; true");
process.exit(tests.status ?? 1);
