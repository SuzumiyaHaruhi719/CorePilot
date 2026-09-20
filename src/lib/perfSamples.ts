import { api } from "./ipc";
import type { PerfSample, PerfSession } from "./perf";

/**
 * Lazy access to a perf session's sample array, which lives in its own file
 * (`app_data_dir()/perf-sessions/<id>.json`, written by `persist.rs`) instead
 * of inline in the shared zustand store.
 *
 * Why: 50 sessions x 1200 samples x 21 fields was 22 MB of the 24 MB
 * `corepilot.store.json`, so EVERY `persist_set` of ANY key rewrote + fsynced
 * 24 MB, Tauri parsed that body on the main thread before the command future
 * was even spawned, and both webviews hydrated (and JSON.parsed) the whole
 * thing at startup. The store now keeps ~1 KB of metadata per session
 * (`PerfSessionMeta`) and the report view pulls the samples on demand.
 *
 * The cache is a tiny LRU with in-flight dedupe (same shape as
 * `ProcIcon.tsx`'s icon cache): browsing the history list keeps the last few
 * reports instant without ever holding all 50 sample arrays in the JS heap.
 */

/**
 * A history row: everything about a finished session except the samples.
 *
 * `samples` survives as an OPTIONAL legacy field only for rows the v1→v2
 * migration could not split (the sample file write failed). Nothing new ever
 * writes it; `repairInlineSamples` retries those writes after hydration and
 * `useSessionSamples` reads them meanwhile, so a failed write never loses data.
 */
export type PerfSessionMeta = Omit<PerfSession, "samples"> & {
  samples?: PerfSample[];
};

/** How many sample arrays stay resident (~400 KB each). */
const MAX_CACHED = 5;

/** id → samples, in LRU order (Map iterates in insertion order). */
const CACHE = new Map<string, PerfSample[]>();
/** id → pending load, so N components asking at once make one IPC call. */
const INFLIGHT = new Map<string, Promise<PerfSample[]>>();
/**
 * Ids whose file this process wrote. The orphan sweep must never delete these:
 * the recorder writes the file BEFORE adding the store row, so between those
 * two steps a sweep would otherwise see a legitimately-new file as an orphan.
 */
const SAVED = new Set<string>();

/** Insert/refresh `id` as the most-recently-used entry, evicting the oldest. */
function touch(id: string, samples: PerfSample[]): void {
  CACHE.delete(id);
  CACHE.set(id, samples);
  while (CACHE.size > MAX_CACHED) {
    const oldest = CACHE.keys().next().value;
    if (oldest === undefined) break;
    CACHE.delete(oldest);
  }
}

/** Cached samples for `id`, or undefined when not resident. Synchronous: lets
 *  a prefetched report render with data on its very first paint. */
export function peekSamples(id: string): PerfSample[] | undefined {
  const hit = CACHE.get(id);
  if (hit !== undefined) touch(id, hit);
  return hit;
}

/**
 * Samples for `id`, from the LRU cache or the backing file. A missing/unreadable
 * file resolves to `[]` (an orphaned row renders an empty chart rather than
 * throwing); an IPC failure resolves to `[]` too but is NOT cached, so the next
 * attempt retries.
 */
export function loadSamples(id: string): Promise<PerfSample[]> {
  const hit = peekSamples(id);
  if (hit !== undefined) return Promise.resolve(hit);
  const existing = INFLIGHT.get(id);
  if (existing) return existing;
  const req = api
    .perfSessionLoad(id)
    .then((json) => {
      const samples = parseSamples(json);
      INFLIGHT.delete(id);
      // A `null` is NOT reliably "there is no such file": the backend maps EVERY
      // read error to null (a sharing violation while an AV scans the file, a
      // transient IO error). Caching that would pin a blank report onto an
      // intact file for the rest of the session — and the natural reaction to a
      // permanently empty report is to delete the row, which destroys the data
      // for real. Leave it uncached so the next open retries.
      if (json !== null) touch(id, samples);
      return samples;
    })
    .catch(() => {
      INFLIGHT.delete(id);
      return [] as PerfSample[]; // deliberately not cached — retryable
    });
  INFLIGHT.set(id, req);
  return req;
}

function parseSamples(json: string | null): PerfSample[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as PerfSample[]) : [];
  } catch {
    return []; // truncated file — chart is empty, the row still lists
  }
}

/**
 * Write one session's samples and prime the cache. REJECTS on failure — the
 * recorder awaits this before adding the history row, so a caller must decide
 * what to do rather than silently creating a row with no samples.
 */
export async function saveSamples(id: string, samples: PerfSample[]): Promise<void> {
  // Claim the id BEFORE the write, not after. The file becomes visible to
  // `perf_session_ids` the instant the atomic rename lands, which is before this
  // promise resolves — so marking it afterwards leaves a window where the id is
  // in neither the store nor `SAVED`, and a concurrent sweep deletes a file that
  // is about to get a row. That window is wide open during the v1→v2 migrate
  // (seconds of sequential fsync'd writes, with the sweep queued behind them).
  SAVED.add(id);
  await api.perfSessionSave(id, JSON.stringify(samples));
  touch(id, samples);
}

/** Drop one session's file (best-effort) and forget it locally. */
export function deleteSamples(id: string): void {
  CACHE.delete(id);
  INFLIGHT.delete(id);
  SAVED.delete(id);
  void api.perfSessionDelete(id).catch(() => undefined);
}

/** Drop every session file (history "清空"), best-effort. */
export function deleteAllSamples(): void {
  CACHE.clear();
  INFLIGHT.clear();
  SAVED.clear();
  void api.perfSessionDeleteAll().catch(() => undefined);
}

/**
 * Delete sample files with no history row left. Orphans are expected and
 * harmless — the recorder writes the file first on purpose, so a crash in the
 * gap leaves a file, never a row that charts nothing — this just stops them
 * accumulating. Best-effort and guarded: `liveIds` must be the CURRENT store
 * ids, read after hydration, and anything this process wrote is skipped.
 */
export async function sweepOrphanSamples(liveIds: () => Set<string>): Promise<void> {
  let ids: string[];
  try {
    ids = await api.perfSessionIds();
  } catch {
    return;
  }
  if (ids.length === 0) return;
  const live = liveIds();
  for (const id of ids) {
    if (live.has(id) || SAVED.has(id)) continue;
    void api.perfSessionDelete(id).catch(() => undefined);
  }
}
