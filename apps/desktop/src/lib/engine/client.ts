import { EngineError, type ImageInfo } from "@/lib/shared";

import { NativeClient, callNative } from "../native/bridge";
import { decodeContainer } from "./codecs";
import type { EngineMethods } from "./protocol";

/**
 * Client for the native image engine. AVIF and HEIC files are decoded here
 * (the engine answers `NEEDS_UI_DECODER`) and sent to Rust as pixels.
 */
export class EngineClient extends NativeClient<EngineMethods> {
  constructor() {
    super("engine");
  }

  override async call<K extends keyof EngineMethods & string>(
    method: K,
    params: EngineMethods[K][0],
    transfer?: Transferable[],
    onProgress?: Parameters<NativeClient<EngineMethods>["call"]>[3],
  ): Promise<EngineMethods[K][1]> {
    try {
      return await super.call(method, params, transfer, onProgress);
    } catch (err) {
      if (!(err instanceof EngineError) || err.code !== "NEEDS_UI_DECODER" || (method !== "open" && method !== "process")) throw err;
      const { bytes, ...rest } = params as { bytes: ArrayBuffer };
      const decoded = await decodeForEngine(bytes);
      return this.invoke<EngineMethods[K][1]>(method === "open" ? "openRgba" : "processRgba", { ...rest, ...decoded }, onProgress);
    }
  }
}

/** Decodes AVIF/HEIC in the web view: pixels plus the container's info. */
export async function decodeForEngine(bytes: ArrayBuffer): Promise<{ pixels: Uint8Array; width: number; height: number; info: ImageInfo }> {
  const { info } = await callNative<{ info: ImageInfo }>("engine", "inspect", { bytes });
  if (info.animated)
    throw new EngineError("ANIMATED_NOT_SUPPORTED", "Animated images are not supported yet; only still images can be processed.");
  if (info.format !== "avif" && info.format !== "heic") throw new EngineError("UNSUPPORTED_FORMAT", "This image format is not supported.");
  const px = await decodeContainer(new Uint8Array(bytes), info.format);
  return { pixels: px.pixels, width: px.width, height: px.height, info };
}
