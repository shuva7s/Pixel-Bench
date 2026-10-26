import type { EngineMethods } from "./protocol";
import { RpcClient } from "./rpc";

/** RPC client for the image engine worker. */
export class EngineClient extends RpcClient<EngineMethods> {
  constructor() {
    super(() => new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module", name: "image-engine" }));
  }
}
