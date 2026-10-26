"use client";

import { FORMAT_IDS, FORMATS, SOURCE_LABELS, type ImageFormat, type PngCompression, type SourceFormat } from "@image-tools/engine/shared";
import { useId, type ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { isLossy, resolveFormat, willFlatten, type AvifSpeed, type OutputSettings } from "@/lib/output";

import { ChoiceField, Notice, SelectField, SliderField, SwitchField } from "./fields";
import { HELP, HelpTip } from "./help";

export function OutputSettingsPanel({
  value,
  onChange,
  sourceFormat,
  hasTransparency,
  allowSame = true,
  hideQuality = false,
  targetSlot,
}: {
  value: OutputSettings;
  onChange: (v: OutputSettings) => void;
  /** Null when files may have different formats. */
  sourceFormat: SourceFormat | null;
  hasTransparency: boolean;
  allowSame?: boolean;
  /** A target file size is set, so quality is chosen automatically and the slider is hidden. */
  hideQuality?: boolean;
  /** Target-size controls, shown right below the quality slider. */
  targetSlot?: ReactNode;
}) {
  const colorId = useId();
  const set = <K extends keyof OutputSettings>(k: K, v: OutputSettings[K]) => onChange({ ...value, [k]: v });
  // With mixed sources and "same", show every setting that could apply.
  const mixed = value.format === "same" && sourceFormat === null;
  const target: ImageFormat | null = mixed ? null : resolveFormat(value, sourceFormat ?? "png");
  const showJpeg = mixed || target === "jpeg";
  const showPng = mixed || target === "png";
  const showWebp = mixed || target === "webp";
  const showAvif = mixed || target === "avif";
  const showQuality = mixed || (target !== null && isLossy(value, target));
  const showBackground = mixed || (target !== null && !FORMATS[target].supportsAlpha);
  const flattening = sourceFormat ? willFlatten(value, sourceFormat, hasTransparency) : false;

  const sameLabel =
    sourceFormat === null
      ? "Same as original"
      : sourceFormat === "heic"
        ? "Same as original (HEIC → JPEG)"
        : `Same as original (${SOURCE_LABELS[sourceFormat]})`;
  const formatOptions = [
    ...(allowSame ? [{ value: "same" as const, label: sameLabel }] : []),
    ...FORMAT_IDS.map((f) => ({ value: f, label: FORMATS[f].label })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <SelectField label="Format" hint={HELP.format} value={value.format} onChange={(v) => set("format", v)} options={formatOptions} />

      {showWebp ? (
        <SwitchField label="Lossless WebP" hint={HELP.webpLossless} checked={value.webpLossless} onChange={(v) => set("webpLossless", v)} />
      ) : null}

      {showQuality && !hideQuality ? (
        <SliderField
          label="Quality"
          hint={HELP.jpegQuality}
          value={value.quality}
          min={1}
          max={100}
          defaultValue={90}
          onChange={(v) => set("quality", v)}
          format={String}
        />
      ) : null}
      {targetSlot}

      {showJpeg ? (
        <SwitchField label="Progressive JPEG" hint={HELP.progressive} checked={value.progressive} onChange={(v) => set("progressive", v)} />
      ) : null}

      {showAvif ? (
        <ChoiceField<AvifSpeed>
          label="AVIF speed"
          hint={HELP.avifSpeed}
          showLabel
          value={value.avifSpeed}
          onChange={(v) => set("avifSpeed", v)}
          options={[
            { value: "fast", label: "Fast" },
            { value: "balanced", label: "Balanced" },
            { value: "small", label: "Smallest" },
          ]}
        />
      ) : null}

      {showPng ? (
        <div className="flex flex-col gap-1.5">
          <SelectField<PngCompression>
            label="PNG compression"
            hint={HELP.pngCompression}
            value={value.pngCompression}
            onChange={(v) => set("pngCompression", v)}
            options={[
              { value: "fast", label: "Fastest (much larger files)" },
              { value: "default", label: "Balanced" },
              { value: "best", label: "Smallest (slowest)" },
            ]}
          />
          <p className="text-xs text-muted-foreground">Always lossless.</p>
        </div>
      ) : null}

      {target && FORMATS[target].note ? <Notice>{FORMATS[target].note}</Notice> : null}
      {target === "webp" && value.webpLossless ? (
        <Notice>Lossless WebP keeps every pixel; for photos it is usually larger than lossy WebP or JPEG.</Notice>
      ) : null}

      {showBackground ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <Label htmlFor={colorId}>Background for transparent areas</Label>
            <HelpTip term="the background colour">{HELP.background}</HelpTip>
          </div>
          <div className="flex items-center gap-3">
            <input
              id={colorId}
              type="color"
              value={value.background}
              onChange={(e) => set("background", e.target.value)}
              className="h-8 w-12 cursor-pointer rounded-md border bg-background"
            />
            <span className="font-mono text-xs text-muted-foreground">{value.background}</span>
          </div>
          {flattening ? null : <p className="text-xs text-muted-foreground">JPEG and BMP cannot store transparency.</p>}
        </div>
      ) : null}
      {flattening && target ? (
        <Notice tone="warning">
          This image has transparent pixels. {FORMATS[target].label} has no transparency, so they will be filled with the background colour.
          Choose PNG, WebP or AVIF to keep them.
        </Notice>
      ) : null}
    </div>
  );
}
