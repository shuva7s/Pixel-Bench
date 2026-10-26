"use client";

import { MIXER_BANDS, type BandValues } from "@image-tools/engine/shared";
import { FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, Wand2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ASPECTS, isValidCustomAspect, MAX_CUSTOM_ASPECT, type AspectKey, type CustomAspect } from "@/lib/crop";
import { DEFAULT_DEVELOP, DEFAULT_FRAME, PRESETS, type DevelopSettings, type FrameRatio, type FrameSettings } from "@/lib/editor";

import { Label } from "@/components/ui/label";

import { ChoiceField, Notice, NumberField, SelectField, SliderField, SwitchField } from "../fields";
import { HELP, HelpTip, Tip } from "../help";

/** One collapsible panel section; shows a dot and a reset action when modified. */
export function Section({
  id,
  title,
  children,
  onReset,
  modified = false,
}: {
  id: string;
  title: string;
  children: ReactNode;
  onReset?: () => void;
  modified?: boolean;
}) {
  return (
    <AccordionItem value={id}>
      <AccordionTrigger className="text-sm font-medium">
        <span className="flex items-center gap-2">
          {title}
          {modified ? <span aria-label="modified" className="size-1.5 rounded-full bg-foreground" /> : null}
        </span>
      </AccordionTrigger>
      <AccordionContent className="flex flex-col gap-4">
        {onReset && modified ? (
          <Button variant="ghost" size="xs" className="-mt-1 self-end text-muted-foreground" onClick={onReset}>
            Reset {title.toLowerCase()}
          </Button>
        ) : null}
        {children}
      </AccordionContent>
    </AccordionItem>
  );
}

type DevelopProps = { value: DevelopSettings; onChange: (d: DevelopSettings) => void };

const changed = (d: DevelopSettings, keys: (keyof DevelopSettings)[]) =>
  keys.some((k) => JSON.stringify(d[k]) !== JSON.stringify(DEFAULT_DEVELOP[k]));

function resetKeys(d: DevelopSettings, keys: (keyof DevelopSettings)[]): DevelopSettings {
  const next = { ...d };
  for (const k of keys) (next as Record<string, unknown>)[k] = DEFAULT_DEVELOP[k];
  return next;
}

const LIGHT_KEYS: (keyof DevelopSettings)[] = ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"];
const COLOR_KEYS: (keyof DevelopSettings)[] = ["temperature", "tint", "vibrance", "saturation", "monochrome"];
const MIXER_KEYS: (keyof DevelopSettings)[] = ["mixerHue", "mixerSaturation", "mixerLuminance"];
const EFFECT_KEYS: (keyof DevelopSettings)[] = ["clarity", "blur", "vignette", "vignetteMidpoint", "grain"];
const DETAIL_KEYS: (keyof DevelopSettings)[] = ["sharpenAmount", "sharpenRadius"];

const gradient = (...stops: string[]) => ({ background: `linear-gradient(90deg, ${stops.join(", ")})` });

