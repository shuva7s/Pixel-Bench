// Integration tests against the real compiled WASM module (pkg/).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DecodedImage,
  EngineError,
  FORMAT_IDS,
  FORMATS,
  engineLimits,
  initEngineSync,
  inspectImage,
  processImage,
  type EncodeOptions,
  type ImageFormat,
  inspectMetadata,
  stripMetadata,
} from "../src/index";
import { encodeAvif, initAvifSync } from "../src/avif";
import { actlChunk, magic, makePng, pixels, samplePng } from "./fixtures";

const wasmPath = fileURLToPath(new URL("../pkg/image_engine_bg.wasm", import.meta.url));

// Initialise at load time: some suites build fixtures while being collected.
initEngineSync(readFileSync(wasmPath));

const enc = (format: ImageFormat): EncodeOptions => ({ format }) as EncodeOptions;

/** Formats the main engine both decodes and encodes at the same size. */
const ENGINE_FORMATS = FORMAT_IDS.filter((f) => f !== "avif" && f !== "ico");

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("initialisation", () => {
  it("exposes limits", () => {
    const l = engineLimits();
    expect(l.maxPixels).toBeGreaterThan(1_000_000);
    expect(l.maxSide).toBeGreaterThan(4000);
  });
});

describe("inspection", () => {
  it("reads a PNG header", () => {
    const info = inspectImage(samplePng(40, 30));
    expect(info).toMatchObject({
      format: "png",
      mimeType: "image/png",
      width: 40,
      height: 30,
      colorModel: "rgba",
      hasAlphaChannel: true,
      animated: false,
    });
  });

  it("detects animation and rejects decoding it", () => {
    const apng = makePng(2, 2, new Uint8Array(16), { extraChunks: [actlChunk()] });
    expect(inspectImage(apng).animated).toBe(true);
    expectCode(() => DecodedImage.decode(apng), "ANIMATED_NOT_SUPPORTED");
  });
});

describe("format conversion", () => {
  const src = samplePng(37, 23);
  const inputs = Object.fromEntries(ENGINE_FORMATS.map((f) => [f, processImage(src, [], enc(f)).bytes])) as Record<ImageFormat, Uint8Array>;

  for (const from of ENGINE_FORMATS) {
    for (const to of ENGINE_FORMATS) {
      it(`${from} -> ${to}`, () => {
        const out = processImage(inputs[from], [], enc(to));
        expect(magic(out.bytes)).toBe(to);
        expect(out.mimeType).toBe(FORMATS[to].mimeType);
        expect(out.extension).toBe(FORMATS[to].extension);
        expect([out.width, out.height]).toEqual([37, 23]);
        const info = inspectImage(out.bytes);
        expect([info.format, info.width, info.height]).toEqual([to, 37, 23]);
      });
    }
  }

  it("preserves transparency in PNG and WebP", () => {
    for (const f of ["png", "webp"] as const) {
      const img = DecodedImage.decode(processImage(src, [], enc(f)).bytes);
      expect(img.hasTransparency()).toBe(true);
      const { pixels: px } = img.renderRgba([]);
      expect(px[3]).toBe(0); // (0,0) fully transparent
      expect(px[4 * 1 + 3]).toBe(128); // (1,0) half transparent
      img.dispose();
    }
  });

  it("flattens JPEG/BMP onto the chosen background", () => {
    const clear = makePng(8, 8, new Uint8Array(8 * 8 * 4));
    for (const opts of [
      { format: "jpeg", quality: 95, background: [0, 128, 255] },
      { format: "bmp", background: [0, 128, 255] },
    ] as EncodeOptions[]) {
      const img = DecodedImage.decode(processImage(clear, [], opts).bytes);
      expect(img.hasTransparency()).toBe(false);
      const px = img.renderRgba([]).pixels;
      expect(Math.abs(px[0]! - 0)).toBeLessThan(4);
      expect(Math.abs(px[1]! - 128)).toBeLessThan(4);
      expect(Math.abs(px[2]! - 255)).toBeLessThan(4);
      img.dispose();
    }
  });
});

