// ONNX Runtime Web setup for the AI worker. The runtime (~28 MB) and the
// models are fetched only when an AI tool is first used. Models are verified
// against their pinned SHA-256 before use and kept in Cache Storage.

import { EngineError } from "@image-tools/engine/shared";
import type * as Ort from "onnxruntime-web";

import type { Progress } from "../engine/rpc";
import { MODEL_CACHE, MODELS, siteUrl, type ModelId, type ModelSpec } from "./models";
import type { Backend, DevicePreference } from "./protocol";

let ortPromise: Promise<typeof Ort> | null = null;

/** Loads ONNX Runtime from /vendor/ort/ (served as-is, not bundled). */
function loadOrt(): Promise<typeof Ort> {
  ortPromise ??= (async () => {
    const base = new URL(siteUrl("/vendor/ort/"), self.location.origin).href;
    const ort = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ `${base}ort.webgpu.min.mjs`)) as typeof Ort;
    ort.env.wasm.wasmPaths = base;
    // Threads need cross-origin isolation (COOP/COEP headers); without it ORT runs single-threaded.
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    ort.env.logLevel = "error";
    return ort;
  })().catch((err: unknown) => {
    ortPromise = null;
    throw new EngineError("MODEL_LOAD_FAILED", `Could not load the AI runtime: ${err instanceof Error ? err.message : String(err)}`);
  });
  return ortPromise;
}

let gpuPromise: Promise<boolean> | null = null;

/** True when a WebGPU adapter is available in this worker. */
export function hasWebGpu(): Promise<boolean> {
  gpuPromise ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    try {
      return (await gpu.requestAdapter()) !== null;
    } catch {
      return false;
    }
  })();
  return gpuPromise;
}

function cacheKey(spec: ModelSpec): string {
  return new URL(siteUrl(`/__model-cache/${spec.id}-${spec.sha256.slice(0, 16)}.onnx`), self.location.origin).href;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(MODEL_CACHE);
  } catch {
    return null;
  }
}

/** Ids of models already downloaded and cached on this device. */
export async function cachedModels(): Promise<ModelId[]> {
  const cache = await openCache();
  if (!cache) return [];
  const ids: ModelId[] = [];
  for (const spec of Object.values(MODELS)) if (await cache.match(cacheKey(spec))) ids.push(spec.id);
  return ids;
}

/** Downloads (or reads from cache) and verifies a model. */
export async function fetchModel(spec: ModelSpec, progress: (p: Progress) => void): Promise<Uint8Array> {
  const cache = await openCache();
  const hit = await cache?.match(cacheKey(spec));
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    if ((await sha256Hex(bytes)) === spec.sha256) return bytes;
    await cache?.delete(cacheKey(spec));
  }

  const label = `Downloading ${spec.name}`;
  progress({ label, fraction: 0 });
  let res: Response;
  try {
    res = await fetch(siteUrl(spec.url), { credentials: "omit" });
  } catch {
    throw new EngineError("MODEL_DOWNLOAD_FAILED", `Could not download ${spec.name}. Check your connection and try again.`);
  }
  if (!res.ok || !res.body) {
    throw new EngineError("MODEL_DOWNLOAD_FAILED", `Could not download ${spec.name} (HTTP ${res.status}).`);
  }
  const bytes = new Uint8Array(spec.bytes);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > spec.bytes) {
      await reader.cancel();
      throw new EngineError("MODEL_INVALID", `${spec.name} is larger than expected, so it was not used.`);
    }
    bytes.set(value, received);
    received += value.byteLength;
    progress({ label, fraction: received / spec.bytes });
  }
  if (received !== spec.bytes || (await sha256Hex(bytes)) !== spec.sha256) {
    throw new EngineError(
      "MODEL_INVALID",
      `${spec.name} failed its integrity check (the download was incomplete or changed), so it was not used.`,
    );
  }
  try {
    await cache?.put(cacheKey(spec), new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
  } catch {
    // Storage full or unavailable: the model still works for this session.
  }
  return bytes;
}

interface Loaded {
  id: ModelId;
  session: Ort.InferenceSession;
  backend: Backend;
}

const sessions = new Map<string, Loaded>();
/** Model bytes of the loaded session, kept for a CPU retry after a GPU failure. */
let loadedBytes: Uint8Array | null = null;

