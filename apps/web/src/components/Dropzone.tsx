"use client";

import { ImageUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ACCEPT_ATTR, formatBytes, MAX_INPUT_BYTES } from "@/lib/files";
import { cn } from "@/lib/utils";

export function Dropzone({
  onFiles,
  multiple = false,
  compact = false,
}: {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  });

  // Paste from clipboard anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) onFilesRef.current(multiple ? files : files.slice(0, 1));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [multiple]);

  const take = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        take(e.dataTransfer.files);
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed bg-background text-center transition-colors",
        compact ? "px-4 py-5" : "px-6 py-14",
        dragging && "border-primary bg-muted",
      )}
    >
      {compact ? null : (
        <span className="flex size-12 items-center justify-center rounded-full bg-muted">
          <ImageUp aria-hidden className="size-6 text-muted-foreground" />
        </span>
      )}
      <div className="flex flex-col items-center gap-1">
        <p className="text-sm font-medium">Drop {multiple ? "images" : "an image"} here or paste</p>
        <p className="text-xs text-muted-foreground">
          JPEG, PNG, WebP, AVIF, HEIC, GIF, TIFF, BMP, ICO · up to {formatBytes(MAX_INPUT_BYTES)} · never leaves your device
        </p>
      </div>
      <Button variant={compact ? "outline" : "default"} size={compact ? "sm" : "default"} onClick={() => inputRef.current?.click()}>
        {multiple ? "Choose images" : "Choose an image"}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple={multiple}
        className="sr-only"
        tabIndex={-1}
        data-testid="file-input"
        aria-label={multiple ? "Choose images" : "Choose an image"}
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