export function PresetsSection({ value, onChange, onAuto, autoBusy }: DevelopProps & { onAuto: () => void; autoBusy: boolean }) {
  return (
    <Section id="presets" title="Presets">
      <div className="flex flex-wrap gap-1.5">
        <Tip content={HELP.auto}>
          <Button size="sm" onClick={onAuto} disabled={autoBusy}>
            <Wand2 aria-hidden /> Auto
          </Button>
        </Tip>
        {PRESETS.map((p) => (
          <Button key={p.id} size="sm" variant="outline" onClick={() => onChange({ ...value, ...p.settings })}>
            {p.name}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Presets change only the sliders they use, so you can stack them and fine-tune afterwards.
      </p>
    </Section>
  );
}

export function LightSection({ value: d, onChange }: DevelopProps) {
  const set = (k: keyof DevelopSettings) => (v: number) => onChange({ ...d, [k]: v });
  return (
    <Section id="light" title="Light" modified={changed(d, LIGHT_KEYS)} onReset={() => onChange(resetKeys(d, LIGHT_KEYS))}>
      <SliderField
        label="Exposure"
        hint={HELP.exposure}
        value={d.exposure}
        min={-5}
        max={5}
        step={0.05}
        onChange={set("exposure")}
        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
      />
      <SliderField label="Contrast" hint={HELP.contrast} value={d.contrast} min={-100} max={100} onChange={set("contrast")} />
      <SliderField label="Highlights" hint={HELP.highlights} value={d.highlights} min={-100} max={100} onChange={set("highlights")} />
      <SliderField label="Shadows" hint={HELP.shadows} value={d.shadows} min={-100} max={100} onChange={set("shadows")} />
      <SliderField label="Whites" hint={HELP.whites} value={d.whites} min={-100} max={100} onChange={set("whites")} />
      <SliderField label="Blacks" hint={HELP.blacks} value={d.blacks} min={-100} max={100} onChange={set("blacks")} />
    </Section>
  );
}

export function ColorSection({ value: d, onChange }: DevelopProps) {
  const set = (k: keyof DevelopSettings) => (v: number) => onChange({ ...d, [k]: v });
  return (
    <Section id="color" title="Color" modified={changed(d, COLOR_KEYS)} onReset={() => onChange(resetKeys(d, COLOR_KEYS))}>
      <SwitchField
        label="Black & white"
        hint={HELP.monochrome}
        checked={d.monochrome}
        onChange={(monochrome) => onChange({ ...d, monochrome })}
      />
      <SliderField
        label="Temperature"
        hint={HELP.temperature}
        value={d.temperature}
        min={-100}
        max={100}
        onChange={set("temperature")}
        trackStyle={gradient("#3d7bd9", "#d4d4d4", "#e8b13a")}
      />
      <SliderField
        label="Tint"
        hint={HELP.tint}
        value={d.tint}
        min={-100}
        max={100}
        onChange={set("tint")}
        trackStyle={gradient("#3fb04a", "#d4d4d4", "#c64fc6")}
      />
      <SliderField label="Vibrance" hint={HELP.vibrance} value={d.vibrance} min={-100} max={100} onChange={set("vibrance")} />
      <SliderField
        label="Saturation"
        hint={HELP.saturation}
        value={d.saturation}
        min={-100}
        max={100}
        onChange={set("saturation")}
        trackStyle={gradient("#8a8a8a", "#e04a4a")}
      />
    </Section>
  );
}

const BAND_HUES = [0, 30, 60, 120, 180, 240, 270, 300];
const BAND_LABELS: Record<(typeof MIXER_BANDS)[number], string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  aqua: "Aqua",
  blue: "Blue",
  purple: "Purple",
  magenta: "Magenta",
};

type MixerMode = "mixerHue" | "mixerSaturation" | "mixerLuminance";

function bandTrack(mode: MixerMode, hue: number) {
  if (mode === "mixerHue") return gradient(`hsl(${hue - 30} 75% 55%)`, `hsl(${hue} 75% 55%)`, `hsl(${hue + 30} 75% 55%)`);
  if (mode === "mixerSaturation") return gradient(`hsl(${hue} 0% 55%)`, `hsl(${hue} 85% 55%)`);
  return gradient(`hsl(${hue} 70% 18%)`, `hsl(${hue} 70% 50%)`, `hsl(${hue} 70% 85%)`);
}

export function MixerSection({ value: d, onChange }: DevelopProps) {
  const [mode, setMode] = useState<MixerMode>("mixerHue");
  return (
    <Section id="mixer" title="Color mixer" modified={changed(d, MIXER_KEYS)} onReset={() => onChange(resetKeys(d, MIXER_KEYS))}>
      <ChoiceField
        label="Mixer adjustment"
        hint={HELP.mixer}
        value={mode}
        onChange={setMode}
        options={[
          { value: "mixerHue", label: "Hue" },
          { value: "mixerSaturation", label: "Saturation" },
          { value: "mixerLuminance", label: "Luminance" },
        ]}
      />
      {MIXER_BANDS.map((band, i) => (
        <SliderField
          key={`${mode}-${band}`}
          label={BAND_LABELS[band]}
          value={d[mode][i]!}
          min={-100}
          max={100}
          trackStyle={bandTrack(mode, BAND_HUES[i]!)}
          onChange={(v) => {
            const next = [...d[mode]] as BandValues;
            next[i] = v;
            onChange({ ...d, [mode]: next });
          }}
        />
      ))}
    </Section>
  );
}

export function EffectsSection({ value: d, onChange }: DevelopProps) {
  const set = (k: keyof DevelopSettings) => (v: number) => onChange({ ...d, [k]: v });
  return (
    <Section id="effects" title="Effects" modified={changed(d, EFFECT_KEYS)} onReset={() => onChange(resetKeys(d, EFFECT_KEYS))}>
      <SliderField label="Clarity" hint={HELP.clarity} value={d.clarity} min={-100} max={100} onChange={set("clarity")} />
      <SliderField label="Blur" hint={HELP.blur} value={d.blur} min={0} max={100} onChange={set("blur")} />
      <SliderField label="Vignette" hint={HELP.vignette} value={d.vignette} min={-100} max={100} onChange={set("vignette")} />
      <SliderField
        label="Vignette midpoint"
        hint={HELP.vignetteMidpoint}
        value={d.vignetteMidpoint}
        min={0}
        max={100}
        defaultValue={50}
        onChange={set("vignetteMidpoint")}
        format={String}
      />
      <SliderField label="Grain" hint={HELP.grain} value={d.grain} min={0} max={100} onChange={set("grain")} />
    </Section>
  );
}

export function DetailSection({ value: d, onChange }: DevelopProps) {
  const set = (k: keyof DevelopSettings) => (v: number) => onChange({ ...d, [k]: v });
  return (
    <Section id="detail" title="Detail" modified={changed(d, DETAIL_KEYS)} onReset={() => onChange(resetKeys(d, DETAIL_KEYS))}>
      <SliderField label="Sharpening" hint={HELP.sharpening} value={d.sharpenAmount} min={0} max={150} onChange={set("sharpenAmount")} />
      <SliderField
        label="Radius"
        hint={HELP.radius}
        value={d.sharpenRadius}
        min={0.5}
        max={3}
        step={0.1}
        defaultValue={1}
        onChange={set("sharpenRadius")}
        format={(v) => v.toFixed(1)}
      />
      <p className="text-xs text-muted-foreground">The preview is a reduced-size copy; check fine sharpening in the exported file.</p>
    </Section>
  );
}

export function GeometrySection({
  cropping,
  onToggleCrop,
  aspect,
  onAspect,
  customAspect,
  onCustomAspect,
  straighten,
  onStraighten,
  onRotate,
  onFlip,
  onReset,
  modified,
  summary,
}: {
  cropping: boolean;
  onToggleCrop: () => void;
  aspect: AspectKey;
  onAspect: (a: AspectKey) => void;
  customAspect: CustomAspect;
  onCustomAspect: (a: CustomAspect) => void;
  straighten: number;
  onStraighten: (v: number) => void;
  onRotate: (deg: 90 | 270) => void;
  onFlip: (dir: "horizontal" | "vertical") => void;
  onReset: () => void;
  modified: boolean;
  summary: string;
}) {
  return (
    <Section id="geometry" title="Crop & rotate" modified={modified} onReset={onReset}>
      <Button variant={cropping ? "default" : "outline"} onClick={onToggleCrop} aria-pressed={cropping}>
        {cropping ? "Done cropping" : "Crop"}
      </Button>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        Aspect ratio <HelpTip term="aspect ratio">{HELP.aspect}</HelpTip>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-label="Aspect ratio"
        value={aspect}
        onValueChange={(v) => v && onAspect(v as AspectKey)}
        className="flex w-full flex-wrap"
      >
        {ASPECTS.map((a) => (
          <ToggleGroupItem key={a.key} value={a.key} className="px-2.5">
            {a.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {aspect === "custom" ? (
        <div className="flex flex-col gap-2" data-testid="custom-aspect">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            Custom ratio <HelpTip term="a custom ratio">{HELP.customAspect}</HelpTip>
          </div>
          <div className="flex items-center gap-2">
            <NumberField
              label="Ratio width"
              hideLabel
              value={customAspect.width}
              min={0.01}
              max={MAX_CUSTOM_ASPECT}
              step="any"
              onChange={(width) => onCustomAspect({ ...customAspect, width })}
            />
            <span aria-hidden className="text-muted-foreground">
              :
            </span>
            <NumberField
              label="Ratio height"
              hideLabel
              value={customAspect.height}
              min={0.01}
              max={MAX_CUSTOM_ASPECT}
              step="any"
              onChange={(height) => onCustomAspect({ ...customAspect, height })}
            />
          </div>
          {isValidCustomAspect(customAspect) ? null : (
            <Notice tone="warning">Enter two numbers between 0 and {MAX_CUSTOM_ASPECT}, for example 2.39 and 1.</Notice>
          )}
        </div>
      ) : null}
      <SliderField
        label="Straighten"
        hint={HELP.straighten}
        value={straighten}
        min={-45}
        max={45}
        step={0.1}
        onChange={onStraighten}
        format={(v) => `${v.toFixed(1)}°`}
      />
      <div className="grid grid-cols-4 gap-1.5">
        <Tip content="Rotate left 90°">
          <Button variant="outline" aria-label="Rotate left" onClick={() => onRotate(270)}>
            <RotateCcw aria-hidden />
          </Button>
        </Tip>
        <Tip content="Rotate right 90°">
          <Button variant="outline" aria-label="Rotate right" onClick={() => onRotate(90)}>
            <RotateCw aria-hidden />
          </Button>
        </Tip>
        <Tip content="Flip horizontal (mirror)">
          <Button variant="outline" aria-label="Flip horizontal" onClick={() => onFlip("horizontal")}>
            <FlipHorizontal2 aria-hidden />
          </Button>
        </Tip>
        <Tip content="Flip vertical (mirror)">
          <Button variant="outline" aria-label="Flip vertical" onClick={() => onFlip("vertical")}>
            <FlipVertical2 aria-hidden />
          </Button>
        </Tip>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="geometry-summary">
        {summary}
      </p>
    </Section>
  );
}

export function FrameSection({ value: f, onChange }: { value: FrameSettings; onChange: (f: FrameSettings) => void }) {
  const modified = f.border > 0 || f.ratio !== "none";
  return (
    <Section id="frame" title="Border & padding" modified={modified} onReset={() => onChange(DEFAULT_FRAME)}>
      <SliderField
        label="Border"
        hint={HELP.border}
        value={f.border}
        min={0}
        max={25}
        step={0.5}
        onChange={(border) => onChange({ ...f, border })}
        format={(v) => `${v}%`}
      />
      <SelectField<FrameRatio>
        label="Pad to shape"
        hint={HELP.frameRatio}
        value={f.ratio}
        onChange={(ratio) => onChange({ ...f, ratio })}
        options={[
          { value: "none", label: "None" },
          { value: "1:1", label: "Square (1:1)" },
          { value: "4:5", label: "Portrait (4:5)" },
          { value: "3:2", label: "Landscape (3:2)" },
          { value: "16:9", label: "Widescreen (16:9)" },
          { value: "9:16", label: "Story (9:16)" },
        ]}
      />
      <SwitchField label="Transparent" checked={f.transparent} onChange={(transparent) => onChange({ ...f, transparent })} />
      {f.transparent ? (
        <p className="text-xs text-muted-foreground">
          Transparent padding needs PNG, WebP or AVIF; JPEG fills it with the export background colour.
        </p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="frame-color">Colour</Label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{f.color}</span>
            <input
              id="frame-color"
              type="color"
              value={f.color}
              onChange={(e) => onChange({ ...f, color: e.target.value })}
              className="h-7 w-10 cursor-pointer rounded-md border bg-background"
            />
          </div>
        </div>
      )}
    </Section>
  );
}
