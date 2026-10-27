// Types mirroring the serde definitions in crates/image-core and
// crates/app-core. Keep in sync.

/** Formats that can be written. */
export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "tiff" | "bmp" | "ico";

/** Formats that can be opened: every output format plus HEIC/HEIF. */
export type SourceFormat = ImageFormat | "heic";

/**
 * Which component encodes a format:
 * - `engine`: the Rust image engine (image-core),
 * - `avif`: rav1e (multi-threaded),
 * - `engine+webp`: lossless by the engine, lossy by libwebp.
 */
export type Encoder = "engine" | "avif" | "engine+webp";

export interface FormatSpec {
  id: ImageFormat;
  label: string;
  mimeType: string;
  extension: string;
  /** Output keeps an alpha channel. Others are flattened onto a background. */
  supportsAlpha: boolean;
  /** Output is lossy (has a quality setting) by default. */
  lossy: boolean;
  maxSide: number;
  encoder: Encoder;
  /** Short note shown when the format is chosen. */
  note?: string;
}

export const FORMATS: Record<ImageFormat, FormatSpec> = {
  jpeg: {
    id: "jpeg",
    label: "JPEG",
    mimeType: "image/jpeg",
    extension: "jpg",
    supportsAlpha: false,
    lossy: true,
    maxSide: 65535,
    encoder: "engine",
  },
  png: {
    id: "png",
    label: "PNG",
    mimeType: "image/png",
    extension: "png",
    supportsAlpha: true,
    lossy: false,
    maxSide: Infinity,
    encoder: "engine",
  },
  webp: {
    id: "webp",
    label: "WebP",
    mimeType: "image/webp",
    extension: "webp",
    supportsAlpha: true,
    lossy: true,
    maxSide: 16383,
    encoder: "engine+webp",
  },
  avif: {
    id: "avif",
    label: "AVIF",
    mimeType: "image/avif",
    extension: "avif",
    supportsAlpha: true,
    lossy: true,
    maxSide: 65535,
    encoder: "avif",
    note: "AVIF gives the smallest files but is slow to encode: several seconds per photo.",
  },
  gif: {
    id: "gif",
    label: "GIF",
    mimeType: "image/gif",
    extension: "gif",
    supportsAlpha: true,
    lossy: false,
    maxSide: 65535,
    encoder: "engine",
    note: "GIF is limited to 256 colours and on/off transparency, so photos lose quality.",
  },
  tiff: {
    id: "tiff",
    label: "TIFF",
    mimeType: "image/tiff",
    extension: "tiff",
    supportsAlpha: true,
    lossy: false,
    maxSide: Infinity,
    encoder: "engine",
    note: "Lossless TIFF (LZW compression).",
  },
  bmp: {
    id: "bmp",
    label: "BMP",
    mimeType: "image/bmp",
    extension: "bmp",
    supportsAlpha: false,
    lossy: false,
    maxSide: Infinity,
    encoder: "engine",
    note: "BMP is uncompressed, so files are usually much larger.",
  },
  ico: {
    id: "ico",
    label: "ICO (icon)",
    mimeType: "image/x-icon",
    extension: "ico",
    supportsAlpha: true,
    lossy: false,
    maxSide: Infinity,
    encoder: "engine",
    note: "Creates a square icon with sizes from 16 to 256 px; non-square images are padded with transparency.",
  },
};

export const FORMAT_IDS = Object.keys(FORMATS) as ImageFormat[];

export const SOURCE_LABELS: Record<SourceFormat, string> = {
  ...(Object.fromEntries(FORMAT_IDS.map((f) => [f, FORMATS[f].label.replace(" (icon)", "")])) as Record<ImageFormat, string>),
  heic: "HEIC",
};

export interface ImageInfo {
  format: SourceFormat;
  mimeType: string;
  width: number;
  height: number;
  colorModel: "grayscale" | "grayscale-alpha" | "rgb" | "rgba";
  bitsPerChannel: number;
  hasAlphaChannel: boolean;
  orientationCorrected: boolean;
  animated: boolean;
  byteSize: number;
}

