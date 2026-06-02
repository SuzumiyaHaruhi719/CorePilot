import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";
import type { PerfSession } from "../lib/perf";

/** Max sessions retained in history (oldest dropped first). */
const MAX_SESSIONS = 50;

interface PerfHistoryStore {
  sessions: PerfSession[];
  /** Add a finished session (newest first), capped at MAX_SESSIONS. */
  addSession: (session: PerfSession) => void;
  removeSession: (id: string) => void;
  clear: () => void;
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
      addSession: (session) =>
        set((s) => ({ sessions: [session, ...s.sessions].slice(0, MAX_SESSIONS) })),
      removeSession: (id) => set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),
      clear: () => set({ sessions: [] }),
    }),
    {
      name: "corepilot-perf-history",
      // v2: PerfSample gained optional fields (gpuMemClock, gpuFan, disk/net,…)
      // and PerfSummary gained energy/CO₂ + more aggregates. All additions are
      // optional/nullable, so older persisted sessions load unchanged — their
      // new chart series simply read as "no data" and the energy/CO₂ headline
      // shows "—". No data transform is required; the bump is documentary.
      version: 2,
      storage: createJSONStorage(() => tauriStorage),
    },
  ),
);
