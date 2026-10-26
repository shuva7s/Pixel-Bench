"use client";

import { SOURCE_LABELS, type ImageFormat, type ImageInfo } from "@image-tools/engine/shared";
import { Cpu, Download, Eye, ImagePlus, Sparkles, X, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AiClient } from "@/lib/ai/client";
import { DEFAULT_EDGES, type EdgeSettings } from "@/lib/ai/mask";
import { MODELS, siteUrl, type ModelId } from "@/lib/ai/models";
import type { Backend, BackdropSpec, SegmentResult } from "@/lib/ai/protocol";
import type { Progress } from "@/lib/engine/rpc";
import { errorMessage } from "@/lib/errors";
import { formatBytes, outputFileName, precheckFile } from "@/lib/files";
import { DEFAULT_OUTPUT, hexToRgb, resolveFormat, type OutputSettings } from "@/lib/output";

import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { Dropzone } from "../Dropzone";
import { ChoiceField, Notice, ProgressBar, SliderField, Spinner } from "../fields";
import { HELP, HelpTip, Tip } from "../help";
import { OutputSettingsPanel } from "../OutputSettingsPanel";
import { Section } from "../editor/Panels";
import { EmptyState, FitBox, StickyFooter, Workspace } from "../Workspace";

const PREVIEW_MAX_SIDE = 1400;

type BackdropKind = BackdropSpec["kind"];
type ViewMode = "result" | "mask" | "original";

interface Loaded {
  file: File;
  url: string;
  info: ImageInfo;
  hasTransparency: boolean;
  handle: number;
}

interface Exported {
  url: string;
  name: string;
  size: number;
  format: ImageFormat;
}

const BACKEND_LABEL: Record<Backend, string> = { webgpu: "GPU (WebGPU)", wasm: "CPU (WebAssembly)" };

