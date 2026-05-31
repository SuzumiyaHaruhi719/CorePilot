import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AccentName = "violet" | "cyan" | "teal" | "amber" | "rose";

/** OKLCH hue per accent — applied at runtime to `--color-accent`. */
export const ACCENT_HUE: Record<AccentName, number> = {
  violet: 280,
  cyan: 220,
  teal: 182,
  amber: 75,
  rose: 12,
};

export type GlowLevel = "soft" | "medium" | "intense";
export type Language = "zh" | "en";
export type PerfCard = "cpu" | "mem" | "gpu" | "disk" | "net" | "power";

interface SettingsState {
  accent: AccentName;
  glow: GlowLevel;
  acrylic: boolean;
  reduceMotion: boolean;
  language: Language;
  pollMs: number;
  perfCards: Record<PerfCard, boolean>;
  update: (patch: Partial<Omit<SettingsState, "update" | "togglePerfCard">>) => void;
  togglePerfCard: (card: PerfCard) => void;
}

/**
 * All settings auto-persist to localStorage on every change (no save button).
 */
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      accent: "violet",
      glow: "intense",
      acrylic: true,
      reduceMotion: false,
      language: "zh",
      pollMs: 1500,
      perfCards: { cpu: true, mem: true, gpu: true, disk: true, net: true, power: true },
      update: (patch) => set(patch),
      togglePerfCard: (card) =>
        set((s) => ({ perfCards: { ...s.perfCards, [card]: !s.perfCards[card] } })),
    }),
    { name: "corepilot-settings", version: 1 },
  ),
);
