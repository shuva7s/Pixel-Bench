// Saving results with native dialogs. Files are written by the Rust side.

import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { callNative } from "./bridge";

let testDir: Promise<string | null> | null = null;

/**
 * Folder set by automated UI tests (PIXEL_BENCH_TEST_SAVE_DIR). When present,
 * saving writes there without a dialog, because WebDriver cannot drive native
 * dialogs. Always null in normal use.
 */
function testSaveDir(): Promise<string | null> {
  testDir ??= callNative<{ dir: string | null }>("fs", "testSaveDir")
    .then((r) => r.dir)
    .catch(() => null);
  return testDir;
}

/** Asks where to save `name`, then writes it. Returns the chosen path, or null if cancelled. */
export async function saveAs(name: string, bytes: ArrayBuffer | Blob): Promise<string | null> {
  const auto = await testSaveDir();
  if (auto) return saveInto(auto, name, bytes);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const path = await save({ defaultPath: name, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
  if (!path) return null;
  await callNative("fs", "write", { path, bytes: bytes instanceof Blob ? await bytes.arrayBuffer() : bytes });
  return path;
}

/** Asks for a folder. Returns its path, or null if cancelled. */
export async function chooseFolder(title: string): Promise<string | null> {
  const auto = await testSaveDir();
  if (auto) return auto;
  const dir = await open({ directory: true, title });
  return typeof dir === "string" ? dir : null;
}

/** Writes `name` into `dir`, adding " (1)", " (2)"… instead of overwriting. Returns the path written. */
export async function saveInto(dir: string, name: string, bytes: ArrayBuffer | Blob): Promise<string> {
  const r = await callNative<{ path: string }>("fs", "writeUnique", {
    dir,
    name,
    bytes: bytes instanceof Blob ? await bytes.arrayBuffer() : bytes,
  });
  return r.path;
}

/** Shows a saved file in Explorer / Finder / the file manager. */
export function showInFolder(path: string) {
  void revealItemInDir(path).catch(() => {});
}

/** Opens a web page in the system browser. */
export function openExternal(url: string) {
  void openUrl(url).catch(() => {});
}
