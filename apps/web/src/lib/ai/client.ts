import { RpcClient } from "../engine/rpc";
import type { AiMethods } from "./protocol";

/** RPC client for the AI worker (background removal and upscaling). */
export class AiClient extends RpcClient<AiMethods> {
  constructor() {
    super(() => new Worker(new URL("./ai.worker.ts", import.meta.url), { type: "module", name: "ai-tools" }));
  }
}
