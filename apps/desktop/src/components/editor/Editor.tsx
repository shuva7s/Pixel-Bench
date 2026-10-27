"use client";

import { EngineError, SOURCE_LABELS, type ImageFormat, type ImageInfo, type MetadataReport } from "@/lib/shared";
import { Download, Eye, Redo2, RotateCcw, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { aspectRatio, centeredRect } from "@/lib/crop";
import {
  autoTone,
  canRedo,
  canUndo,
  computeHistogram,
  editOps,
  editOverlays,
  frameSize,
  historyReducer,
  initialHistory,
  INITIAL_EDIT,
  isEditNeutral,
  outputSize,
  type DevelopSettings,
  type EditState,
  type Histogram,
} from "@/lib/editor";
import { EngineClient } from "@/lib/engine/client";
import { errorMessage } from "@/lib/errors";
import { saveAs, showInFolder } from "@/lib/native/files";
import { formatBytes, outputFileName, precheckFile, sizeChange } from "@/lib/files";
import { flipHorizontal, flipVertical, orientationOps, rotateBy } from "@/lib/orientation";
import { DEFAULT_OUTPUT, resolveFormat, type OutputSettings } from "@/lib/output";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";

import { Dropzone } from "../Dropzone";
import { MetadataView } from "../MetadataView";
import { OverlayEditor, type Logo } from "../OverlayEditor";
import { Notice, Spinner } from "../fields";
import { OutputSettingsPanel } from "../OutputSettingsPanel";
import { HELP, HelpTip, Tip } from "../help";
import { EmptyState, FitBox, StickyFooter, Workspace } from "../Workspace";
import { CropOverlay } from "./CropOverlay";
import { HistogramView } from "./HistogramView";
import {
  ColorSection,
  DetailSection,
  EffectsSection,
  FrameSection,
  GeometrySection,
  LightSection,
  MixerSection,
  PresetsSection,
  Section,
} from "./Panels";

/** Preview resolution when idle, and while a slider is being dragged. */
const PREVIEW_MAX_SIDE = 1400;
const DRAFT_MAX_SIDE = 800;
const REFINE_DELAY_MS = 250;

interface Loaded {
  file: File;
  url: string;
  info: ImageInfo;
  hasTransparency: boolean;
  handle: number;
  metadata: MetadataReport | null;
}

interface Exported {
  path: string;
  name: string;
  size: number;
  width: number;
  height: number;
  format: ImageFormat;
}

export function Editor() {
  const clientRef = useRef<EngineClient | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, dispatch] = useReducer(historyReducer, undefined, () => initialHistory());
  const [cropping, setCropping] = useState(false);
  const [before, setBefore] = useState(false);
  const [histogram, setHistogram] = useState<Histogram | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [output, setOutput] = useState<OutputSettings>({ ...DEFAULT_OUTPUT, quality: 92 });
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<Exported | null>(null);
  const [logo, setLogo] = useState<Logo | null>(null);
  const edit = history.present;

  useEffect(() => {
    const client = new EngineClient();
    clientRef.current = client;
    return () => {
      client.terminate();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (image) return () => URL.revokeObjectURL(image.url);
  }, [image]);
  useEffect(() => {
    if (logo) return () => URL.revokeObjectURL(logo.url);
  }, [logo]);

  /** Registers a logo file with the worker for image overlays. */
  const addLogo = async (file: File): Promise<string | null> => {
    try {
      const bytes = await file.arrayBuffer();
      const id = `logo-${Date.now()}`;
      await clientRef.current!.call("setLogo", { id, bytes: bytes.slice(0) });
      setLogo({ id, url: URL.createObjectURL(file), bytes });
      return id;
    } catch (err) {
      setError(`Could not use that logo: ${errorMessage(err)}`);
      return null;
    }
  };

  // Merge rapid changes (slider drags) into one undo step.
  useEffect(() => {
    if (history.present === history.committed) return;
    const t = setTimeout(() => dispatch({ type: "commit" }), 350);
    return () => clearTimeout(t);
  }, [history.present, history.committed]);

  const setEdit = useCallback((next: EditState) => dispatch({ type: "set", state: next }), []);
  const setDevelop = (develop: DevelopSettings) => setEdit({ ...edit, develop });

  const closeImage = useCallback(() => {
    if (image) void clientRef.current?.call("close", { handle: image.handle }).catch(() => {});
    setImage(null);
    setExported(null);
    setHistogram(null);
    setCropping(false);
    setError(null);
    dispatch({ type: "reset", state: INITIAL_EDIT });
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

  // Live preview. While settings change, a fast draft is rendered at a lower
  // resolution; once they settle, the full preview replaces it. At most one
  // render is in flight; the newest request always wins.
  const previewOps = image
    ? JSON.stringify({ ops: editOps(edit, image.info.width, image.info.height, cropping), overlays: editOverlays(edit, cropping) })
    : null;
  // "<handle> <maxSide> <{ops, overlays} json>" of the newest requested preview.
  const latestPreview = useRef<string | null>(null);
  const pumping = useRef(false);
  const lastHandle = useRef<number | null>(null);
  const [shown, setShown] = useState<[number, number] | null>(null);

  const pump = useCallback(() => {
    if (pumping.current) return;
    pumping.current = true;
    void (async () => {
      let rendered: string | null = null;
      try {
        while (latestPreview.current !== rendered) {
          const key: string = latestPreview.current!;
          rendered = key;
          const [handle, maxSide] = key.split(" ", 2).map(Number) as [number, number];
          const { ops, overlays } = JSON.parse(key.slice(key.indexOf(" ", key.indexOf(" ") + 1) + 1));
          setPreviewBusy(true);
          const frame = await clientRef.current!.call("preview", { handle, ops, overlays, maxSide });
          const canvas = canvasRef.current;
          if (!canvas) continue;
          const pixels = new Uint8ClampedArray(frame.pixels);
          canvas.width = frame.width;
          canvas.height = frame.height;
          canvas.getContext("2d")?.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
          setShown([frame.width, frame.height]);
          setHistogram(computeHistogram(pixels));
        }
      } catch (err) {
        setError(`Preview failed: ${errorMessage(err)}`);
        if (err instanceof EngineError && err.code === "ENGINE_CRASHED") closeImage();
      } finally {
        pumping.current = false;
        setPreviewBusy(false);
      }
    })();
  }, [closeImage]);

  useEffect(() => {
    if (!image || previewOps === null) return;
    const request = (side: number) => {
      latestPreview.current = `${image.handle} ${side} ${previewOps}`;
      pump();
    };
    if (lastHandle.current !== image.handle) {
      // First preview of a newly opened image: go straight to full quality.
      lastHandle.current = image.handle;
      request(PREVIEW_MAX_SIDE);
      return;
    }
    request(DRAFT_MAX_SIDE);
    const refine = setTimeout(() => request(PREVIEW_MAX_SIDE), REFINE_DELAY_MS);
    return () => clearTimeout(refine);
  }, [image, previewOps, pump]);

  // Keyboard: undo/redo and "\" to toggle the before view.
  useEffect(() => {
    if (!image) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement && e.target.type !== "range";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (e.key === "\\" && !typing) {
        setBefore((b) => !b);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [image]);

  const runAuto = async () => {
    if (!image) return;
    setAutoBusy(true);
    try {
      // Analyse the unedited image so Auto does not compound earlier edits.
      const frame = await clientRef.current!.call("preview", {
        handle: image.handle,
        ops: orientationOps(edit.orientation),
        maxSide: PREVIEW_MAX_SIDE,
      });
      const auto = autoTone(computeHistogram(new Uint8Array(frame.pixels)));
      setEdit({ ...edit, develop: { ...edit.develop, ...auto } });
      // The next preview of the edited settings re-draws the canvas.
    } catch (err) {
      setError(`Auto failed: ${errorMessage(err)}`);
    } finally {
      setAutoBusy(false);
    }
  };

  const doExport = async () => {
    if (!image) return;
    setExporting(true);
    setError(null);
    try {
      const r = await clientRef.current!.call("render", {
        handle: image.handle,
        ops: editOps(edit, image.info.width, image.info.height),
        output,
        overlays: editOverlays(edit),
      });
      const path = await saveAs(outputFileName(image.file.name, "edited", r.format), r.bytes);
      if (path) {
        setExported({
          path,
          name: path.split(/[\/]/).pop() ?? path,
          size: r.bytes.byteLength,
          width: r.width,
          height: r.height,
          format: r.format,
        });
      }
    } catch (err) {
      setError(`Export failed: ${errorMessage(err)}`);
      if (err instanceof EngineError && err.code === "ENGINE_CRASHED") closeImage();
    } finally {
      setExporting(false);
    }
  };

  if (!image) {
    return (
      <EmptyState
        title="Photo editor"
        description="Light, colour, colour mixer, effects, crop and straighten with a live preview. Your photo stays on this device."
      >
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {loading ? (
          <div className="flex items-center justify-center gap-3 rounded-xl border px-6 py-16 text-muted-foreground">
            <Spinner /> Decoding image…
          </div>
        ) : (
          <Dropzone onFiles={(files) => void openFile(files[0]!)} />
        )}
      </EmptyState>
    );
  }

  const [frameW, frameH] = frameSize(edit, image.info.width, image.info.height);
  const [outW, outH] = outputSize(edit, image.info.width, image.info.height);
  const ratio = aspectRatio(edit.aspect, frameW, frameH, edit.customAspect);
  const cropRect = edit.crop ?? { x: 0, y: 0, width: frameW, height: frameH };
  const geometryModified = edit.orientation.rotate !== 0 || edit.orientation.mirror || edit.straighten !== 0 || edit.crop !== null;
  const targetFormat = resolveFormat(output, image.info.format);
  // Size the image box from the last rendered frame so it always matches the canvas.
  const [boxW, boxH] = shown ?? (cropping ? [frameW, frameH] : [outW, outH]);

  const changeOrientation = (orientation: EditState["orientation"]) =>
    // Rotating changes the frame, so the crop no longer applies.
    setEdit({ ...edit, orientation, crop: null });

  const stage = (
    <>
      <FitBox width={boxW} height={boxH}>
        <canvas
          ref={canvasRef}
          aria-label="Edited preview"
          data-testid="preview-canvas"
          className={before ? "invisible absolute inset-0 size-full" : "absolute inset-0 size-full"}
        />
        {cropping && !before ? (
          <CropOverlay rect={cropRect} width={frameW} height={frameH} ratio={ratio} onChange={(crop) => setEdit({ ...edit, crop })} />
        ) : null}
        {before ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob URL of the user's file
          <img src={image.url} alt="Original" className="absolute inset-0 size-full bg-background object-contain" />
        ) : null}
      </FitBox>
      <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-xs text-white">
        {before ? "Before" : cropping ? `Cropping · ${cropRect.width} × ${cropRect.height}` : `${outW} × ${outH}`}
        {previewBusy ? " · rendering…" : ""}
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
        <div className="flex items-center gap-1">
          <Tip content="Undo (Ctrl+Z)">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Undo"
              disabled={!canUndo(history)}
              onClick={() => dispatch({ type: "undo" })}
            >
              <Undo2 aria-hidden />
            </Button>
          </Tip>
          <Tip content="Redo (Ctrl+Shift+Z)">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Redo"
              disabled={!canRedo(history)}
              onClick={() => dispatch({ type: "redo" })}
            >
              <Redo2 aria-hidden />
            </Button>
          </Tip>
          <Tip content={HELP.before}>
            <Button variant={before ? "default" : "outline"} size="sm" aria-pressed={before} onClick={() => setBefore(!before)}>
              <Eye aria-hidden /> Before
            </Button>
          </Tip>
          <Tip content="Undo every edit and return to the original photo">
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={isEditNeutral(edit)}
              onClick={() => setEdit({ ...INITIAL_EDIT })}
            >
              <RotateCcw aria-hidden /> Reset all
            </Button>
          </Tip>
        </div>
        <Accordion type="single" collapsible>
          <AccordionItem value="histogram" className="border-b-0">
            <AccordionTrigger className="py-0 text-xs font-medium text-muted-foreground hover:no-underline">Histogram</AccordionTrigger>
            <AccordionContent className="flex flex-col gap-1.5 pt-2 pb-0">
              <HistogramView histogram={histogram} />
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span aria-hidden className="size-2 rounded-full bg-sky-400" /> Shadows clipping
                </span>
                <span className="flex items-center gap-1">
                  <span aria-hidden className="size-2 rounded-full bg-red-400" /> Highlights clipping
                </span>
                <span className="ml-auto">
                  <HelpTip term="the histogram">{HELP.histogram}</HelpTip>
                </span>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      <Accordion type="multiple" defaultValue={["geometry", "light", "color", "export"]} className="px-4">
        <PresetsSection value={edit.develop} onChange={setDevelop} onAuto={runAuto} autoBusy={autoBusy} />
        <GeometrySection
          cropping={cropping}
          onToggleCrop={() => setCropping(!cropping)}
          aspect={edit.aspect}
          onAspect={(aspect) => {
            setEdit({
              ...edit,
              aspect,
              crop: aspect === "free" ? edit.crop : centeredRect(aspectRatio(aspect, frameW, frameH, edit.customAspect), frameW, frameH),
            });
            setCropping(true);
          }}
          customAspect={edit.customAspect}
          onCustomAspect={(customAspect) => {
            const r = aspectRatio("custom", frameW, frameH, customAspect);
            // Keep the current crop while the ratio being typed is incomplete.
            setEdit({ ...edit, customAspect, crop: r === null ? edit.crop : centeredRect(r, frameW, frameH) });
            setCropping(true);
          }}
          straighten={edit.straighten}
          onStraighten={(straighten) => setEdit({ ...edit, straighten })}
          onRotate={(deg) => changeOrientation(rotateBy(edit.orientation, deg))}
          onFlip={(dir) => changeOrientation(dir === "horizontal" ? flipHorizontal(edit.orientation) : flipVertical(edit.orientation))}
          onReset={() => setEdit({ ...edit, orientation: INITIAL_EDIT.orientation, straighten: 0, crop: null, aspect: "free" })}
          modified={geometryModified}
          summary={`Output ${outW} × ${outH} px${edit.orientation.rotate ? ` · rotated ${edit.orientation.rotate}°` : ""}${
            edit.orientation.mirror ? " · mirrored" : ""
          }${edit.straighten ? ` · straightened ${edit.straighten.toFixed(1)}°` : ""}`}
        />
        <LightSection value={edit.develop} onChange={setDevelop} />
        <ColorSection value={edit.develop} onChange={setDevelop} />
        <MixerSection value={edit.develop} onChange={setDevelop} />
        <EffectsSection value={edit.develop} onChange={setDevelop} />
        <DetailSection value={edit.develop} onChange={setDevelop} />
        <FrameSection value={edit.frame} onChange={(frame) => setEdit({ ...edit, frame })} />
        <Section
          id="overlays"
          title="Text & watermark"
          modified={edit.overlays.length > 0}
          onReset={() => setEdit({ ...edit, overlays: [] })}
        >
          <OverlayEditor overlays={edit.overlays} onChange={(overlays) => setEdit({ ...edit, overlays })} logo={logo} onLogo={addLogo} />
        </Section>
        <Section id="info" title="Info & metadata">
          <p className="text-xs text-muted-foreground">
            Exported files never contain the original&rsquo;s metadata: the editor writes a new file with only the pixels.
          </p>
          <MetadataView report={image.metadata} />
        </Section>
        <Section id="export" title="Export">
          <OutputSettingsPanel
            value={output}
            onChange={setOutput}
            sourceFormat={image.info.format}
            hasTransparency={image.hasTransparency}
          />
        </Section>
      </Accordion>

      <StickyFooter>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button size="lg" onClick={doExport} disabled={exporting} className="w-full shadow-sm">
          {exporting ? <Spinner /> : <Download aria-hidden />}
          {exporting ? "Exporting…" : `Export ${targetFormat.toUpperCase()} · ${outW} × ${outH}`}
        </Button>
        {exported ? (
          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground" data-testid="export-result">
            <span className="truncate">
              Saved {exported.name} · {formatBytes(exported.size)} ({sizeChange(image.file.size, exported.size).label})
            </span>
            <Button variant="link" size="xs" className="h-auto shrink-0 px-0" onClick={() => showInFolder(exported.path)}>
              Show in folder
            </Button>
          </p>
        ) : null}
      </StickyFooter>
    </div>
  );

  return <Workspace pinMain main={stage} panel={panel} />;
}