describe("compression", () => {
  // Noise so quality matters.
  let seed = 7;
  const noisy = makePng(
    96,
    96,
    pixels(96, 96, () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const v = seed >>> 24;
      return [v, (v * 3) & 255, (v + 50) & 255, 255];
    }),
  );

  it("lower JPEG quality yields smaller files", () => {
    const size = (quality: number) => processImage(noisy, [], { format: "jpeg", quality }).bytes.length;
    expect(size(20)).toBeLessThan(size(60));
    expect(size(60)).toBeLessThan(size(95));
  });

  it("PNG compression levels are all lossless", () => {
    const ref = DecodedImage.decode(noisy).renderRgba([]).pixels;
    for (const compression of ["fast", "default", "best"] as const) {
      const out = processImage(noisy, [], { format: "png", compression });
      expect(DecodedImage.decode(out.bytes).renderRgba([]).pixels).toEqual(ref);
    }
  });

  it("rejects invalid quality", () => {
    expectCode(() => processImage(noisy, [], { format: "jpeg", quality: 0 }), "INVALID_OPTIONS");
    expectCode(() => processImage(noisy, [], { format: "jpeg", quality: 101 }), "INVALID_OPTIONS");
  });
});

describe("transforms", () => {
  const src = samplePng(40, 30);

  it("resizes exactly, by fit and by percent", () => {
    const img = DecodedImage.decode(src);
    expect(img.render([{ op: "resize", size: { mode: "exact", width: 13, height: 7 } }], enc("png"))).toMatchObject({
      width: 13,
      height: 7,
    });
    expect(img.render([{ op: "resize", size: { mode: "fit", maxWidth: 20, maxHeight: 20 } }], enc("png"))).toMatchObject({
      width: 20,
      height: 15,
    });
    expect(img.render([{ op: "resize", size: { mode: "percent", percent: 50 }, filter: "nearest" }], enc("png"))).toMatchObject({
      width: 20,
      height: 15,
    });
    expectCode(() => img.render([{ op: "resize", size: { mode: "exact", width: 0, height: 5 } }], enc("png")), "INVALID_DIMENSIONS");
    expectCode(() => img.render([{ op: "resize", size: { mode: "exact", width: 50_000, height: 5 } }], enc("png")), "TOO_LARGE");
    img.dispose();
  });

  it("crops and validates bounds", () => {
    const img = DecodedImage.decode(src);
    const out = img.renderRgba([{ op: "crop", x: 5, y: 4, width: 10, height: 6 }]);
    expect([out.width, out.height]).toEqual([10, 6]);
    expect(out.pixels[0]).toBe(Math.floor((5 * 255) / 40));
    expectCode(() => img.renderRgba([{ op: "crop", x: 35, y: 0, width: 10, height: 6 }]), "INVALID_CROP");
    img.dispose();
  });

  it("rotates and flips with correct dimensions and pixels", () => {
    const img = DecodedImage.decode(src);
    for (const [degrees, w, h] of [
      [90, 30, 40],
      [180, 40, 30],
      [270, 30, 40],
    ] as const) {
      const out = img.renderRgba([{ op: "rotate", degrees }]);
      expect([out.width, out.height]).toEqual([w, h]);
    }
    // After a horizontal flip the transparent column is on the right.
    const flipped = img.renderRgba([{ op: "flip", direction: "horizontal" }]);
    expect(flipped.pixels[39 * 4 + 3]).toBe(0);
    expect(flipped.pixels[3]).toBe(128);
    // After a vertical flip the half-transparent row is at the bottom.
    const v = img.renderRgba([{ op: "flip", direction: "vertical" }]);
    expect(v.pixels[(29 * 40 + 5) * 4 + 3]).toBe(128);
    img.dispose();
  });

  it("applies develop settings", () => {
    const img = DecodedImage.decode(makePng(1, 1, new Uint8Array([100, 150, 200, 255])));
    const px = (d: object) => Array.from(img.renderRgba([{ op: "develop", ...d }]).pixels);
    expect(px({})).toEqual([100, 150, 200, 255]);
    const brighter = px({ exposure: 1 });
    expect(brighter[0]!).toBeGreaterThan(110);
    const mono = px({ monochrome: true });
    expect(mono[0]).toBe(mono[1]);
    expect(mono[1]).toBe(mono[2]);
    const warm = px({ temperature: 100 });
    expect(warm[0]!).toBeGreaterThan(100);
    expect(warm[2]!).toBeLessThan(200);
    const noBlue = px({ mixerSaturation: [0, 0, 0, 0, 0, -100, 0, 0] });
    expect(noBlue[2]! - noBlue[0]!).toBeLessThan(100);
    expectCode(() => img.renderRgba([{ op: "develop", exposure: 9 }]), "INVALID_OPTIONS");
    img.dispose();
  });

  it("straightens without changing size or leaving empty corners", () => {
    const img = DecodedImage.decode(
      makePng(
        40,
        30,
        pixels(40, 30, (x) => [x * 6, 0, 0, 255]),
      ),
    );
    const out = img.renderRgba([{ op: "straighten", degrees: 12 }]);
    expect([out.width, out.height]).toEqual([40, 30]);
    for (let i = 3; i < out.pixels.length; i += 4) expect(out.pixels[i]).toBe(255);
    expectCode(() => img.renderRgba([{ op: "straighten", degrees: 60 }]), "INVALID_OPTIONS");
    img.dispose();
  });

  it("scales full-resolution crops onto a preview proxy", () => {
    const img = DecodedImage.decode(samplePng(400, 300));
    const proxy = img.thumbnail(100); // scale 0.25
    const ops = [{ op: "crop" as const, x: 100, y: 40, width: 200, height: 120 }];
    const full = img.renderRgba(ops);
    const small = proxy.renderRgba(ops);
    expect([full.width, full.height]).toEqual([200, 120]);
    expect([small.width, small.height]).toEqual([50, 30]);
    // A crop touching the far edge must not fail on the proxy due to rounding.
    expect(proxy.renderRgba([{ op: "crop", x: 399, y: 299, width: 1, height: 1 }]).width).toBe(1);
    proxy.dispose();
    img.dispose();
  });

  it("thumbnail never upscales and source is unchanged by renders", () => {
    const img = DecodedImage.decode(src);
    const t = img.thumbnail(20);
    expect([t.width, t.height]).toEqual([20, 15]);
    img.render([{ op: "develop", exposure: 2 }], enc("png"));
    expect(img.renderRgba([]).pixels[4 * 5]).toBe(Math.floor((5 * 255) / 40));
    t.dispose();
    img.dispose();
    expectCode(() => img.width, "ENGINE_NOT_READY");
  });
});

