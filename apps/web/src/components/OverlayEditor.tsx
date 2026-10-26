"use client";

import { ImagePlus, Plus, Trash2, Type } from "lucide-react";
import { useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ANCHORS, DEFAULT_LOGO, DEFAULT_TEXT, type Anchor, type FontFamily, type Overlay } from "@/lib/overlay";
import { cn } from "@/lib/utils";

import { Notice, SelectField, SliderField, SwitchField } from "./fields";
import { HELP, HelpTip } from "./help";

/** A registered logo: its id in the worker(s), and a preview URL. */
export interface Logo {
  id: string;
  url: string;
  bytes: ArrayBuffer;
}

function AnchorPicker({ value, onChange }: { value: Anchor; onChange: (a: Anchor) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">Position</span>
      <div role="radiogroup" aria-label="Position" className="grid w-24 grid-cols-3 gap-1">
        {ANCHORS.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={value === a}
            aria-label={a.replace("-", " ")}
            onClick={() => onChange(a)}
            className={cn(
              "size-7 rounded-md border transition-colors",
              value === a ? "border-foreground bg-foreground" : "bg-background hover:bg-muted",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{value}</span>
        <input
          id={id}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded-md border bg-background"
        />
      </div>
    </div>
  );
}

/**
 * Edits a list of text and logo overlays. Logos are read from the user's
 * file and registered with the engine worker through `onLogo`.
 */
export function OverlayEditor({
  overlays,
  onChange,
  logo,
  onLogo,
}: {
  overlays: Overlay[];
  onChange: (o: Overlay[]) => void;
  logo: Logo | null;
  onLogo: (file: File) => Promise<string | null>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const update = (i: number, patch: Partial<Overlay>) => onChange(overlays.map((o, j) => (j === i ? ({ ...o, ...patch } as Overlay) : o)));
  const remove = (i: number) => onChange(overlays.filter((_, j) => j !== i));
  const hasLogo = overlays.some((o) => o.kind === "image");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        Text and logos are drawn on top of the image. <HelpTip term="a watermark">{HELP.watermark}</HelpTip>
      </div>
      {overlays.map((o, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border p-3" data-testid="overlay-item">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {o.kind === "text" ? <Type aria-hidden className="size-4" /> : <ImagePlus aria-hidden className="size-4" />}
              {o.kind === "text" ? "Text" : "Logo"}
            </span>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${o.kind === "text" ? "text" : "logo"}`} onClick={() => remove(i)}>
              <Trash2 aria-hidden />
            </Button>
          </div>
          {o.kind === "text" ? (
            <>
              <Textarea
                aria-label="Watermark text"
                value={o.text}
                rows={2}
                placeholder="© Your name"
                onChange={(e) => update(i, { text: e.target.value })}
              />
              <SelectField<FontFamily>
                label="Font"
                value={o.font}
                onChange={(font) => update(i, { font })}
                options={[
                  { value: "sans", label: "Sans serif" },
                  { value: "serif", label: "Serif" },
                  { value: "mono", label: "Monospace" },
                  { value: "rounded", label: "Rounded" },
                ]}
              />
              <SwitchField label="Bold" checked={o.bold} onChange={(bold) => update(i, { bold })} />
              <SliderField
                label="Text size"
                value={o.size}
                min={1}
                max={30}
                step={0.5}
                defaultValue={DEFAULT_TEXT.size}
                onChange={(size) => update(i, { size })}
                format={(v) => `${v}%`}
              />
              <ColorField label="Colour" value={o.color} onChange={(color) => update(i, { color })} />
              <SwitchField label="Shadow" checked={o.shadow} onChange={(shadow) => update(i, { shadow })} />
            </>
          ) : (
            <>
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- blob URL of the user's logo
                <img src={logo.url} alt="Logo" className="checker max-h-16 self-start rounded border object-contain" />
              ) : (
                <Notice tone="warning">The logo file is no longer loaded. Choose it again.</Notice>
              )}
              <SliderField
                label="Logo width"
                value={o.width}
                min={2}
                max={100}
                defaultValue={DEFAULT_LOGO.width}
                onChange={(width) => update(i, { width })}
                format={(v) => `${v}%`}
              />
              <SwitchField label="Repeat across image" checked={o.tile} onChange={(tile) => update(i, { tile })} />
            </>
          )}
          <SliderField
            label="Opacity"
            value={o.opacity}
            min={0}
            max={100}
            defaultValue={o.kind === "text" ? DEFAULT_TEXT.opacity : DEFAULT_LOGO.opacity}
            onChange={(opacity) => update(i, { opacity })}
            format={(v) => `${v}%`}
          />
          {o.kind === "image" && o.tile ? null : (
            <>
              <AnchorPicker value={o.anchor} onChange={(anchor) => update(i, { anchor })} />
              <SliderField
                label="Margin"
                value={o.margin}
                min={0}
                max={20}
                step={0.5}
                defaultValue={3}
                onChange={(margin) => update(i, { margin })}
                format={(v) => `${v}%`}
              />
            </>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...overlays, { ...DEFAULT_TEXT, text: "© " + new Date().getFullYear() }])}
        >
          <Plus aria-hidden /> Add text
        </Button>
        {hasLogo ? null : (
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <ImagePlus aria-hidden /> Add logo
          </Button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
          className="sr-only"
          tabIndex={-1}
          data-testid="logo-input"
          aria-label="Choose a logo"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const id = await onLogo(file);
            if (id) onChange([...overlays, { ...DEFAULT_LOGO, imageId: id }]);
          }}
        />
      </div>
    </div>
  );
}
