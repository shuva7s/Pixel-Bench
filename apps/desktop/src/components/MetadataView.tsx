"use client";

import type { MetadataReport } from "@/lib/shared";
import { MapPin, ShieldAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const GROUP_ORDER = ["Camera", "Image", "GPS", "Interop", "Thumbnail"] as const;

/** Readable summary of the other metadata blocks a file carries. */
function blocks(r: MetadataReport): string[] {
  return [
    r.hasExif && "EXIF",
    r.hasXmp && "XMP",
    r.hasIptc && "IPTC",
    r.hasIcc && "Colour profile (ICC)",
    r.hasComments && "Comments / text",
    r.hasTrailingData && "Hidden data after the image",
  ].filter(Boolean) as string[];
}

export function hasPrivateMetadata(r: MetadataReport | null): boolean {
  if (!r) return false;
  return r.fields.some((f) => f.sensitive) || r.hasGps || r.hasXmp || r.hasIptc || r.hasComments || r.hasTrailingData;
}

/**
 * Shows what a file carries. Sensitive fields (location, serial numbers,
 * owner names) are highlighted. Nothing here is sent anywhere.
 */
export function MetadataView({ report, compact = false }: { report: MetadataReport | null; compact?: boolean }) {
  if (!report) {
    return <p className="text-xs text-muted-foreground">Metadata cannot be inspected for this format. Converting the file removes it.</p>;
  }
  const found = blocks(report);
  if (found.length === 0 && report.fields.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="metadata-none">
        <ShieldCheck aria-hidden className="size-4 text-emerald-600 dark:text-emerald-400" /> No metadata found.
      </p>
    );
  }
  const sensitive = report.fields.filter((f) => f.sensitive);
  return (
    <div className="flex flex-col gap-3" data-testid="metadata-view">
      <div className="flex flex-wrap gap-1.5">
        {found.map((b) => (
          <Badge key={b} variant="secondary">
            {b}
          </Badge>
        ))}
      </div>
      {report.hasGps || sensitive.length ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          {report.hasGps ? (
            <MapPin aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          )}
          {report.hasGps ? "Contains the location where the photo was taken." : "Contains identifying information."} It stays on your
          device, but would be shared with anyone you send the original to.
        </p>
      ) : null}
      {compact ? null : (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {GROUP_ORDER.flatMap((g) =>
            report.fields
              .filter((f) => f.group === g)
              .map((f, i) => (
                <div key={`${g}-${f.tag}-${i}`} className="contents">
                  <dt
                    className={cn("truncate text-muted-foreground", f.sensitive && "text-amber-700 dark:text-amber-400")}
                    title={`${g} · ${f.tag}`}
                  >
                    {f.tag}
                  </dt>
                  <dd className={cn("break-words", f.sensitive && "font-medium text-amber-700 dark:text-amber-400")}>{f.value}</dd>
                </div>
              )),
          )}
        </dl>
      )}
    </div>
  );
}
