import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";

interface TweakState {
  /** Applied state per tweak id (true = applied/optimized). */
  applied: Record<string, boolean>;
  /** Pre-apply snapshot (JSON from `tweak_apply`) per tweak id, used to restore
   *  the EXACT prior state on revert. Absent/empty → revert uses the documented
   *  Windows default. */
  snapshots: Record<string, string>;
  setApplied: (id: string, value: boolean) => void;
  /** Persist the snapshot returned by `tweak_apply` for `id`. */
  setSnapshot: (id: string, snapshot: string) => void;
}

/** Tracks which optimization tweaks the user has applied, plus the pre-apply
 *  snapshot captured for each so a revert restores the user's real prior values.
 *  Persisted so both survive restarts; the actual system changes are made by the
 *  backend `tweak_apply` / `tweak_revert` commands. */
export const useTweaks = create<TweakState>()(
  persist(
    (set) => ({
      applied: {},
      snapshots: {},
      setApplied: (id, value) =>
        set((s) => ({ applied: { ...s.applied, [id]: value } })),
      setSnapshot: (id, snapshot) =>
        set((s) => ({ snapshots: { ...s.snapshots, [id]: snapshot } })),
    }),
    {
      name: "corepilot-tweaks",
      version: 2,
      storage: createJSONStorage(() => tauriStorage),
      // v1 had no `snapshots`; backfill it so older persisted state loads cleanly.
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Partial<TweakState>;
        return {
          applied: state.applied ?? {},
          snapshots: state.snapshots ?? {},
        } as TweakState;
      },
    },
  ),
);