// Severity 3 = errors only: the exported graphs trigger many harmless optimiser warnings.
const SESSION_OPTIONS: Ort.InferenceSession.SessionOptions = { graphOptimizationLevel: "all", logSeverityLevel: 3 };

async function createCpuSession(id: ModelId, bytes: Uint8Array): Promise<Loaded> {
  const ort = await loadOrt();
  return { id, session: await ort.InferenceSession.create(bytes, { ...SESSION_OPTIONS, executionProviders: ["wasm"] }), backend: "wasm" };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Returns an inference session, preferring WebGPU and falling back to the
 * CPU (WebAssembly), except for models that only fit on the GPU. Only one
 * model is kept loaded at a time to bound memory.
 */
export async function getSession(id: ModelId, device: DevicePreference, progress: (p: Progress) => void): Promise<Loaded> {
  const spec = MODELS[id];
  const wantGpu = device === "auto" && (await hasWebGpu());
  if (spec.requiresGpu && !wantGpu) {
    throw new EngineError(
      "MODEL_LOAD_FAILED",
      `${spec.name} needs WebGPU, which this browser doesn't provide. Use the Fast model instead.`,
    );
  }
  const key = `${id}:${wantGpu ? "gpu" : "cpu"}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  for (const [k, s] of sessions) {
    void s.session.release();
    sessions.delete(k);
  }

  const ort = await loadOrt();
  const bytes = await fetchModel(spec, progress);
  loadedBytes = bytes;
  progress({ label: "Preparing the model", fraction: null });
  const options = SESSION_OPTIONS;
  let loaded: Loaded | null = null;
  if (wantGpu) {
    try {
      loaded = { id, session: await ort.InferenceSession.create(bytes, { ...options, executionProviders: ["webgpu"] }), backend: "webgpu" };
    } catch (err) {
      if (spec.requiresGpu) throw new EngineError("MODEL_LOAD_FAILED", `Could not start ${spec.name} on the GPU: ${message(err)}`);
      // Otherwise fall back to the CPU below.
    }
  }
  if (!loaded) {
    try {
      loaded = await createCpuSession(id, bytes);
    } catch (err) {
      throw new EngineError("MODEL_LOAD_FAILED", `Could not start ${spec.name}: ${message(err)}`);
    }
  }
  sessions.set(key, loaded);
  return loaded;
}

/**
 * Runs a single-input, single-output model on a float32 NCHW tensor. If the
 * GPU fails at run time and the model can run on the CPU, the session is
 * switched to the CPU (for this and later calls) and the run is retried once.
 */
export async function run(loaded: Loaded, data: Float32Array, dims: [number, number, number, number]): Promise<Float32Array> {
  try {
    return await runOnce(loaded, data, dims);
  } catch (err) {
    if (loaded.backend !== "webgpu" || MODELS[loaded.id].requiresGpu || !loadedBytes) {
      throw new EngineError("INFERENCE_FAILED", `The AI model failed to run: ${message(err)}`);
    }
    const cpu = await createCpuSession(loaded.id, loadedBytes);
    void loaded.session.release();
    loaded.session = cpu.session;
    loaded.backend = "wasm";
    try {
      return await runOnce(loaded, data, dims);
    } catch (retryErr) {
      throw new EngineError("INFERENCE_FAILED", `The AI model failed to run: ${message(retryErr)}`);
    }
  }
}

async function runOnce(loaded: Loaded, data: Float32Array, dims: [number, number, number, number]): Promise<Float32Array> {
  const ort = await loadOrt();
  const { session } = loaded;
  const input = new ort.Tensor("float32", data, dims);
  try {
    const out = await session.run({ [session.inputNames[0]!]: input });
    const tensor = out[session.outputNames[0]!]!;
    const raw = tensor.location === "cpu" ? tensor.data : await tensor.getData();
    const values = tensor.type === "float16" ? halfToFloat(raw as Uint16Array) : (raw as Float32Array);
    for (const t of Object.values(out)) t.dispose();
    return values;
  } finally {
    input.dispose();
  }
}

/** float16 output (raw bits, or a Float16Array where supported) → float32. */
function halfToFloat(data: ArrayLike<number>): Float32Array {
  if (!(data instanceof Uint16Array)) return Float32Array.from(data);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const h = data[i]!;
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    out[i] =
      exp === 0
        ? sign * 2 ** -14 * (frac / 1024)
        : exp === 31
          ? frac
            ? NaN
            : sign * Infinity
          : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return out;
}
