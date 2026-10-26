"use client";

import { FORMATS, SOURCE_LABELS, type ImageFormat, type ImageInfo, type MetadataReport } from "@image-tools/engine/shared";
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock,
  Download,
  FileArchive,
  MapPin,
  Play,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AiClient } from "@/lib/ai/client";
import { MODELS } from "@/lib/ai/models";
import type { Backend } from "@/lib/ai/protocol";
import { upscaleProblem, type UpscaleFactor } from "@/lib/ai/upscale";
import { batchOps, buildZip, DEFAULT_BATCH_RESIZE, type BatchResize } from "@/lib/batch";
import { EngineClient } from "@/lib/engine/client";
import type { BatchResult, StripSpec } from "@/lib/engine/protocol";
import type { Progress } from "@/lib/engine/rpc";
import { errorMessage } from "@/lib/errors";
import { formatBytes, MAX_BATCH_FILES, outputFileName, precheckFile, sizeChange } from "@/lib/files";
import { DEFAULT_OUTPUT, type OutputSettings } from "@/lib/output";
import { isEmptyOverlay, type Overlay } from "@/lib/overlay";
import { defaultConcurrency, runPool } from "@/lib/pool";
import { parseSize, type TargetMode, type TargetSpec } from "@/lib/target";
import { cn } from "@/lib/utils";

import { Dropzone } from "../Dropzone";
import { ChoiceField, Notice, NumberField, ProgressBar, SelectField, SliderField, Spinner, SwitchField } from "../fields";
import { HELP, HelpTip } from "../help";
import { hasPrivateMetadata, MetadataView } from "../MetadataView";
import { OutputSettingsPanel } from "../OutputSettingsPanel";
import { OverlayEditor, type Logo } from "../OverlayEditor";
import { EmptyState, StickyFooter, Workspace } from "../Workspace";

type Status = "checking" | "ready" | "processing" | "done" | "error";

interface Item {
  id: number;
  file: File;
  thumb: string;
  status: Status;
  info?: ImageInfo;
  metadata?: MetadataReport | null;
  error?: string;
  result?: {
    url: string;
    blob: Blob;
    name: string;
    width: number;
    height: number;
    format: ImageFormat;
    lossless: boolean;
    target?: BatchResult["target"];
    /** Set when the file was upscaled with AI, to say where it ran. */
    ai?: Backend;
  };
}

interface TargetSettings {
  enabled: boolean;
  value: number;
  unit: "KB" | "MB";
  mode: TargetMode;
  allowResize: boolean;
}

let nextId = 1;
const noSubscribe = () => () => {};

const STATUS_ICON: Record<Status, React.ReactNode> = {
  checking: <Spinner className="text-muted-foreground" />,
  ready: <Clock aria-hidden className="size-4 text-muted-foreground" />,
  processing: <Spinner className="text-foreground" />,
  done: <CheckCircle2 aria-hidden className="size-4 text-emerald-600 dark:text-emerald-400" />,
  error: <CircleAlert aria-hidden className="size-4 text-destructive" />,
};

const COLOR_MODELS: Record<ImageInfo["colorModel"], string> = {
  grayscale: "Grayscale",
  "grayscale-alpha": "Grayscale + alpha",
  rgb: "RGB",
  rgba: "RGBA",
};

function describe(info: ImageInfo): string {
  const extras = [COLOR_MODELS[info.colorModel], info.bitsPerChannel === 16 ? "16-bit" : null, info.animated ? "animated" : null];
  return [SOURCE_LABELS[info.format], `${info.width} × ${info.height}`, ...extras.filter(Boolean), formatBytes(info.byteSize)].join(" · ");
}

type ResizeMode = "none" | BatchResize["mode"] | "ai";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <AccordionItem value={id}>
      <AccordionTrigger className="text-sm font-medium">{title}</AccordionTrigger>
      <AccordionContent className="flex flex-col gap-4">{children}</AccordionContent>
    </AccordionItem>
  );
}

