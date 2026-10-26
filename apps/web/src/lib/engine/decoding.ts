// Decoding shared by the engine and AI workers: the Rust engine for most
// formats, the browser (or libheif) for AVIF/HEIC.
import { DecodedImage, EngineError, inspectImage, type ImageInfo } from "@image-tools/engine";

import { decodeContainer, inspectContainer, sniffContainer } from "./codecs";

/** Mirrors the engine's DEFAULT_LIMITS. */
export const MAX_PIXELS = 50_000_000;
export const MAX_SIDE = 20_000;

/** Inspects any supported file, including AVIF/HEIC (decoded by the browser). */
export function inspectAny(bytes: Uint8Array): ImageInfo {
  const container = sniffContainer(bytes);
  return container ? inspectContainer(bytes, container) : inspectImage(bytes);
}

/** Decodes any supported file into the engine. */
export async function decodeAny(bytes: Uint8Array): Promise<{ image: DecodedImage; info: ImageInfo }> {
  const container = sniffContainer(bytes);
  if (!container) return { image: DecodedImage.decode(bytes), info: inspectImage(bytes) };
  const info = inspectContainer(bytes, container);
  if (info.animated)
    throw new EngineError("ANIMATED_NOT_SUPPORTED", "Animated images are not supported yet; only still images can be processed.");
  if (info.width * info.height > MAX_PIXELS || Math.max(info.width, info.height) > MAX_SIDE) {
    throw new EngineError("TOO_LARGE", `${info.width}x${info.height} exceeds the maximum of 50 MP or 20,000 px per side.`);
  }
  const px = await decodeContainer(bytes, container.format);
  const image = DecodedImage.fromRgba(px.pixels, px.width, px.height);
  return { image, info: { ...info, width: px.width, height: px.height, hasAlphaChannel: image.hasTransparency() } };
}
