// App state. Two persisted stores (settings, profiles) go through the backend's
// crash-safe persist.rs via persist_get/persist_set; `useLive` is volatile.
// Rule: never bump a `version` here without adding a `migrate`.
import { create } from "zustand"
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware"
import { api, type FanCalibration, type FanConfig, type Foreground, type FpsStats, type GpuOc, type Metrics, type OsdRow, type Overview, type Sensors, type TbConfig, type Topology, type TuneResult } from "./ipc"

// ------------------------------------------------------------ storage adapter
// A key whose READ failed (persist_get rejected: store unreadable) is never
// written this session — hydrating defaults and saving them would overwrite
// real data. null still means "absent".
const unreadable = new Set<string>()
// Coalesce to the latest value per key (250 ms trailing — slider drags), then
// chain writes per key: persist_set crosses a non-FIFO mutex backend-side, so
// two in-flight sets of one key could land out of order.
const pending = new Map<string, { value: string; timer: ReturnType<typeof setTimeout> }>()
const tails = new Map<string, Promise<unknown>>()
function flush(name: string) {
  const p = pending.get(name)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(name)
  const next = (tails.get(name) ?? Promise.resolve()).then(() => api.persistSet(name, p.value)).catch(console.error)
  tails.set(name, next)
}
addEventListener("pagehide", () => [...pending.keys()].forEach(flush))
export const backend: StateStorage = {
  getItem: async (name) => {
    let v: unknown
    try {
      v = await api.persistGet(name)
    } catch (e) {
      unreadable.add(name)
      toast("err", tf("设置存储读取失败，本次修改不会保存", "Settings store unreadable — changes won't be saved this session"), String(e))
      return null // in-memory defaults only; never persisted (see setItem)
    }
    return v == null ? null : typeof v === "string" ? v : JSON.stringify(v)
  },
  setItem: (name, value) => {
    if (unreadable.has(name)) return
    clearTimeout(pending.get(name)?.timer)
    pending.set(name, { value, timer: setTimeout(() => flush(name), 250) })
  },
  removeItem: () => {},
}
const storage = createJSONStorage(() => backend)

// ------------------------------------------------------------ settings
export type Lang = "zh" | "en"
export type Accent = "violet" | "ember" | "mint" | "sky"
export type OsdMode = "off" | "window" | "inject"
export interface Settings {
  lang: Lang
  theme: "dark" | "light"
  accent: Accent
  reduceMotion: boolean
  opacity: number
  closeToTray: boolean
  osd: { mode: OsdMode; corner: 0 | 1 | 2 | 3; rows: Record<OsdRow, boolean>; scale: number; autoGames: boolean; targets: string[]; hotkey: string; injectAllow: string[] }
  recorder: { enabled: boolean; white: string[]; black: string[] }
  taskbar: TbConfig
}
export const DATA_COLORS = { fps: "#f4f1ea", cpu: "#ff8a3d", gpu: "#3ddc97", mem: "#6cb6ff", disk: "#f2c94c", net: "#e07bff" }
export const TB_METRICS = ["cpu.util", "cpu.temp", "cpu.freq", "cpu.power", "mem.used", "mem.util", "gpu.util", "gpu.temp", "gpu.power", "gpu.fan", "gpu.vramPct", "gpu.vramUsed", "gpu.coreClock", "gpu.memClock", "disk.util", "disk.read", "disk.write", "net.up", "net.down"] as const

const defaults: Settings = {
  lang: "zh",
  theme: "dark",
  accent: "violet",
  reduceMotion: false,
  opacity: 100,
  closeToTray: true,
  osd: {
    mode: "window", corner: 0, scale: 1, autoGames: true, targets: [], hotkey: "Alt+Shift+O", injectAllow: [],
    rows: { fps: true, frametime: true, cpu: true, gpu: true, vram: true, ram: true, disk: false, net: false },
  },
  recorder: { enabled: true, white: [], black: [] },
  taskbar: {
    enabled: false, singleLine: false, barPosition: "left", offset: 0, customLayout: true, size: 9, bold: true,
    itemSpace: 6, innerSpace: 8, padding: 2, colorsEnabled: true, bg: "#0b0f16", label: "#8e8c88",
    safe: "#3ddc97", warn: "#f2c94c", crit: "#ff5468",
    themeFps: DATA_COLORS.fps, themeCpu: DATA_COLORS.cpu, themeGpu: DATA_COLORS.gpu, themeMem: DATA_COLORS.mem, themeDisk: DATA_COLORS.disk, themeNet: DATA_COLORS.net,
    warnLoad: 60, critLoad: 85, warnTemp: 70, critTemp: 85,
    metrics: ["cpu.util", "cpu.temp", "mem.used", "gpu.util", "gpu.temp", "net.down"],
  },
}

