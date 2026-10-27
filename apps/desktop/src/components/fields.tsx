"use client";

import { AlertCircle, Info, Loader2, TriangleAlert } from "lucide-react";
import { useId, type CSSProperties, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { HelpTip } from "./help";

/**
 * Labelled slider: name and value on one line; double-click either to reset.
 * The value is emphasised when it differs from the default, like Lightroom.
 */
export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  defaultValue = 0,
  format,
  trackStyle,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  format?: (v: number) => string;
  trackStyle?: CSSProperties;
  /** Plain-language explanation shown in a (?) tooltip. */
  hint?: ReactNode;
}) {
  const shown = format ? format(value) : value > 0 && min < 0 ? `+${value}` : String(value);
  const changed = value !== defaultValue;
  return (
    <div className="flex flex-col gap-2" onDoubleClick={() => onChange(defaultValue)}>
      <div className="flex items-center justify-between text-xs" title="Double-click to reset">
        <span className="flex items-center gap-1">
          <span className={cn(changed ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
          {hint ? <HelpTip term={label}>{hint}</HelpTip> : null}
        </span>
        <span className="tabular-nums text-muted-foreground">{shown}</span>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        data-step={step}
        onValueChange={(v) => onChange(v[0]!)}
        trackStyle={trackStyle}
      />
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <HelpTip term={label}>{hint}</HelpTip> : null}
      </div>
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ChoiceField<T extends string>({
  label,
  value,
  onChange,
  options,
  showLabel = false,
  hint,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  showLabel?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {showLabel || hint ? (
        <div className="flex items-center gap-1">
          <span className={cn(showLabel ? "text-sm font-medium" : "sr-only")}>{label}</span>
          {hint ? <HelpTip term={label}>{hint}</HelpTip> : null}
        </div>
      ) : null}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        aria-label={label}
        value={value}
        // Radix emits "" when the active item is clicked again; keep a value selected.
        onValueChange={(v) => v && onChange(v as T)}
        className="w-full"
      >
        {options.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value} className="flex-1">
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <HelpTip term={label}>{hint}</HelpTip> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  hideLabel = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** Use "any" to allow decimals. */
  step?: number | "any";
  suffix?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className={cn(hideLabel && "sr-only")}>
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode={step === "any" ? "decimal" : "numeric"}
          step={step}
          className={cn("tabular-nums", suffix && "pr-9")}
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{suffix}</span>
        ) : null}
      </div>
    </div>
  );
}

const TONE_ICON = { info: Info, warning: TriangleAlert, danger: AlertCircle };

export function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "danger"; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <Alert
      role={tone === "danger" ? "alert" : "status"}
      variant={tone === "danger" ? "destructive" : "default"}
      className={cn(tone === "warning" && "border-amber-500/40 text-amber-700 dark:text-amber-400")}
    >
      <Icon />
      <AlertDescription className={cn(tone === "warning" && "text-amber-700 dark:text-amber-400")}>{children}</AlertDescription>
    </Alert>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn("size-4 animate-spin", className)} />;
}

export function PanelTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

/** Labelled progress bar; `fraction` null shows an indeterminate bar. */
export function ProgressBar({ label, fraction, testId }: { label: string; fraction: number | null; testId?: string }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 truncate">
          <Spinner className="size-3.5" /> {label}
        </span>
        {fraction !== null ? <span className="tabular-nums">{Math.round(fraction * 100)}%</span> : null}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      >
        {fraction === null ? (
          <div className="h-full w-1/3 animate-[progress-slide_1.2s_ease-in-out_infinite] rounded-full bg-foreground/70" />
        ) : (
          <div className="h-full bg-foreground transition-[width]" style={{ width: `${fraction * 100}%` }} />
        )}
      </div>
    </div>
  );
}
