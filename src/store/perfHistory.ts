import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";
import {
  deleteAllSamples,
  deleteSamples,
  loadSamples,
  saveSamples,
  sweepOrphanSamples,
  type PerfSessionMeta,
} from "../lib/perfSamples";
import type { PerfSample } from "../lib/perf";

/** Max sessions retained in history (oldest dropped first). */
const MAX_SESSIONS = 50;

interface PerfHistoryStore {
  sessions: PerfSessionMeta[];
  /**
   * Set by the recorder when a session should be surfaced automatically (game
   * just exited + "auto-show report" on). The Monitor → 历史 view reads this to
   * auto-select that session, then calls `clearPendingReport`. Not persisted —
   * a stale flag must never survive a restart.
   */
  pendingReportId: string | null;
  /**
   * Add a finished session (newest first), capped at MAX_SESSIONS.
   *
   * Takes METADATA only: the caller must already have written the samples file
   * (`saveSamples`) — see `usePerfRecorder`. Anything aged out by the cap has
   * its file deleted here, best-effort.
   */
  addSession: (session: PerfSessionMeta) => void;
  removeSession: (id: string) => void;
  clear: () => void;
  /** Request that `id` be surfaced in the report view. */
  setPendingReport: (id: string) => void;
  /** Clear the pending request once it has been consumed. */
  clearPendingReport: () => void;
}

/**
 * Persisted history of finished game performance sessions. Written by the perf
 * recorder on game exit; read by the Monitor → 历史 sub-tab. File-backed (see
 * tauriStorage) so it survives crashes and restarts.
 *
 * Only session METADATA lives here (~1 KB each). The ~1200-point sample arrays
 * live one file per session under `app_data_dir()/perf-sessions/` and are
 * loaded on demand by `lib/perfSamples`; keeping them inline made this one key
 * 22 MB of the 24 MB store, which every unrelated `persist_set` then rewrote.
 */
export const usePerfHistory = create<PerfHistoryStore>()(
  persist(
    (set, get) => ({
      sessions: [],
      pendingReportId: null,
      addSession: (session) => {
        const next = [session, ...get().sessions];
        const dropped = next.slice(MAX_SESSIONS);
        set({ sessions: next.slice(0, MAX_SESSIONS) });
        // Aged-out rows would otherwise leave their sample file behind forever.
        for (const d of dropped) deleteSamples(d.id);
      },
      removeSession: (id) => {
        deleteSamples(id);
        set((s) => ({
          sessions: s.sessions.filter((x) => x.id !== id),
          pendingReportId: s.pendingReportId === id ? null : s.pendingReportId,
        }));
      },
      clear: () => {
        deleteAllSamples();
        set({ sessions: [], pendingReportId: null });
      },
      setPendingReport: (id) => set({ pendingReportId: id }),
      clearPendingReport: () => set({ pendingReportId: null }),
    }),
    {
      name: "corepilot-perf-history",
      version: 2,
      storage: createJSONStorage(() => tauriStorage),
      // Persist only the saved sessions — the pending flag is transient UI intent.
      partialize: (s) => ({ sessions: s.sessions }),
      /**
       * v1 → v2: move each session's inline `samples` into its own file.
       *
       * A version bump WITHOUT a working migrate makes zustand discard the whole
       * persisted blob (that wiped real data once), so this migrate is the entire
       * safety story for 50 recorded sessions. It is async — zustand awaits the
       * returned promise and writes the result back itself.
       *
       * Ordering is deliberate: write the file, and only strip `samples` from the
       * row once that write RESOLVED. A failed write keeps the samples inline
       * (nothing is ever lost); `repairInlineSamples` retries after hydration and
       * `useSessionSamples` reads the inline copy meanwhile. The `.bak` the
       * backend refreshes on load still holds the pre-split store as a rollback.
       */
      migrate: async (persisted, version) => {
        const state = (persisted ?? {}) as { sessions?: unknown };
        const rows = Array.isArray(state.sessions) ? state.sessions : [];
        if (version >= 2) return { ...state, sessions: rows as PerfSessionMeta[] };
        const sessions: PerfSessionMeta[] = [];
        for (const row of rows) {
          const s = row as PerfSessionMeta | null;
          if (!s || typeof s !== "object" || typeof s.id !== "string") continue;
          sessions.push(await splitSamples(s));
        }
        return { ...state, sessions };
      },
      /**
       * After hydration (and after the async migrate above), once: retry any row
       * whose sample file never landed, drop files with no row left, and warm the
       * newest session's samples so opening Monitor → 历史 paints its charts with
       * data on the first frame, exactly as it did when they were inline.
       */
      onRehydrateStorage: () => (state, error) => {
        // Never sweep on a failed OR EMPTY hydration — an empty `sessions` is
        // the post-wipe signature (transient store read failure, or a migrate
        // that has not populated yet), and sweeping against an empty live-id
        // set deletes EVERY sample file on disk: the user's entire recorded
        // history, permanently. `!state` alone does not catch it, because a
        // failed read still hydrates `{ sessions: [] }` from the defaults.
        // Skipping the sweep costs nothing: orphan files are harmless (swept on
        // the next non-empty hydration) and `clear()` deletes files directly.
        if (error || !state || state.sessions.length === 0) return;
        void repairInlineSamples();
        void sweepOrphanSamples(() => new Set(usePerfHistory.getState().sessions.map((s) => s.id)));
        const newest = state.sessions[0];
        if (newest && !newest.samples) void loadSamples(newest.id).catch(() => undefined);
      },
    },
  ),
);

/**
 * Write `session`'s inline samples to its own file and return the row without
 * them. On a write failure the row is returned UNCHANGED (samples still inline)
 * — losing a recorded session is strictly worse than leaving one fat row.
 */
async function splitSamples(session: PerfSessionMeta): Promise<PerfSessionMeta> {
  const samples = session.samples;
  if (!Array.isArray(samples)) {
    // Already split (or a malformed row): nothing to move.
    const { samples: _absent, ...meta } = session;
    return meta;
  }
  try {
    await saveSamples(session.id, samples as PerfSample[]);
    const { samples: _saved, ...meta } = session;
    return meta;
  } catch {
    return session;
  }
}

/**
 * Retry the split for any row still carrying inline samples (its v1 → v2 write
 * failed, or the recorder's write failed at game exit). Best-effort and silent:
 * a row that still can't be written just stays inline for another run.
 */
async function repairInlineSamples(): Promise<void> {
  const pending = usePerfHistory.getState().sessions.filter((s) => Array.isArray(s.samples));
  if (pending.length === 0) return;
  const fixed = new Map<string, PerfSessionMeta>();
  for (const s of pending) {
    const meta = await splitSamples(s);
    if (!meta.samples) fixed.set(s.id, meta);
  }
  if (fixed.size === 0) return;
  usePerfHistory.setState((s) => ({
    sessions: s.sessions.map((row) => fixed.get(row.id) ?? row),
  }));
}