export interface MetaField {
  group: "Image" | "Camera" | "GPS" | "Interop" | "Thumbnail";
  tag: string;
  value: string;
  sensitive: boolean;
}

export interface MetadataReport {
  fields: MetaField[];
  hasExif: boolean;
  hasGps: boolean;
  hasXmp: boolean;
  hasIptc: boolean;
  hasIcc: boolean;
  hasComments: boolean;
  hasTrailingData: boolean;
  orientation: number | null;
  /** Whether metadata can be removed without re-encoding (JPEG, PNG, WebP). */
  strippable: boolean;
}

export interface EngineLimits {
  maxInputBytes: number;
  maxSide: number;
  maxPixels: number;
}

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

export type ResizeFilter = "nearest" | "bilinear" | "catmullRom" | "lanczos3";

export type ResizeSize =
  | { mode: "exact"; width: number; height: number }
  | { mode: "fit"; maxWidth: number; maxHeight: number; allowUpscale?: boolean }
  | { mode: "percent"; percent: number };

/** Colour bands of the HSL mixer, in engine order. */
export const MIXER_BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export type MixerBand = (typeof MIXER_BANDS)[number];

/** Eight values, one per mixer band. */
export type BandValues = [number, number, number, number, number, number, number, number];

/** Lightroom-style develop settings. Omitted fields are neutral. */
export interface Develop {
  /** -100..100 */
  temperature?: number;
  /** -100..100 */
  tint?: number;
  /** -5..5 stops */
  exposure?: number;
  contrast?: number;
  highlights?: number;
  shadows?: number;
  whites?: number;
  blacks?: number;
  vibrance?: number;
  saturation?: number;
  mixerHue?: BandValues;
  mixerSaturation?: BandValues;
  mixerLuminance?: BandValues;
  monochrome?: boolean;
  /** -100..100 */
  clarity?: number;
  /** 0..100 */
  blur?: number;
  /** 0..150 */
  sharpenAmount?: number;
  /** 0.5..3 px */
  sharpenRadius?: number;
  /** -100..100 */
  vignette?: number;
  /** 0..100 */
  vignetteMidpoint?: number;
  /** 0..100 */
  grain?: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
  color: Rgba;
}

export type Operation =
  | { op: "crop"; x: number; y: number; width: number; height: number }
  | { op: "resize"; size: ResizeSize; filter?: ResizeFilter }
  | { op: "rotate"; degrees: 0 | 90 | 180 | 270 }
  | { op: "flip"; direction: "horizontal" | "vertical" }
  /** -45..45 degrees clockwise; zooms to keep the frame filled. */
  | { op: "straighten"; degrees: number }
  | ({ op: "develop" } & Develop)
  | ({ op: "pad" } & Padding);

export type PngCompression = "fast" | "default" | "best";

export type EngineErrorCode =
  | "EMPTY_INPUT"
  | "UNSUPPORTED_FORMAT"
  | "ANIMATED_NOT_SUPPORTED"
  | "MULTI_PAGE_NOT_SUPPORTED"
  | "DECODE_FAILED"
  | "ENCODE_FAILED"
  | "TOO_LARGE"
  | "INVALID_DIMENSIONS"
  | "INVALID_CROP"
  | "INVALID_OPTIONS"
  /** The native backend failed unexpectedly. */
  | "ENGINE_CRASHED"
  | "ENGINE_NOT_READY"
  /** AI tools: a model could not be downloaded, failed its checksum, or could not run. */
  | "MODEL_DOWNLOAD_FAILED"
  | "MODEL_INVALID"
  | "MODEL_LOAD_FAILED"
  | "INFERENCE_FAILED"
  | "MODEL_NOT_DOWNLOADED"
  /** Native backend: the file is AVIF/HEIC and must be decoded by the web view first. */
  | "NEEDS_UI_DECODER"
  | "IO_FAILED"
  | "CANCELLED";
