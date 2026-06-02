import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";
import type { PerfSession } from "../lib/perf";

/** Max sessions retained in history (oldest dropped first). */
const MAX_SESSIONS = 50;

interface PerfHistoryStore {
  sessions: PerfSession[];
  /**
   * Set by the recorder when a session should be surfaced automatically (game
   * just exited + "auto-show report" on). The Monitor → 历史 view reads this to
   * auto-select that session, then calls `clearPendingReport`. Not persisted —
   * a stale flag must never survive a restart.
   */
  pendingReportId: string | null;
  /** Add a finished session (newest first), capped at MAX_SESSIONS. */
  addSession: (session: PerfSession) => void;
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
 */
export const usePerfHistory = create<PerfHistoryStore>()(
  persist(
    (set) => ({
      sessions: [],
      pendingReportId: null,
      addSession: (session) =>
        set((s) => ({ sessions: [session, ...s.sessions].slice(0, MAX_SESSIONS) })),
      removeSession: (id) =>
        set((s) => ({
          sessions: s.sessions.filter((x) => x.id !== id),
          pendingReportId: s.pendingReportId === id ? null : s.pendingReportId,
        })),
      clear: () => set({ sessions: [], pendingReportId: null }),
      setPendingReport: (id) => set({ pendingReportId: id }),
      clearPendingReport: () => set({ pendingReportId: null }),
    }),
    {
      name: "corepilot-perf-history",
      version: 1,
      storage: createJSONStorage(() => tauriStorage),
      // Persist only the saved sessions — the pending flag is transient UI intent.
      partialize: (s) => ({ sessions: s.sessions }),
    },
  ),
);
