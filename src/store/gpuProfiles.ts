import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GpuOcSettings } from "../lib/ipc";
import { tauriStorage } from "../lib/persist";

export interface GpuProfile {
  id: string;
  name: string;
  settings: GpuOcSettings;
}

function uid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

interface GpuProfileState {
  profiles: GpuProfile[];
  activeId: string | null;
  applyOnStartup: boolean;
  /** Set when an "apply on startup" attempt failed, surfaced on the GPU page.
   *  Not persisted — it reflects this session's launch only. */
  startupError: string | null;
  addProfile: (name: string, settings: GpuOcSettings) => string;
  updateProfile: (id: string, patch: Partial<Omit<GpuProfile, "id">>) => void;
  deleteProfile: (id: string) => void;
  setActive: (id: string | null) => void;
  setApplyOnStartup: (value: boolean) => void;
  setStartupError: (message: string | null) => void;
}

/** GPU overclock profiles auto-persist to localStorage. */
export const useGpuProfiles = create<GpuProfileState>()(
  persist(
    (set) => ({
      profiles: [],
      activeId: null,
      applyOnStartup: false,
      startupError: null,
      addProfile: (name, settings) => {
        const id = uid();
        set((s) => ({ profiles: [...s.profiles, { id, name, settings }], activeId: id }));
        return id;
      },
      updateProfile: (id, patch) =>
        set((s) => ({ profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
      deleteProfile: (id) =>
        set((s) => ({
          profiles: s.profiles.filter((p) => p.id !== id),
          activeId: s.activeId === id ? null : s.activeId,
        })),
      setActive: (activeId) => set({ activeId }),
      setApplyOnStartup: (applyOnStartup) => set({ applyOnStartup }),
      setStartupError: (startupError) => set({ startupError }),
    }),
    {
      name: "corepilot-gpu-profiles",
      version: 1,
      storage: createJSONStorage(() => tauriStorage),
      // `startupError` is session-only — never persist it.
      partialize: (s) => ({ profiles: s.profiles, activeId: s.activeId, applyOnStartup: s.applyOnStartup }),
    },
  ),
);