describe("errors and safeguards", () => {
  it("rejects garbage, empty and truncated input with codes", () => {
    expectCode(() => inspectImage(new Uint8Array()), "EMPTY_INPUT");
    expectCode(() => DecodedImage.decode(new TextEncoder().encode("hello world, not an image")), "UNSUPPORTED_FORMAT");
    const png = samplePng();
    expectCode(() => DecodedImage.decode(png.subarray(0, png.length - 30)), "DECODE_FAILED");
  });

  it("rejects images whose header exceeds the pixel limit before allocating", () => {
    const forged = makePng(2, 2, new Uint8Array(16), { headerWidth: 15_000, headerHeight: 15_000 });
    const info = inspectImage(forged);
    expect([info.width, info.height]).toEqual([15_000, 15_000]);
    expectCode(() => DecodedImage.decode(forged), "TOO_LARGE");
  });

  it("rejects malformed option JSON", () => {
    const img = DecodedImage.decode(samplePng());
    expectCode(() => img.render([{ op: "rotate", degrees: 45 as 90 }], enc("png")), "INVALID_OPTIONS");
    expectCode(() => img.render([{ op: "nope" } as never], enc("png")), "INVALID_OPTIONS");
    expectCode(() => img.render([], { format: "heic" } as never), "INVALID_OPTIONS");
    img.dispose();
  });
});

