import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";

/** Which list an exe sits on, as an explicit override of game auto-detection for
 *  the performance *recorder* (separate from the OSD show/hide list):
 *
 *  - `white` = force RECORD (sample a session even if NOT auto-detected as a game).
 *  - `black` = NEVER record (skip entirely, even if it IS auto-detected) — lets the
 *    user kill any false-positive.
 */
export type RecordListKind = "white" | "black";

/** A per-process performance-recording rule. */
export interface RecordTarget {
  /** Lowercased executable name, e.g. "cyberpunk2077.exe". */
  name: string;
  list: RecordListKind;
}

interface RecordTargetsStore {
  targets: RecordTarget[];
  /** Add an exe by name (no-op if already present). New entries default to the
   *  white list (force-record). */
  addTarget: (name: string, list?: RecordListKind) => void;
  removeTarget: (name: string) => void;
  setTargetList: (name: string, list: RecordListKind) => void;
}

/** Normalize an exe name the way both the backend and Task-Manager rows produce
 *  it (trimmed + lowercased) so matches are case-insensitive. */
function normName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Per-process performance-recording white / black list.
 *
 * This is intentionally SEPARATE from `useOsdTargets` (the OSD show/hide list):
 * it controls which apps get a perf report recorded, not whether the overlay is
 * drawn. Persisted to the shared tauri-store file under its own key so it
 * survives crashes (same backend as every other store).
 *
 * NOTE on versioning: there is deliberately NO `version`/`migrate` that discards
 * state. A prior store wiped saved data by bumping its version without a
 * migrate; we avoid that footgun by omitting `version` entirely (defaults to 0)
 * so the persisted `{ targets }` shape is always rehydrated as-is.
 */
export const useRecordTargets = create<RecordTargetsStore>()(
  persist(
    (set) => ({
      targets: [],
      addTarget: (name, list = "white") =>
        set((s) => {
          const n = normName(name);
          if (!n || s.targets.some((t) => t.name === n)) return s;
          return { targets: [...s.targets, { name: n, list }] };
        }),
      removeTarget: (name) =>
        set((s) => ({ targets: s.targets.filter((t) => t.name !== normName(name)) })),
      setTargetList: (name, list) =>
        set((s) => ({
          targets: s.targets.map((t) => (t.name === normName(name) ? { ...t, list } : t)),
        })),
    }),
    { name: "corepilot-record-targets", storage: createJSONStorage(() => tauriStorage) },
  ),
);