export function Utilities() {
  const [items, setItems] = useState<Item[]>([]);
  const [output, setOutput] = useState<OutputSettings>({ ...DEFAULT_OUTPUT, quality: 82 });
  const [resize, setResize] = useState<BatchResize>(DEFAULT_BATCH_RESIZE);
  const [target, setTarget] = useState<TargetSettings>({ enabled: false, value: 200, unit: "KB", mode: "atMost", allowResize: false });
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [logo, setLogo] = useState<Logo | null>(null);
  const [strip, setStrip] = useState<StripSpec & { enabled: boolean }>({ enabled: false, keepOrientation: true, keepIcc: true });
  const [ai, setAi] = useState<{ enabled: boolean; factor: UpscaleFactor }>({ enabled: false, factor: 2 });
  /** Step of the current AI upscale (download, tile progress). */
  const [aiStep, setAiStep] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [zipping, setZipping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const parallel = useSyncExternalStore(
    noSubscribe,
    () => String(defaultConcurrency()),
    () => "a few",
  );
  const abortRef = useRef<AbortController | null>(null);
  const clientsRef = useRef<{ terminate(): void }[]>([]);
  const cancelledRef = useRef(false);
  const inspector = useRef<EngineClient | null>(null);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  useEffect(() => {
    const client = new EngineClient();
    inspector.current = client;
    return () => {
      client.terminate();
      inspector.current = null;
      clientsRef.current.forEach((c) => c.terminate());
      itemsRef.current.forEach((i) => {
        URL.revokeObjectURL(i.thumb);
        if (i.result) URL.revokeObjectURL(i.result.url);
      });
    };
  }, []);
  useEffect(() => {
    if (logo) return () => URL.revokeObjectURL(logo.url);
  }, [logo]);

  const update = (id: number, patch: Partial<Item>) => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const addFiles = async (files: File[]) => {
    setNotice(null);
    const room = MAX_BATCH_FILES - items.length;
    const accepted = files.slice(0, Math.max(0, room));
    if (files.length > accepted.length)
      setNotice(`Only ${MAX_BATCH_FILES} files can be added at once; ${files.length - accepted.length} were skipped.`);
    const added = accepted.map((file): Item => {
      const problem = precheckFile(file);
      return { id: nextId++, file, thumb: URL.createObjectURL(file), status: problem ? "error" : "checking", error: problem ?? undefined };
    });
    setItems((list) => [...list, ...added]);
    // Read each header (format, size, colour model, metadata) one at a time.
    for (const item of added.filter((i) => i.status === "checking")) {
      try {
        const bytes = await item.file.arrayBuffer();
        const { info, metadata } = await inspector.current!.call("inspect", { bytes }, [bytes]);
        update(
          item.id,
          info.animated
            ? { status: "error", info, metadata, error: "Animated images are not supported yet." }
            : { status: "ready", info, metadata },
        );
      } catch (err) {
        update(item.id, { status: "error", error: errorMessage(err) });
      }
    }
  };

  const remove = (id: number) =>
    setItems((list) => {
      const item = list.find((i) => i.id === id);
      if (item) URL.revokeObjectURL(item.thumb);
      if (item?.result) URL.revokeObjectURL(item.result.url);
      return list.filter((i) => i.id !== id);
    });

  const clearAll = () => {
    items.forEach((i) => {
      URL.revokeObjectURL(i.thumb);
      if (i.result) URL.revokeObjectURL(i.result.url);
    });
    setItems([]);
    setNotice(null);
    setProgress(null);
  };

  const upscaling = ai.enabled && !strip.enabled;
  const resizeMode: ResizeMode = ai.enabled ? "ai" : resize.enabled ? resize.mode : "none";
  const built = ai.enabled ? { ops: [] } : batchOps(resize);
  const tooLarge = ai.enabled ? items.filter((i) => i.info && upscaleProblem(i.info.width, i.info.height, ai.factor)).length : 0;
  const targetBytes = parseSize(target.value, target.unit);
  const targetError =
    target.enabled && (!Number.isFinite(target.value) || target.value <= 0) ? "Enter a target size greater than 0." : null;
  const visibleOverlays = overlays.filter((o) => !isEmptyOverlay(o));
  // Files that can be (re)processed: ready, done (settings may have changed), or failed during processing.
  const runnable = items.filter((i) => i.info && !i.info.animated && i.status !== "checking" && i.status !== "processing");
  const done = items.filter((i) => i.status === "done");
  const failed = items.filter((i) => i.status === "error");
  const blocked = "error" in built || !!targetError;

  const addLogo = async (file: File): Promise<string | null> => {
    const bytes = await file.arrayBuffer();
    const id = `logo-${Date.now()}`;
    // Validate it once in the inspector worker; each batch worker gets a copy at start.
    try {
      await inspector.current!.call("setLogo", { id, bytes: bytes.slice(0) });
    } catch (err) {
      setNotice(`Could not use that logo: ${errorMessage(err)}`);
      return null;
    }
    setLogo({ id, url: URL.createObjectURL(file), bytes });
    return id;
  };

  const start = async () => {
    if (blocked || "error" in built || runnable.length === 0) return;
    const ops = built.ops;
    const settings = output;
    const stripSpec: StripSpec | undefined = strip.enabled ? { keepOrientation: strip.keepOrientation, keepIcc: strip.keepIcc } : undefined;
    const targetSpec: TargetSpec | undefined =
      !strip.enabled && target.enabled ? { bytes: targetBytes, mode: target.mode, allowResize: target.allowResize } : undefined;
    const layers = strip.enabled ? [] : visibleOverlays;
    const controller = new AbortController();
    abortRef.current = controller;
    cancelledRef.current = false;
    setRunning(true);
    setProgress({ done: 0, total: runnable.length });
    for (const i of runnable) {
      if (i.result) URL.revokeObjectURL(i.result.url);
      update(i.id, { status: "ready", error: undefined, result: undefined });
    }
    // AI upscaling runs one file at a time: it is heavy and uses the GPU when available.
    const aiClient = upscaling ? new AiClient() : null;
    const clients = aiClient
      ? [aiClient]
      : Array.from({ length: Math.min(defaultConcurrency(), runnable.length) }, () => new EngineClient());
    clientsRef.current = clients;
    const factor = ai.factor;
    try {
      if (layers.some((o) => o.kind === "image") && logo) {
        await Promise.all(clients.map((c) => c.call("setLogo", { id: logo.id, bytes: logo.bytes.slice(0) })));
      }
      await runPool(
        runnable,
        clients.length,
        async (item, slot) => {
          update(item.id, { status: "processing" });
          try {
            const bytes = await item.file.arrayBuffer();
            const r: BatchResult & { backend?: Backend } = aiClient
              ? await aiClient.call(
                  "upscale",
                  { bytes, factor, device: "auto", output: settings, overlays: layers, target: targetSpec },
                  [bytes],
                  setAiStep,
                )
              : await (clients[slot] as EngineClient).call(
                  "process",
                  { bytes, ops: strip.enabled ? [] : ops, output: settings, overlays: layers, target: targetSpec, strip: stripSpec },
                  [bytes],
                );
            const blob = new Blob([r.bytes], { type: r.mimeType });
            const resized = r.width !== r.sourceInfo.width || r.height !== r.sourceInfo.height;
            const suffix = r.lossless ? "clean" : resized ? `${r.width}x${r.height}` : "";
            update(item.id, {
              status: "done",
              result: {
                url: URL.createObjectURL(blob),
                blob,
                name: outputFileName(item.file.name, suffix, r.format),
                width: r.width,
                height: r.height,
                format: r.format,
                lossless: r.lossless,
                target: r.target,
                ai: r.backend,
              },
            });
          } catch (err) {
            if (cancelledRef.current) update(item.id, { status: "ready" });
            else update(item.id, { status: "error", error: errorMessage(err) });
            throw err;
          } finally {
            setAiStep(null);
            setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
          }
        },
        controller.signal,
      );
    } finally {
      // Terminating the workers releases all WASM memory used by the run.
      clients.forEach((c) => c.terminate());
      clientsRef.current = [];
      setItems((list) => list.map((i) => (i.status === "processing" ? { ...i, status: "ready" } : i)));
      setRunning(false);
      abortRef.current = null;
    }
  };

  /** Stops immediately: running jobs are abandoned and their workers ended. */
  const cancelNow = () => {
    cancelledRef.current = true;
    abortRef.current?.abort();
    clientsRef.current.forEach((c) => c.terminate());
  };

  const downloadZip = async () => {
    setZipping(true);
    try {
      const zip = await buildZip(done.map((i) => ({ name: i.result!.name, blob: i.result!.blob })));
      const url = URL.createObjectURL(zip);
      const a = document.createElement("a");
      a.href = url;
      a.download = "images.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setNotice(`Could not build the ZIP: ${errorMessage(err)}`);
    } finally {
      setZipping(false);
    }
  };

  const totalIn = done.reduce((s, i) => s + i.file.size, 0);
  const totalOut = done.reduce((s, i) => s + i.result!.blob.size, 0);
  const singleSource = items.length === 1 && items[0]!.info ? items[0]!.info.format : null;
  const anyTransparent = items.some((i) => i.info?.hasAlphaChannel);
  const unstrippable = strip.enabled ? items.filter((i) => i.info && !(i.metadata?.strippable ?? false)).length : 0;

  // Sits right below the quality slider, which it replaces while a target is set.
  const targetBlock = (
    <div className="flex flex-col gap-4" data-testid="target-size">
      <SwitchField
        label="Aim for a file size"
        hint={HELP.targetSize}
        checked={target.enabled}
        onChange={(enabled) => setTarget({ ...target, enabled })}
      />
      {target.enabled ? (
        <>
          <ChoiceField<TargetMode>
            label="Target type"
            value={target.mode}
            onChange={(mode) => setTarget({ ...target, mode })}
            options={[
              { value: "atMost", label: "At most" },
              { value: "atLeast", label: "At least" },
            ]}
          />
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <NumberField label="Target size" value={target.value} min={1} onChange={(value) => setTarget({ ...target, value })} />
            <SelectField<"KB" | "MB">
              label="Unit"
              value={target.unit}
              onChange={(unit) => setTarget({ ...target, unit })}
              options={[
                { value: "KB", label: "KB" },
                { value: "MB", label: "MB" },
              ]}
            />
          </div>
          <SwitchField
            label={target.mode === "atMost" ? "Allow shrinking dimensions" : "Allow enlarging dimensions"}
            checked={target.allowResize}
            onChange={(allowResize) => setTarget({ ...target, allowResize })}
          />
          <p className="text-xs text-muted-foreground">
            Works best with JPEG, WebP or AVIF. The real result is shown for every file; an exact size cannot be guaranteed.
            {target.mode === "atLeast" ? " A larger file is not a better-looking one." : ""}
          </p>
          {targetError ? <Notice tone="danger">{targetError}</Notice> : null}
        </>
      ) : null}
    </div>
  );

  const settings = (
    <Accordion type="multiple" defaultValue={["format", "resize"]} className="px-4">
      <Section id="metadata" title="Metadata">
        <SwitchField
          label="Only remove metadata (lossless)"
          hint={HELP.stripOnly}
          checked={strip.enabled}
          onChange={(enabled) => setStrip({ ...strip, enabled })}
        />
        {strip.enabled ? (
          <>
            <SwitchField
              label="Keep orientation"
              hint={HELP.keepOrientation}
              checked={strip.keepOrientation}
              onChange={(keepOrientation) => setStrip({ ...strip, keepOrientation })}
            />
            <SwitchField
              label="Keep colour profile"
              hint={HELP.keepIcc}
              checked={strip.keepIcc}
              onChange={(keepIcc) => setStrip({ ...strip, keepIcc })}
            />
            <Notice>Format, size and watermark settings are ignored in this mode; files keep their exact pixels.</Notice>
            {unstrippable ? (
              <Notice tone="warning">
                {unstrippable} file{unstrippable === 1 ? "" : "s"} can&rsquo;t be cleaned losslessly (only JPEG, PNG and WebP can). Turn
                this off and convert them instead: converted files never contain metadata.
              </Notice>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Converted files never contain the original&rsquo;s metadata (location, camera, dates).
          </p>
        )}
      </Section>
      <fieldset disabled={strip.enabled} className={cn("contents", strip.enabled && "[&_*]:opacity-60")}>
        <Section id="format" title="Format & file size">
          <OutputSettingsPanel
            value={output}
            onChange={setOutput}
            sourceFormat={singleSource}
            hasTransparency={items.length === 1 && !!items[0]!.info?.hasAlphaChannel}
            hideQuality={target.enabled}
            targetSlot={targetBlock}
          />
          {items.length !== 1 && anyTransparent && (output.format === "jpeg" || output.format === "bmp") ? (
            <Notice tone="warning">Some files have an alpha channel; transparent areas will be filled with the background colour.</Notice>
          ) : null}
        </Section>
        <Section id="resize" title="Resize">
          <ChoiceField<ResizeMode>
            label="Resize by"
            showLabel
            hint={HELP.resize}
            value={resizeMode}
            onChange={(m) => {
              setAi({ ...ai, enabled: m === "ai" });
              setResize(m === "none" || m === "ai" ? { ...resize, enabled: false } : { ...resize, enabled: true, mode: m });
            }}
            options={[
              { value: "none", label: "Original" },
              { value: "fit", label: "Fit" },
              { value: "percent", label: "Scale" },
              { value: "ai", label: "AI upscale" },
            ]}
          />
          {resizeMode === "ai" ? (
            <>
              <ChoiceField<string>
                label="Upscale factor"
                showLabel
                hint={HELP.aiUpscale}
                value={String(ai.factor)}
                onChange={(v) => setAi({ ...ai, factor: Number(v) as UpscaleFactor })}
                options={[
                  { value: "2", label: "2×" },
                  { value: "4", label: "4×" },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                Uses {MODELS["realesrgan-x4v3"].name} ({formatBytes(MODELS["realesrgan-x4v3"].bytes)}, {MODELS["realesrgan-x4v3"].license}),
                downloaded once from this site. Runs on your GPU with WebGPU, otherwise on the CPU, where a 1 MP photo can take a minute or
                more. Files are upscaled one at a time.
              </p>
              <Notice tone="warning">AI upscaling invents plausible detail; it cannot recover what the camera didn&rsquo;t capture.</Notice>
              {tooLarge ? (
                <Notice tone="warning">
                  {tooLarge} file{tooLarge === 1 ? " is" : "s are"} too large for {ai.factor}× (the result would exceed 50 MP).
                </Notice>
              ) : null}
            </>
          ) : null}
          {resizeMode === "fit" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  label="Max width"
                  value={resize.maxWidth}
                  min={1}
                  onChange={(maxWidth) => setResize({ ...resize, maxWidth })}
                  suffix="px"
                />
                <NumberField
                  label="Max height"
                  value={resize.maxHeight}
                  min={1}
                  onChange={(maxHeight) => setResize({ ...resize, maxHeight })}
                  suffix="px"
                />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="allow-upscale"
                  checked={resize.allowUpscale}
                  onCheckedChange={(v) => setResize({ ...resize, allowUpscale: v === true })}
                />
                <Label htmlFor="allow-upscale" className="font-normal">
                  Enlarge smaller images
                </Label>
                <HelpTip term="enlarging">{HELP.upscale}</HelpTip>
              </div>
              <p className="text-xs text-muted-foreground">Aspect ratio is always kept. Lanczos3 resampling.</p>
            </>
          ) : resizeMode === "percent" ? (
            <SliderField
              label="Scale"
              value={resize.percent}
              min={1}
              max={400}
              defaultValue={50}
              onChange={(percent) => setResize({ ...resize, percent })}
              format={(v) => `${v}%`}
            />
          ) : null}
          {"error" in built ? <Notice tone="danger">{built.error}</Notice> : null}
        </Section>
        <Section id="watermark" title="Watermark">
          <OverlayEditor overlays={overlays} onChange={setOverlays} logo={logo} onLogo={addLogo} />
        </Section>
      </fieldset>
    </Accordion>
  );

  const actions = (
    <StickyFooter>
      {running && progress ? (
        <div className="flex flex-col gap-1" data-testid="progress">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
          >
            <div className="h-full bg-foreground transition-[width]" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <p className="text-center text-xs text-muted-foreground">
            {progress.done} of {progress.total} files
          </p>
          {aiStep ? <ProgressBar label={aiStep.label} fraction={aiStep.fraction} testId="ai-progress" /> : null}
        </div>
      ) : null}
      {running ? (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => abortRef.current?.abort()}>
            Finish current
          </Button>
          <Button variant="destructive" onClick={cancelNow}>
            <Square aria-hidden /> Cancel now
          </Button>
        </div>
      ) : (
        <Button size="lg" onClick={start} disabled={runnable.length === 0 || blocked} className="w-full">
          <Play aria-hidden />
          {runnable.length
            ? `${strip.enabled ? "Clean" : "Process"} ${runnable.length} file${runnable.length === 1 ? "" : "s"}`
            : "Add images to process"}
        </Button>
      )}
      {done.length > 1 ? (
        <Button variant="outline" onClick={downloadZip} disabled={zipping || running} className="w-full">
          {zipping ? <Spinner /> : <FileArchive aria-hidden />} Download all as ZIP ({done.length})
        </Button>
      ) : null}
      <p className="text-center text-xs text-muted-foreground">
        {upscaling ? (
          <>
            <Sparkles aria-hidden className="inline size-3" /> AI upscaling processes one file at a time.
          </>
        ) : (
          `Up to ${parallel} files are processed in parallel in background workers.`
        )}
      </p>
    </StickyFooter>
  );

  if (items.length === 0) {
    return (
      <EmptyState
        title="Convert, compress & resize"
        description="Day-to-day jobs for one image or hundreds: convert, compress, resize, hit a target size, watermark or remove metadata. Download one by one or as a ZIP."
      >
        {notice ? <Notice tone="warning">{notice}</Notice> : null}
        <Dropzone multiple onFiles={(f) => void addFiles(f)} />
      </EmptyState>
    );
  }

  const list = (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <Dropzone multiple compact onFiles={(f) => void addFiles(f)} />
      {notice ? <Notice tone="warning">{notice}</Notice> : null}
      <div className="overflow-hidden rounded-xl border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <p className="text-sm" data-testid="batch-summary" aria-live="polite">
            <span className="font-medium">{items.length}</span> file{items.length === 1 ? "" : "s"}
            {done.length ? <span className="text-emerald-600 dark:text-emerald-400"> · {done.length} done</span> : null}
            {failed.length ? <span className="text-destructive"> · {failed.length} failed</span> : null}
            {done.length ? (
              <span className="text-muted-foreground">
                {" "}
                · {formatBytes(totalIn)} → {formatBytes(totalOut)} ({sizeChange(totalIn, totalOut).label})
              </span>
            ) : null}
          </p>
          <Button variant="ghost" size="sm" onClick={clearAll} disabled={running}>
            <Trash2 aria-hidden /> Clear all
          </Button>
        </div>
        <ul className="divide-y">
          {items.map((item) => {
            const change = item.result ? sizeChange(item.file.size, item.result.blob.size) : null;
            const open = expanded.has(item.id);
            const t = item.result?.target;
            return (
              <li key={item.id} className="flex flex-col gap-2 px-4 py-3" data-testid="batch-item" data-status={item.status}>
                <div className="flex items-center gap-3">
                  <div className="checker size-12 shrink-0 overflow-hidden rounded-md border">
                    {/* eslint-disable-next-line @next/next/no-img-element -- blob URL of the user's file */}
                    <img src={item.result?.url ?? item.thumb} alt="" className="size-full object-cover" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-medium" title={item.file.name}>
                      <span className="shrink-0" title={item.status}>
                        {STATUS_ICON[item.status]}
                        <span className="sr-only">{item.status}</span>
                      </span>
                      <span className="truncate">{item.file.name}</span>
                      {item.metadata?.hasGps ? (
                        <span className="flex shrink-0 items-center text-amber-600 dark:text-amber-400" title="Contains location data">
                          <MapPin aria-label="Contains location data" className="size-3.5" />
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" data-testid="item-info">
                      {item.info ? describe(item.info) : item.status === "checking" ? "Reading…" : formatBytes(item.file.size)}
                    </p>
                    {item.status === "error" ? (
                      <p className="truncate text-xs text-destructive">{item.error}</p>
                    ) : item.result && change ? (
                      <p className="truncate text-xs" data-testid="item-result">
                        → {item.result.lossless ? "metadata removed · " : ""}
                        {item.result.ai ? `AI ${item.result.ai === "webgpu" ? "(GPU)" : "(CPU)"} · ` : ""}
                        {FORMATS[item.result.format].label} · {item.result.width} × {item.result.height} ·{" "}
                        {formatBytes(item.result.blob.size)}{" "}
                        <span
                          className={
                            change.kind === "smaller" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                          }
                        >
                          ({change.label})
                        </span>
                      </p>
                    ) : null}
                    {t ? (
                      <p
                        className={cn("text-xs", t.met ? "text-emerald-600 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}
                        data-testid="item-target"
                      >
                        {t.met ? "Target met" : `Target not met: ${t.reason ?? ""}`} · quality {t.quality}
                        {t.scale !== 1 ? ` · resized to ${Math.round(t.scale * 100)}%` : ""}
                      </p>
                    ) : null}
                  </div>
                  {item.info ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${open ? "Hide" : "Show"} details for ${item.file.name}`}
                      aria-expanded={open}
                      onClick={() =>
                        setExpanded((s) => {
                          const n = new Set(s);
                          if (n.has(item.id)) n.delete(item.id);
                          else n.add(item.id);
                          return n;
                        })
                      }
                    >
                      <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
                    </Button>
                  ) : null}
                  {item.result ? (
                    <Button asChild variant="outline" size="sm">
                      <a href={item.result.url} download={item.result.name} aria-label={`Download ${item.result.name}`}>
                        <Download aria-hidden /> {FORMATS[item.result.format].extension.toUpperCase()}
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => remove(item.id)}
                    disabled={running}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
                {open ? (
                  <div className="ml-15 rounded-lg bg-muted/50 p-3">
                    <MetadataView report={item.metadata ?? null} />
                    {hasPrivateMetadata(item.metadata ?? null) ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Turn on &ldquo;Only remove metadata&rdquo;, or convert the file, to remove it.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );

  return (
    <Workspace
      main={list}
      panel={
        <div className="flex min-h-full flex-col">
          {settings}
          {actions}
        </div>
      }
    />
  );
}
