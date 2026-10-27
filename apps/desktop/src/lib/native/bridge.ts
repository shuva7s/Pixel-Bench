// Calls into the Rust backend over Tauri IPC.
//
// Every call goes through one command, `call`. The request body carries one
// binary field (a file's bytes or RGBA pixels) as raw bytes; everything else
// travels as JSON in a header. The reply is `[u32 json length][json][binary]`,
// so encoded files and preview pixels arrive as ArrayBuffers without base64.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { EngineError, type EngineErrorCode } from "@/lib/shared";

export interface Progress {
  /** Short description of the current step, e.g. "Downloading model". */
  label: string;
  /** 0..1, or null when the duration is unknown. */
  fraction: number | null;
}

export type Module = "engine" | "ai" | "fs";

let nextId = 1;
const progressHandlers = new Map<number, (p: Progress) => void>();
let listening: Promise<unknown> | null = null;

function listenForProgress() {
  listening ??= listen<{ id: number } & Progress>("native-progress", (e) => {
    progressHandlers.get(e.payload.id)?.({ label: e.payload.label, fraction: e.payload.fraction });
  });
  return listening;
}

/** Splits off the single ArrayBuffer field of `params`, if any. */
function splitBinary(params: unknown): { args: Record<string, unknown>; binary?: string; body: Uint8Array } {
  const args: Record<string, unknown> = { ...(params as Record<string, unknown> | undefined) };
  for (const [k, v] of Object.entries(args)) {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      delete args[k];
      const body = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      return { args, binary: k, body };
    }
  }
  return { args, body: new Uint8Array(0) };
}

function unpack(reply: ArrayBuffer): unknown {
  const view = new DataView(reply);
  const len = view.getUint32(0, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(reply, 4, len))) as Record<string, unknown> & { binaryField?: string };
  const field = json.binaryField;
  delete json.binaryField;
  if (field) json[field] = reply.slice(4 + len);
  return json;
}

/** True when running inside the desktop app (not a plain browser tab). */
export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function callNative<T>(module: Module, method: string, params?: unknown, onProgress?: (p: Progress) => void): Promise<T> {
  const id = nextId++;
  const { args, binary, body } = splitBinary(params);
  if (onProgress) {
    await listenForProgress();
    progressHandlers.set(id, onProgress);
  }
  try {
    const reply = await invoke<ArrayBuffer>("call", body, {
      headers: { "x-call": encodeURIComponent(JSON.stringify({ module, method, id, binary, args })) },
    });
    return unpack(reply) as T;
  } catch (err) {
    if (err instanceof EngineError) throw err;
    const e = err as { code?: string; message?: string } | string;
    if (typeof e === "object" && e && "code" in e) throw new EngineError((e.code ?? "ENGINE_CRASHED") as EngineErrorCode, e.message ?? "");
    throw new EngineError("ENGINE_CRASHED", typeof e === "string" ? e : String(err));
  } finally {
    progressHandlers.delete(id);
  }
}

/** Methods map: name → [params, result]. */
type Methods<M> = { [K in keyof M]: [unknown, unknown] };

/**
 * Same interface as the web version's worker client, so components did not
 * have to change. `transfer` is accepted and ignored (nothing is copied twice).
 *
 * Images opened through a client stay in native memory until closed;
 * `terminate()` (called when a page unmounts) closes any still open.
 */
export class NativeClient<M extends Methods<M>> {
  private readonly module: Module;
  private readonly handles = new Set<number>();

  constructor(module: Module) {
    this.module = module;
  }

  call<K extends keyof M & string>(
    method: K,
    params: M[K][0],
    _transfer?: Transferable[],
    onProgress?: (p: Progress) => void,
  ): Promise<M[K][1]> {
    return this.invoke<M[K][1]>(method, params, onProgress);
  }

  /** Calls the backend and keeps track of opened and closed images. */
  protected async invoke<T>(method: string, params: unknown, onProgress?: (p: Progress) => void): Promise<T> {
    const result = await callNative<T>(this.module, method, params, onProgress);
    const handle = (result as { handle?: unknown } | null)?.handle;
    if ((method === "open" || method === "openRgba") && typeof handle === "number") this.handles.add(handle);
    if (method === "close") this.handles.delete((params as { handle: number }).handle);
    return result;
  }

  /** Stops long-running work (AI upscaling) and frees every image this client opened. */
  terminate() {
    void callNative(this.module, "cancel").catch(() => {});
    for (const handle of this.handles) void callNative(this.module, "close", { handle }).catch(() => {});
    this.handles.clear();
  }
}
