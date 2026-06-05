import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";

interface TweakState {
  /** Applied state per tweak id (true = applied/optimized). */
  applied: Record<string, boolean>;
  setApplied: (id: string, value: boolean) => void;
}

/** Tracks which optimization tweaks the user has applied. Persisted so the
 *  toggle state survives restarts; the actual system changes are made by the
 *  backend `tweak_apply` / `tweak_revert` commands. */
export const useTweaks = create<TweakState>()(
  persist(
    (set) => ({
      applied: {},
      setApplied: (id, value) =>
        set((s) => ({ applied: { ...s.applied, [id]: value } })),
    }),
    { name: "corepilot-tweaks", version: 1, storage: createJSONStorage(() => tauriStorage) },
  ),
);
