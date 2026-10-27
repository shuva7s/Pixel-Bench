/**
 * Runs `task` for every item with at most `concurrency` tasks in flight.
 * Each worker slot index is passed to the task so callers can pin work to a
 * specific resource (e.g. one client per slot). Failures are reported
 * per item; one failure never stops the others.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, slot: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const slots = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: slots }, async (_, slot) => {
      while (next < items.length && !signal?.aborted) {
        const item = items[next++]!;
        try {
          await task(item, slot);
        } catch {
          // The task is responsible for recording its own error state.
        }
      }
    }),
  );
}

export function defaultConcurrency(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  // Each worker can hold a full decoded image; keep memory bounded.
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}