export function RemoveBackground() {
  const clientRef = useRef<AiClient | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [caps, setCaps] = useState<{ webgpu: boolean; cached: ModelId[] } | null>(null);
  const [image, setImage] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelId>("u2netp");
  /** The user agreed to download the large model (or it is already cached). */
  const [consented, setConsented] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [segmented, setSegmented] = useState<(SegmentResult & { model: ModelId; handle: number }) | null>(null);
  const [edges, setEdges] = useState<EdgeSettings>(DEFAULT_EDGES);
  const [kind, setKind] = useState<BackdropKind>("transparent");
  const [color, setColor] = useState("#ffffff");
  const [blur, setBlur] = useState(40);
  const [backdropFile, setBackdropFile] = useState<{ name: string; url: string } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("result");
  const [output, setOutput] = useState<OutputSettings>({ ...DEFAULT_OUTPUT, format: "png" });
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<Exported | null>(null);
  const [shown, setShown] = useState<[number, number] | null>(null);

  useEffect(() => {
    const client = new AiClient();
    clientRef.current = client;
    client
      .call("capabilities", undefined)
      .then((c) => {
        setCaps(c);
        // Fast needs no extra download, so it is the default until High quality has been downloaded (and can run here).
        if (c.cached.includes("birefnet-lite")) {
          setConsented(true);
          if (c.webgpu) setModel("birefnet-lite");
        }
      })
      .catch(() => setCaps({ webgpu: false, cached: [] }));
    return () => {
      client.terminate();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (image) return () => URL.revokeObjectURL(image.url);
  }, [image]);
  useEffect(() => {
    if (exported) return () => URL.revokeObjectURL(exported.url);
  }, [exported]);
  useEffect(() => {
    if (backdropFile) return () => URL.revokeObjectURL(backdropFile.url);
  }, [backdropFile]);

  /** The model only runs on WebGPU and this browser has none. */
  const gpuMissing = MODELS[model].requiresGpu === true && caps !== null && !caps.webgpu;
  const needsConsent = model === "birefnet-lite" && !consented && !gpuMissing;
  const ready = segmented !== null && image !== null && segmented.handle === image.handle;

  const segment = useCallback(async (target: Loaded, which: ModelId) => {
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    setProgress({ label: "Starting", fraction: null });
    try {
      const r = await client.call("segment", { handle: target.handle, model: which, device: "auto" }, [], setProgress);
      setSegmented({ ...r, model: which, handle: target.handle });
      setCaps((c) => (c && !c.cached.includes(which) ? { ...c, cached: [...c.cached, which] } : c));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  }, []);

  /** Downloads and verifies a model before any photo is open. */
  const prepare = async (which: ModelId) => {
    setError(null);
    setProgress({ label: "Starting", fraction: null });
    try {
      await clientRef.current!.call("prepare", { model: which }, [], setProgress);
      setCaps((c) => (c && !c.cached.includes(which) ? { ...c, cached: [...c.cached, which] } : c));
    } catch (err) {
      setConsented(false);
      setError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  // Run the model once per opened photo, as soon as it is usable. This also
  // covers photos opened before the device check (WebGPU, cached models) finished.
  const autoRan = useRef<number | null>(null);
  useEffect(() => {
    if (!image || caps === null || needsConsent || gpuMissing || autoRan.current === image.handle) return;
    autoRan.current = image.handle;
    void segment(image, model);
  }, [image, caps, needsConsent, gpuMissing, model, segment]);

  const closeImage = useCallback(() => {
    if (image) void clientRef.current?.call("close", { handle: image.handle }).catch(() => {});
    setImage(null);
    setSegmented(null);
    setExported(null);
    setShown(null);
    setError(null);
    setViewMode("result");
  }, [image]);

  const openFile = async (file: File) => {
    const client = clientRef.current;
    if (!client) return;
    closeImage();
    const problem = precheckFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setLoading(true);
    try {
      const bytes = await file.arrayBuffer();
      const opened = await client.call("open", { bytes }, [bytes]);
      setImage({ file, url: URL.createObjectURL(file), ...opened });
    } catch (err) {
      setError(`Could not open "${file.name}": ${errorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const backdrop: BackdropSpec =
    kind === "color"
      ? { kind, color: hexToRgb(color) }
      : kind === "blur"
        ? { kind, amount: blur }
        : kind === "image" && backdropFile
          ? { kind }
          : { kind: "transparent" };

  // Preview: at most one request in flight; the newest settings always win.
  const previewKey =
    ready && viewMode !== "original" ? JSON.stringify({ h: image.handle, edges, backdrop, mask: viewMode === "mask", s: segmented }) : null;
  const latest = useRef<string | null>(null);
  const pumping = useRef(false);
  const pump = useCallback(() => {
    if (pumping.current) return;
    pumping.current = true;
    void (async () => {
      let rendered: string | null = null;
      try {
        while (latest.current !== null && latest.current !== rendered) {
          rendered = latest.current;
          const {
            h,
            edges: e,
            backdrop: b,
            mask,
          } = JSON.parse(rendered) as {
            h: number;
            edges: EdgeSettings;
            backdrop: BackdropSpec;
            mask: boolean;
          };
          const frame = await clientRef.current!.call("preview", { handle: h, maxSide: PREVIEW_MAX_SIDE, edges: e, backdrop: b, mask });
          const canvas = canvasRef.current;
          if (!canvas) continue;
          canvas.width = frame.width;
          canvas.height = frame.height;
          canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0);
          setShown([frame.width, frame.height]);
        }
      } catch (err) {
        setError(`Preview failed: ${errorMessage(err)}`);
      } finally {
        pumping.current = false;
      }
    })();
  }, []);
  useEffect(() => {
    latest.current = previewKey;
    if (previewKey) pump();
  }, [previewKey, pump]);

  const chooseBackdrop = async (file: File) => {
    try {
      const bytes = await file.arrayBuffer();
      await clientRef.current!.call("setBackdrop", { bytes }, [bytes]);
      setBackdropFile({ name: file.name, url: URL.createObjectURL(file) });
      setKind("image");
    } catch (err) {
      setError(`Could not use that background: ${errorMessage(err)}`);
    }
  };

  const doExport = async () => {
    if (!image || !ready) return;
    setExporting(true);
    setError(null);
    try {
      const r = await clientRef.current!.call("render", { handle: image.handle, edges, backdrop, output });
      const blob = new Blob([r.bytes], { type: r.mimeType });
      const next: Exported = {
        url: URL.createObjectURL(blob),
        name: outputFileName(image.file.name, "no-bg", r.format),
        size: blob.size,
        format: r.format,
      };
      setExported(next);
      const a = document.createElement("a");
      a.href = next.url;
      a.download = next.name;
      a.click();
    } catch (err) {
      setError(`Export failed: ${errorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const spec = MODELS[model];

  const modelSection = (
    <Section id="model" title="AI model">
      <ChoiceField<ModelId>
        label="Model"
        showLabel
        hint={HELP.bgModel}
        value={model}
        onChange={(m) => {
          setModel(m);
          if (m === "birefnet-lite" && caps?.cached.includes(m)) setConsented(true);
        }}
        options={[
          { value: "u2netp", label: "Fast" },
          { value: "birefnet-lite", label: "High quality" },
        ]}
      />
      <p className="text-xs text-muted-foreground" data-testid="model-info">
        {spec.name} · {formatBytes(spec.bytes)} · {spec.license} licence ·{" "}
        {caps?.cached.includes(model) ? "downloaded" : spec.host === "this site" ? "served by this site" : `downloaded from ${spec.host}`}
      </p>
      {gpuMissing ? (
        <Notice tone="warning">
          High quality needs WebGPU (graphics-card acceleration), which this browser doesn&rsquo;t provide: the model is too large to run on
          the CPU. Use Fast, or open this page in a browser with WebGPU, such as a recent desktop Chrome or Edge.
        </Notice>
      ) : needsConsent ? (
        <div className="flex flex-col gap-3 rounded-lg border p-3 text-sm" data-testid="consent">
          <p>
            High quality needs a one-time download of <strong>{formatBytes(spec.bytes)}</strong> from {spec.host}. Your photo is not
            uploaded: Hugging Face only sees a normal file download (including your IP address). The file is checked against a pinned
            SHA-256 fingerprint and kept on this device for next time.
          </p>
          <Button
            size="sm"
            onClick={() => {
              setConsented(true);
              if (image) {
                autoRan.current = image.handle; // started here, not by the auto-run effect
                void segment(image, model);
              } else void prepare(model);
            }}
          >
            <Download aria-hidden /> Download model{image ? " & remove background" : ""}
          </Button>
        </div>
      ) : image && !progress && (!ready || segmented.model !== model) ? (
        <Button size="sm" variant={ready ? "outline" : "default"} onClick={() => void segment(image, model)}>
          <Sparkles aria-hidden /> {ready ? `Run again with ${model === "u2netp" ? "Fast" : "High quality"}` : "Remove background"}
        </Button>
      ) : null}
      {progress && !image ? <ProgressBar label={progress.label} fraction={progress.fraction} testId="ai-progress" /> : null}
      {ready ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="segment-result">
          {segmented.backend === "webgpu" ? <Zap aria-hidden className="size-3.5" /> : <Cpu aria-hidden className="size-3.5" />}
          {MODELS[segmented.model].name} on {BACKEND_LABEL[segmented.backend]} · {(segmented.ms / 1000).toFixed(1)} s
          <HelpTip term="WebGPU">{HELP.aiDevice}</HelpTip>
        </p>
      ) : null}
      {ready && segmented.empty ? (
        <Notice tone="warning">
          The model didn&rsquo;t find a subject in this photo. Try the other model, or a photo with a clearer main subject.
        </Notice>
      ) : null}
    </Section>
  );

  if (!image) {
    return (
      <EmptyState
        title="Remove background"
        description="Cut out the subject of a photo with an AI model that runs on this device. Keep it transparent or put it on a new background."
      >
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {loading ? (
          <div className="flex items-center justify-center gap-3 rounded-xl border px-6 py-16 text-muted-foreground">
            <Spinner /> Decoding image…
          </div>
        ) : (
          <Dropzone onFiles={(files) => void openFile(files[0]!)} />
        )}
        <Accordion type="multiple" defaultValue={["model"]} className="rounded-xl border px-4">
          {modelSection}
        </Accordion>
      </EmptyState>
    );
  }

  const [boxW, boxH] = shown ?? [image.info.width, image.info.height];
  const targetFormat = resolveFormat(output, image.info.format);
  const transparentOut = kind === "transparent" || image.hasTransparency;

  const stage = (
    <>
      <FitBox width={boxW} height={boxH}>
        <canvas
          ref={canvasRef}
          aria-label="Result preview"
          data-testid="preview-canvas"
          className={ready && viewMode !== "original" ? "absolute inset-0 size-full" : "invisible absolute inset-0 size-full"}
        />
        {!ready || viewMode === "original" ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob URL of the user's file
          <img src={image.url} alt="Original" className="absolute inset-0 size-full object-contain" />
        ) : null}
        {progress ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 p-6 backdrop-blur-[2px]">
            <div className="w-full max-w-xs rounded-lg border bg-background p-4 shadow-sm">
              <ProgressBar label={progress.label} fraction={progress.fraction} testId="ai-progress" />
            </div>
          </div>
        ) : null}
      </FitBox>
      <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-xs text-white">
        {viewMode === "original" || !ready ? "Original" : viewMode === "mask" ? "Mask" : "Result"} · {image.info.width} ×{" "}
        {image.info.height}
      </span>
    </>
  );

  const panel = (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col gap-3 border-b p-4 lg:sticky lg:top-0 lg:z-10 lg:bg-background">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={image.file.name}>
              {image.file.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {SOURCE_LABELS[image.info.format]} · {image.info.width} × {image.info.height} · {formatBytes(image.file.size)}
            </p>
          </div>
          <Tip content="Close this photo">
            <Button variant="ghost" size="icon-sm" aria-label="Close image" onClick={closeImage}>
              <X aria-hidden />
            </Button>
          </Tip>
        </div>
        <ChoiceField<ViewMode>
          label="View"
          value={viewMode}
          onChange={setViewMode}
          options={[
            { value: "result", label: "Result" },
            { value: "mask", label: "Mask" },
            { value: "original", label: "Original" },
          ]}
        />
      </div>

      <Accordion type="multiple" defaultValue={["model", "background", "export"]} className="px-4">
        {modelSection}
        <Section id="background" title="Background">
          <ChoiceField<BackdropKind>
            label="Behind the subject"
            showLabel
            hint={HELP.backdrop}
            value={kind}
            onChange={(k) => {
              setKind(k);
              // Transparent results need a format that keeps transparency.
              if (k === "transparent" && targetFormat === "jpeg") setOutput({ ...output, format: "png" });
            }}
            options={[
              { value: "transparent", label: "None" },
              { value: "color", label: "Colour" },
              { value: "blur", label: "Blur" },
              { value: "image", label: "Image" },
            ]}
          />
          {kind === "color" ? (
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="bg-color">Colour</Label>
              <div className="flex items-center gap-2">
                {["#ffffff", "#000000", "#f1f5f9", "#2563eb"].map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Use ${c}`}
                    onClick={() => setColor(c)}
                    className="size-6 rounded-md border shadow-xs"
                    style={{ background: c }}
                  />
                ))}
                <input
                  id="bg-color"
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-8 w-10 cursor-pointer rounded-md border bg-transparent p-0.5"
                />
              </div>
            </div>
          ) : null}
          {kind === "blur" ? (
            <SliderField label="Blur strength" value={blur} min={5} max={100} defaultValue={40} onChange={setBlur} />
          ) : null}
          {kind === "image" ? (
            <div className="flex flex-col gap-2">
              {backdropFile ? (
                <p className="truncate text-xs text-muted-foreground">Using {backdropFile.name}</p>
              ) : (
                <p className="text-xs text-muted-foreground">Choose a photo to place behind the subject. It is scaled to fill the frame.</p>
              )}
              <Button variant="outline" size="sm" asChild>
                <label className="cursor-pointer">
                  <ImagePlus aria-hidden /> {backdropFile ? "Change image" : "Choose image"}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    aria-label="Background image"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void chooseBackdrop(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </Button>
            </div>
          ) : null}
        </Section>
        <Section
          id="edges"
          title="Edges"
          modified={JSON.stringify(edges) !== JSON.stringify(DEFAULT_EDGES)}
          onReset={() => setEdges(DEFAULT_EDGES)}
        >
          <SliderField
            label="Hardness"
            hint={HELP.edgeHardness}
            value={edges.hardness}
            min={0}
            max={100}
            onChange={(hardness) => setEdges({ ...edges, hardness })}
          />
          <SliderField
            label="Shift edge"
            hint={HELP.edgeShift}
            value={edges.shift}
            min={-50}
            max={50}
            onChange={(shift) => setEdges({ ...edges, shift })}
          />
          <SliderField
            label="Feather"
            hint={HELP.feather}
            value={edges.feather}
            min={0}
            max={100}
            onChange={(feather) => setEdges({ ...edges, feather })}
          />
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Eye aria-hidden className="size-3.5" /> Switch the view to Mask to see exactly what is kept (white) and removed (black).
          </p>
        </Section>
        <Section id="export" title="Export">
          <OutputSettingsPanel value={output} onChange={setOutput} sourceFormat={image.info.format} hasTransparency={transparentOut} />
        </Section>
      </Accordion>

      <p className="px-4 pt-3 text-xs text-muted-foreground">
        AI cut-outs can miss fine detail or include bits of background; check the edges before using the result.{" "}
        <a className="underline underline-offset-2" href={siteUrl(spec.licenseUrl)} target="_blank" rel="noreferrer">
          Model licence
        </a>
      </p>

      <StickyFooter>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button size="lg" onClick={doExport} disabled={!ready || exporting || progress !== null} className="w-full shadow-sm">
          {exporting ? <Spinner /> : <Download aria-hidden />}
          {exporting ? "Exporting…" : `Export ${targetFormat.toUpperCase()} · ${image.info.width} × ${image.info.height}`}
        </Button>
        {exported ? (
          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground" data-testid="export-result">
            <span className="truncate">
              Saved {exported.name} · {formatBytes(exported.size)}
            </span>
            <Button asChild variant="link" size="xs" className="h-auto shrink-0 px-0">
              <a href={exported.url} download={exported.name}>
                Download again
              </a>
            </Button>
          </p>
        ) : null}
      </StickyFooter>
    </div>
  );

  return <Workspace pinMain main={stage} panel={panel} />;
}
