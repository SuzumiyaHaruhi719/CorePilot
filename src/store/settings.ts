import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AccentName = "violet" | "cyan" | "teal" | "amber" | "rose";

/** OKLCH hue per accent — applied at runtime to `--color-accent`. */
export const ACCENT_HUE: Record<AccentName, number> = {
  violet: 274,
  cyan: 220,
  teal: 182,
  amber: 75,
  rose: 12,
};

export type GlowLevel = "soft" | "medium" | "intense";
export type Language = "zh" | "en";

interface SettingsState {
  accent: AccentName;
  glow: GlowLevel;
  acrylic: boolean;
  reduceMotion: boolean;
  language: Language;
  pollMs: number;
  update: (patch: Partial<Omit<SettingsState, "update">>) => void;
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
      update: (patch) => set(patch),
    }),
    { name: "corepilot-settings", version: 1 },
  ),
);
