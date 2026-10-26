#!/usr/bin/env node
// Builds the Rust engine for wasm32 and generates the JS glue into ./pkg.
//
// Requires: cargo with the wasm32-unknown-unknown target, and wasm-bindgen-cli
// matching the `wasm-bindgen` crate version pinned in Cargo.toml.
//
// Set IMAGE_TOOLS_RUST=wsl on Windows machines where native Rust builds are
// blocked (e.g. by Smart App Control); the Rust steps then run inside WSL.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgDir, "../..");
const outDir = join(pkgDir, "pkg");
const useWsl = process.env.IMAGE_TOOLS_RUST === "wsl";
const profile = process.argv.includes("--dev") ? "debug" : "release";

const cargoToml = readFileSync(join(pkgDir, "Cargo.toml"), "utf8");
const bindgenVersion = /wasm-bindgen = "=([\d.]+)"/.exec(cargoToml)?.[1];
if (!bindgenVersion) throw new Error("Could not find the pinned wasm-bindgen version in Cargo.toml");

function toWslPath(p) {
  return execFileSync("wsl.exe", ["wslpath", "-a", p.replaceAll("\\", "/")], { encoding: "utf8" }).trim();
}

const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * Runs a shell command in the repo root, natively or inside WSL, and resolves
 * with its stdout. Output is always read through pipes and forwarded by this
 * process: when wsl.exe writes straight into a pipe inherited from
 * `pnpm run`, pnpm 12 on Windows exits with code 5 even though the command
 * succeeded.
 */
function sh(command, { capture = false } = {}) {
  let file;
  let args;
  if (useWsl) {
    // Keep the cargo target dir on the Linux filesystem: much faster than /mnt/c.
    const script = `set -e; source "$HOME/.cargo/env" 2>/dev/null || true; cd ${q(toWslPath(repoRoot))}; export CARGO_TARGET_DIR="$HOME/.cache/image-tools-target"; ${command}`;
    [file, args] = ["wsl.exe", ["-e", "bash", "-lc", script]];
  } else if (process.platform === "win32") {
    [file, args] = ["cmd.exe", ["/d", "/s", "/c", command]];
  } else {
    [file, args] = ["sh", ["-c", command]];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (capture ? (stdout += d) : process.stdout.write(d)));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`"${command}" exited with code ${code}`))));
  });
}

const installed = (await sh("wasm-bindgen --version", { capture: true }).catch(() => "")).trim();
if (!installed.endsWith(bindgenVersion)) {
  console.error(
    `wasm-bindgen-cli ${bindgenVersion} is required, found "${installed || "none"}".\n` +
      `Install it with: cargo install wasm-bindgen-cli --version ${bindgenVersion} --locked`,
  );
  process.exit(1);
}

const releaseFlag = profile === "release" ? "--release" : "";
await sh(`cargo build -p image-engine-wasm -p avif-encoder-wasm --lib --target wasm32-unknown-unknown ${releaseFlag}`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "avif"), { recursive: true });
const targetDir = useWsl ? "$CARGO_TARGET_DIR" : (process.env.CARGO_TARGET_DIR ?? "target").replaceAll("\\", "/");
const wasmPath = (crate) => `"${targetDir}/wasm32-unknown-unknown/${profile}/${crate}.wasm"`;
const outPath = (dir) => (useWsl ? q(toWslPath(dir)) : `"${dir}"`);
// Main engine, loaded by every tool.
await sh(`wasm-bindgen ${wasmPath("image_engine_wasm")} --target web --out-dir ${outPath(outDir)} --out-name image_engine`);
// AVIF encoder, loaded only when AVIF output is chosen.
await sh(`wasm-bindgen ${wasmPath("avif_encoder_wasm")} --target web --out-dir ${outPath(join(outDir, "avif"))} --out-name avif_encoder`);

const kib = (f) => (statSync(join(outDir, f)).size / 1024).toFixed(0);
console.log(
  `Built pkg/image_engine_bg.wasm (${kib("image_engine_bg.wasm")} KiB) and pkg/avif/avif_encoder_bg.wasm (${kib("avif/avif_encoder_bg.wasm")} KiB), ${profile}`,
);
