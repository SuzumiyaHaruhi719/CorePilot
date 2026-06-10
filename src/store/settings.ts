import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";

export type GlowLevel = "soft" | "medium" | "intense";
export type Theme = "dark" | "light";
/** Named palette presets, layered over the dark/light base via `data-theme-style`. */
export type ThemeStyle = "graphite" | "midnight" | "terminal" | "cyberpunk" | "porcelain" | "sandstone";
export type Language = "zh" | "en";

/** Theme-style metadata for the Settings picker. `mode` is the base (dark/light)
 *  the style refines. Swatches are [page, surface, accent] for the card preview. */
export interface ThemeStyleDef {
  id: ThemeStyle;
  name: string; // Chinese label (translated via i18n)
  mode: Theme;
  desc: string;
  swatches: [string, string, string]; // [page bg, surface, accent] for the card preview
}

/** The selectable theme styles, shown as cards in Settings. Co-designed w/ Codex. */
export const THEME_STYLES: ThemeStyleDef[] = [
  { id: "graphite", name: "石墨", mode: "dark", desc: "纯黑中性表面 + 暖橙强调，适合长时间使用。", swatches: ["oklch(9% 0 0)", "oklch(18.5% 0 0)", "oklch(70% 0.175 50)"] },
  { id: "midnight", name: "午夜", mode: "dark", desc: "更深更蓝的午夜界面，冷紫蓝强调色。", swatches: ["oklch(10.5% 0.045 270)", "oklch(20.5% 0.075 270)", "oklch(68% 0.2 274)"] },
  { id: "terminal", name: "终端", mode: "dark", desc: "近黑终端 + 磷光绿，极客风。", swatches: ["oklch(12% 0.004 160)", "oklch(21% 0.006 160)", "oklch(82% 0.2 144)"] },
  { id: "cyberpunk", name: "赛博朋克", mode: "dark", desc: "赛博朋克 2077 黑·黄·蓝，暗夜街头。", swatches: ["#00060e", "#54c1e6", "#fee801"] },
  { id: "porcelain", name: "瓷白", mode: "light", desc: "高对比度浅色，淡蓝强调，简洁清爽。", swatches: ["oklch(98.6% 0.004 285)", "oklch(94% 0.01 287)", "oklch(52% 0.17 235)"] },
  { id: "sandstone", name: "砂岩", mode: "light", desc: "暖色浅色调，明亮环境更舒适。", swatches: ["oklch(97.4% 0.023 83)", "oklch(94.8% 0.032 81)", "oklch(42% 0.155 48)"] },
];
export type PerfCard = "cpu" | "mem" | "gpu" | "disk" | "net" | "power";

interface SettingsState {
  /** UI theme. `dark` is the original Premium Gaming HUD; `light` is the full
   *  light redraw (applied via `data-theme` on <html>). */
  theme: Theme;
  /** Named palette preset layered on top of the theme (via `data-theme-style`). */
  themeStyle: ThemeStyle;
  glow: GlowLevel;
  acrylic: boolean;
  /** Whole-window opacity, 30–100 (%). Applied via the backend on change. */
  windowOpacity: number;
  reduceMotion: boolean;
  /** GPU-accelerated UI rendering. Off → strip backdrop-filter blur, continuous
   *  animations and heavy compositing so the app barely touches the GPU while a
   *  game runs (also a hard escape hatch for any compositor-related stutter). */
  gpuRender: boolean;
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
  /** True once the CCD-cluster notice has shown & auto-dismissed (first run only). */
  ccdNoticeSeen: boolean;
  /** Fan auto-tune: allow tuning while background load is present. The wizard's
   *  quiescence precheck then warns about accuracy instead of refusing to run. */
  tuneAllowBusy: boolean;
  update: (patch: Partial<Omit<SettingsState, "update" | "togglePerfCard">>) => void;
  togglePerfCard: (card: PerfCard) => void;
}

/**
 * All settings auto-persist to localStorage on every change (no save button).
 */
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      themeStyle: "graphite",
      glow: "medium",
      acrylic: true,
      windowOpacity: 100,
      reduceMotion: false,
      gpuRender: true,
      language: "zh",
      pollMs: 1500,
      perfCards: { cpu: true, mem: true, gpu: true, disk: true, net: true, power: true },
      closeToTray: true,
      perfRecording: true,
      bgRecord: false,
      autoShowReport: true,
      gameNotify: true,
      ccdNoticeSeen: false,
      tuneAllowBusy: false,
      update: (patch) => set(patch),
      togglePerfCard: (card) =>
        set((s) => ({ perfCards: { ...s.perfCards, [card]: !s.perfCards[card] } })),
    }),
    { name: "corepilot-settings", version: 1, storage: createJSONStorage(() => tauriStorage) },
  ),
);
