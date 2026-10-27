import { EngineError, type EngineErrorCode } from "@/lib/shared";

const FRIENDLY: Partial<Record<EngineErrorCode, string>> = {
  ENGINE_CRASHED: "The image engine ran out of memory or crashed and has been restarted. Please open the image again.",
};

export function errorMessage(err: unknown): string {
  if (err instanceof EngineError) return FRIENDLY[err.code] ?? err.message;
  return err instanceof Error ? err.message : String(err);
}
