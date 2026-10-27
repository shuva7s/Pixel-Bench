// Minimal PNG encoder/decoder (8-bit, all colour types the engine writes) for
// building test images and checking outputs without image libraries.

import { deflateSync, inflateSync } from "node:zlib";

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export interface Image {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8Array;
}

/** RGBA image from a per-pixel function. */
export function image(width: number, height: number, f: (x: number, y: number) => [number, number, number, number]): Image {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        f(x, y).map((v) => Math.max(0, Math.min(255, Math.round(v)))),
        (y * width + x) * 4,
      );
  return { width, height, data };
}

export function encodePng({ width, height, data }: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function decodePng(file: Buffer): Image {
  if (file.subarray(1, 4).toString("ascii") !== "PNG") throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off < file.length) {
    const len = file.readUInt32BE(off);
    const t = file.subarray(off + 4, off + 8).toString("ascii");
    const d = file.subarray(off + 8, off + 8 + len);
    if (t === "IHDR") {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
      if (d[8] !== 8) throw new Error("only 8-bit PNGs are supported by this test helper");
      type = d[9]!;
    } else if (t === "PLTE") palette = d;
    else if (t === "tRNS") trns = d;
    else if (t === "IDAT") idat.push(d);
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0 | 2 | 3 | 4 | 6];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, pr][filter]!;
      px[y * stride + x] = (line[x]! + pred) & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, (i + 1) * channels);
    const rgba =
      type === 6
        ? [s[0], s[1], s[2], s[3]]
        : type === 2
          ? [s[0], s[1], s[2], 255]
          : type === 4
            ? [s[0], s[0], s[0], s[1]]
            : type === 0
              ? [s[0], s[0], s[0], 255]
              : [palette![s[0]! * 3], palette![s[0]! * 3 + 1], palette![s[0]! * 3 + 2], trns && s[0]! < trns.length ? trns[s[0]!] : 255];
    data.set(rgba as number[], i * 4);
  }
  return { width, height, data };
}

export function pixel(img: Image, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

/** Identifies a file by its first bytes. */
export function magic(b: Buffer): string {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b.subarray(1, 4).toString("ascii") === "PNG") return "png";
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (b.subarray(4, 12).toString("ascii") === "ftypavif") return "avif";
  if (b.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  return "unknown";
}
