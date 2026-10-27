import { EngineError } from "@/lib/shared";

import { decodeForEngine } from "../engine/client";
import { NativeClient } from "../native/bridge";
import type { AiMethods } from "./protocol";

/** Client for the native AI tools (background removal and upscaling). */
export class AiClient extends NativeClient<AiMethods> {
  constructor() {
    super("ai");
  }

  override async call<K extends keyof AiMethods & string>(
    method: K,
    params: AiMethods[K][0],
    transfer?: Transferable[],
    onProgress?: Parameters<NativeClient<AiMethods>["call"]>[3],
  ): Promise<AiMethods[K][1]> {
    try {
      return await super.call(method, params, transfer, onProgress);
    } catch (err) {
      // AVIF/HEIC: decode in the web view, then send pixels.
      if (!(err instanceof EngineError) || err.code !== "NEEDS_UI_DECODER" || (method !== "open" && method !== "upscale")) throw err;
      const { bytes, ...rest } = params as { bytes: ArrayBuffer };
      const decoded = await decodeForEngine(bytes);
      return this.invoke<AiMethods[K][1]>(method === "open" ? "openRgba" : "upscaleRgba", { ...rest, ...decoded }, onProgress);
    }
  }
}
