import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";

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
  /** Whole-window opacity, 30–100 (%). Applied via the backend on change. */
  windowOpacity: number;
  reduceMotion: boolean;
  language: Language;
  pollMs: number;
  perfCards: Record<PerfCard, boolean>;
  /** Hide to the system tray on window close instead of quitting the app. */
  closeToTray: boolean;
  /** Auto-record a performance session per detected game (Monitor → 历史). */
  perfRecording: boolean;
  /** Keep CPU/GPU/mem/disk/net charts recording in the BACKGROUND (even when Task
   *  Manager is closed) so they open already full instead of flat. */
  bgRecord: boolean;
  /** When a game exits, bring CorePilot to the front and open its report. */
  autoShowReport: boolean;
  /** Send a Windows notification when a game is detected / its report is saved. */
  gameNotify: boolean;
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
      glow: "medium",
      acrylic: true,
      windowOpacity: 100,
      reduceMotion: false,
      language: "zh",
      pollMs: 1500,
      perfCards: { cpu: true, mem: true, gpu: true, disk: true, net: true, power: true },
      closeToTray: true,
      perfRecording: true,
      bgRecord: false,
      autoShowReport: true,
      gameNotify: true,
      update: (patch) => set(patch),
      togglePerfCard: (card) =>
        set((s) => ({ perfCards: { ...s.perfCards, [card]: !s.perfCards[card] } })),
    }),
    { name: "corepilot-settings", version: 1, storage: createJSONStorage(() => tauriStorage) },
  ),
);