type Patch<T> = Partial<T> | ((s: T) => Partial<T>)
interface SettingsStore extends Settings { set: (p: Patch<Settings>) => void }
export const SETTINGS_KEY = "cp.settings"
export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({ ...defaults, set: (p) => set(p as never) }),
    {
      name: SETTINGS_KEY, version: 1, storage,
      partialize: ({ set: _s, ...rest }) => rest,
      // deep-merge one level so new nested keys get defaults on old data
      merge: (p, cur) => {
        const s = (p ?? {}) as Partial<Settings>
        return { ...cur, ...s, osd: { ...cur.osd, ...s.osd, rows: { ...cur.osd.rows, ...s.osd?.rows } }, recorder: { ...cur.recorder, ...s.recorder }, taskbar: { ...cur.taskbar, ...s.taskbar } }
      },
    },
  ),
)
export const SETTINGS_DEFAULTS = defaults

// ------------------------------------------------------------ profiles
export interface Rule { exe: string; mask: string | null; priority: number | null; on: boolean }
export interface Profiles {
  rules: Rule[]
  fans: Record<string, FanConfig>
  calibrations: FanCalibration[]
  tune: TuneResult | null
  passive: boolean
  gpu: { oc: GpuOc; onStartup: boolean }
  tweaks: Record<string, string>
  /** legacy "corepilot-*" data imported (lib/migrate.ts) */
  imported: boolean
}
interface ProfilesStore extends Profiles { set: (p: Patch<Profiles>) => void }
export const useProfiles = create<ProfilesStore>()(
  persist(
    (set) => ({ rules: [], fans: {}, calibrations: [], tune: null, passive: false, gpu: { oc: {}, onStartup: false }, tweaks: {}, imported: false, set: (p) => set(p as never) }),
    { name: "cp.profiles", version: 1, storage, partialize: ({ set: _s, ...rest }) => rest },
  ),
)

export const hydrated = () =>
  Promise.all(
    [useSettings, useProfiles].map(
      (s) => new Promise<void>((r) => (s.persist.hasHydrated() ? r() : s.persist.onFinishHydration(() => r()))),
    ),
  )

// ------------------------------------------------------------ live (volatile)
export type PageId = "overview" | "processes" | "cores" | "games" | "thermals" | "tuning" | "system" | "disk" | "settings"
export const HIST = 120
export type Series = "cpu" | "gpu" | "mem" | "cpuT" | "gpuT" | "up" | "down" | "rd" | "wr" | "cpuW" | "gpuW"
export interface Toast { id: number; kind: "ok" | "warn" | "err" | "info"; title: string; body?: string }
interface Live {
  page: PageId
  visible: boolean
  topo: Topology | null
  overview: Overview | null
  metrics: Metrics | null
  sensors: Sensors | null
  hist: Record<Series, number[]>
  tick: number
  openSession: string | null
  fg: Foreground | null
  fps: FpsStats | null
  procCount: number
  palette: boolean
  toasts: Toast[]
}
const empty = () => Object.fromEntries((["cpu", "gpu", "mem", "cpuT", "gpuT", "up", "down", "rd", "wr", "cpuW", "gpuW"] as Series[]).map((k) => [k, []])) as unknown as Record<Series, number[]>
export const useLive = create<Live>()(() => ({
  page: "overview", visible: true, topo: null, overview: null, metrics: null, sensors: null,
  hist: empty(), tick: 0, openSession: null, fg: null, fps: null, procCount: 0, palette: false, toasts: [],
}))
export const go = (page: PageId) => useLive.setState({ page })

let toastId = 0
export function toast(kind: Toast["kind"], title: string, body?: string) {
  const id = ++toastId
  useLive.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, title, body }] }))
  setTimeout(() => useLive.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "err" ? 7000 : 4200)
}

// ------------------------------------------------------------ i18n
// Chinese-first: every user-visible string is t(zh, en).
export const tf = (zh: string, en: string) => (useSettings.getState().lang === "en" ? en : zh)
export function useT() {
  const lang = useSettings((s) => s.lang)
  return (zh: string, en: string) => (lang === "en" ? en : zh)
}
/** Run an IPC action with toast feedback. Returns the result or undefined. */
export async function act<T>(p: Promise<T>, ok?: string | ((v: T) => string)): Promise<T | undefined> {
  try {
    const v = await p
    if (ok) toast("ok", typeof ok === "function" ? ok(v) : ok)
    return v
  } catch (e) {
    toast("err", tf("操作失败", "Action failed"), String(e))
    return undefined
  }
}
