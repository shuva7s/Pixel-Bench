import { EngineError } from "@image-tools/engine/shared";

/** Methods map: name → [params, result]. */
export type Methods<M> = { [K in keyof M]: [unknown, unknown] };

export interface Progress {
  /** Short description of the current step, e.g. "Downloading model". */
  label: string;
  /** 0..1, or null when the duration is unknown. */
  fraction: number | null;
}

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }
  | { id: number; progress: Progress };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: EngineError) => void;
  onProgress?: (p: Progress) => void;
}

/**
 * Promise-based RPC over a dedicated worker. If the worker crashes (e.g. out
 * of memory) it is replaced on the next call; calls in flight fail with
 * ENGINE_CRASHED.
 */
export class RpcClient<M extends Methods<M>> {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  readonly #spawn: () => Worker;

  constructor(spawn: () => Worker) {
    this.#spawn = spawn;
  }

  #start(): Worker {
    const worker = this.#spawn();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      const p = this.#pending.get(msg.id);
      if (!p) return;
      if ("progress" in msg) {
        p.onProgress?.(msg.progress);
        return;
      }
      this.#pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        p.reject(new EngineError(msg.error.code as never, msg.error.message));
        if (msg.error.code === "ENGINE_CRASHED") this.#reset("The worker crashed and was restarted.");
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.#reset(event.message || "The worker failed to start.");
    };
    return worker;
  }

  #reset(message: string) {
    this.#worker?.terminate();
    this.#worker = null;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) p.reject(new EngineError("ENGINE_CRASHED", message));
  }

  call<K extends keyof M & string>(
    method: K,
    params: M[K][0],
    transfer: Transferable[] = [],
    onProgress?: (p: Progress) => void,
  ): Promise<M[K][1]> {
    this.#worker ??= this.#start();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.#worker!.postMessage({ id, method, params }, transfer);
    });
  }

  /** Terminates the worker, releasing all of its memory. */
  terminate() {
    this.#reset("The worker was stopped.");
  }
}

/**
 * Worker-side request loop: runs handlers one at a time and reports progress.
 */
export function serve<M extends Methods<M>>(
  handlers: { [K in keyof M]: (params: M[K][0], progress: (p: Progress) => void) => M[K][1] | Promise<M[K][1]> },
  toError: (err: unknown) => { code: string; message: string },
  ready: Promise<unknown> = Promise.resolve(),
) {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  scope.onmessage = async (event: MessageEvent<{ id: number; method: keyof M; params: unknown }>) => {
    const { id, method, params } = event.data;
    const progress = (p: Progress) => scope.postMessage({ id, progress: p } satisfies WorkerResponse);
    try {
      await ready;
      const result = await (handlers[method] as (p: unknown, pr: typeof progress) => unknown)(params, progress);
      scope.postMessage({ id, ok: true, result } satisfies WorkerResponse, transferList(result));
    } catch (err) {
      scope.postMessage({ id, ok: false, error: toError(err) } satisfies WorkerResponse);
    }
  };
}

/** ArrayBuffers in a result's `bytes` / `pixels` fields are transferred, not copied. */
function transferList(result: unknown): Transferable[] {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    return [r.bytes, r.pixels, r.mask].filter((v): v is ArrayBuffer => v instanceof ArrayBuffer);
  }
  return [];
}