describe("new formats and operations", () => {
  const src = samplePng(40, 30);

  it("writes square multi-size icons", () => {
    const ico = processImage(src, [], { format: "ico" });
    expect(ico.mimeType).toBe("image/x-icon");
    const info = inspectImage(ico.bytes);
    expect([info.format, info.width, info.height]).toEqual(["ico", 32, 32]);
  });

  it("keeps GIF 1-bit transparency and TIFF exactly", () => {
    const gif = DecodedImage.decode(processImage(src, [], { format: "gif" }).bytes);
    expect(gif.renderRgba([]).pixels[3]).toBe(0);
    gif.dispose();
    const tiff = DecodedImage.decode(processImage(src, [], { format: "tiff" }).bytes);
    expect(tiff.renderRgba([]).pixels).toEqual(DecodedImage.decode(src).renderRgba([]).pixels);
    tiff.dispose();
  });

  it("wraps browser-decoded RGBA pixels", () => {
    const px = pixels(3, 2, (x, y) => [x * 80, y * 100, 7, 255]);
    const img = DecodedImage.fromRgba(px, 3, 2);
    expect([img.width, img.height]).toEqual([3, 2]);
    expect(Array.from(img.renderRgba([]).pixels)).toEqual(Array.from(px));
    expect(inspectImage(img.render([], { format: "png" }).bytes)).toMatchObject({ width: 3, height: 2 });
    expectCode(() => DecodedImage.fromRgba(new Uint8Array(5), 3, 2), "INVALID_DIMENSIONS");
    img.dispose();
  });

  it("pads with a colour and blurs", () => {
    const img = DecodedImage.decode(src);
    const out = img.renderRgba([{ op: "pad", top: 2, right: 3, bottom: 4, left: 5, color: [255, 0, 0, 255] }]);
    expect([out.width, out.height]).toEqual([48, 36]);
    expect(Array.from(out.pixels.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    const blurred = img.renderRgba([{ op: "develop", blur: 40 }]);
    expect([blurred.width, blurred.height]).toEqual([40, 30]);
    expectCode(() => img.renderRgba([{ op: "develop", blur: 200 }]), "INVALID_OPTIONS");
    img.dispose();
  });

  it("inspects and strips metadata losslessly", () => {
    // PNG with an Author text chunk and a timestamp.
    const plain = processImage(src, [], { format: "png" }).bytes;
    const withText = insertPngChunk(plain, "tEXt", new TextEncoder().encode("Author\0Jane Doe"));
    const report = inspectMetadata(withText);
    expect(report).toMatchObject({ hasComments: true, strippable: true, hasExif: false });
    const stripped = stripMetadata(withText, { keepOrientation: true, keepIcc: true });
    expect(new TextDecoder().decode(stripped)).not.toContain("Jane Doe");
    expect(inspectMetadata(stripped)).toMatchObject({ hasComments: false });
    expect(DecodedImage.decode(stripped).renderRgba([]).pixels).toEqual(DecodedImage.decode(plain).renderRgba([]).pixels);
    // Formats without lossless removal say so.
    const bmp = processImage(src, [], { format: "bmp" }).bytes;
    expect(inspectMetadata(bmp).strippable).toBe(false);
    expectCode(() => stripMetadata(bmp, { keepOrientation: false, keepIcc: false }), "INVALID_OPTIONS");
  });

  it("encodes AVIF in the separate module", async () => {
    initAvifSync(readFileSync(fileURLToPath(new URL("../pkg/avif/avif_encoder_bg.wasm", import.meta.url))));
    const img = DecodedImage.decode(src);
    const { pixels: px, width, height } = img.renderRgba([]);
    const avif = await encodeAvif(px, width, height, 60, 10);
    expect(new TextDecoder().decode(avif.subarray(4, 12))).toBe("ftypavif");
    await expect(encodeAvif(px, width, height, 0, 10)).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    img.dispose();
  });
});

/** Inserts a PNG chunk right after IHDR (computes the CRC). */
function insertPngChunk(png: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  const ihdrEnd = 8 + 25;
  const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  return new Uint8Array([...png.subarray(0, ihdrEnd), ...len, ...body, ...crc, ...png.subarray(ihdrEnd)]);
}

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
