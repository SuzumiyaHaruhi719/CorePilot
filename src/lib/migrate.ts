// One-time import of data persisted by the previous frontend (keys
// "corepilot-*"). Non-destructive: the old keys are left in place; only the
// new "cp.*" stores are written, and old perf-session files (samples-only
// arrays indexed from the store) are rewritten into self-contained sessions.
// Pass 1 (`imported`): settings, recorder, taskbar, fans, GPU, sessions.
// Pass 2 (`legacy2`): CCD groups, theme style, glow, OSD layout.
// Pass 3 (`legacy3`): saved fan profiles, active fan preset, fan labels, spun headers.
import { api, type FanConfig, type GpuOc } from "./ipc"
import { OSD_POSITIONS, type OsdPosition } from "./osd"
import { SETTINGS_DEFAULTS, useProfiles, useSettings, type FanProfile, type Group, type Settings } from "./store"
import { STYLES, type Glow, type ThemeStyle } from "./themes"

type Obj = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
async function old(key: string): Promise<Obj | null> {
  const raw = await api.persistGet(key).catch(() => null)
  if (raw == null) return null
  try { return ((typeof raw === "string" ? JSON.parse(raw) : raw) as Obj)?.state ?? null } catch { return null }
}
function fansOf(configs: unknown): Record<string, FanConfig> {
  const fans: Record<string, FanConfig> = {}
  for (const [id, c] of Object.entries((configs ?? {}) as Record<string, Obj>)) {
    if (!c || !Array.isArray(c.curve)) continue
    fans[id] = { controlId: id, mode: ["auto", "manual", "curve"].includes(c.mode) ? c.mode : "auto", manualPct: c.manualPct ?? 50, tempSourceId: c.tempSourceId ?? null, curve: c.curve, minDuty: c.minDuty ?? 0, spinUpPct: c.spinUpPct ?? 100, spinDownPct: c.spinDownPct ?? 100, tempSourceId2: c.tempSourceId2 ?? null, curve2: Array.isArray(c.curve2) ? c.curve2 : [] }
  }
  return fans
}
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "object" && v && "name" in v ? String((v as Obj).name) : "")

async function pass1() {
  const [st, osd, osdT, rec, fan, gpu, hist] = await Promise.all(
    ["corepilot-settings", "corepilot-osd", "corepilot-osd-targets", "corepilot-record-targets", "corepilot-fan-profiles", "corepilot-gpu-profiles", "corepilot-perf-history"].map(old),
  )
  const s: Partial<Settings> = {}
  const cur = useSettings.getState()
  if (st) {
    if (st.language === "en" || st.language === "zh") s.lang = st.language
    if (typeof st.reduceMotion === "boolean") s.reduceMotion = st.reduceMotion
    if (typeof st.windowOpacity === "number") s.opacity = st.windowOpacity
    if (typeof st.closeToTray === "boolean") s.closeToTray = st.closeToTray
  }
  const recorder = { ...cur.recorder }
  if (typeof st?.perfRecording === "boolean") recorder.enabled = st.perfRecording
  if (Array.isArray(rec?.targets)) {
    recorder.white = rec.targets.filter((x: Obj) => x?.list === "white").map((x: Obj) => String(x.name).toLowerCase())
    recorder.black = rec.targets.filter((x: Obj) => x?.list === "black").map((x: Obj) => String(x.name).toLowerCase())
  }
  s.recorder = recorder
  if (osd) {
    s.osd = {
      ...cur.osd,
      mode: osd.enabled === false ? "off" : osd.inject || osd.autoInject ? "inject" : "window",
      targets: Array.isArray(osdT?.targets) ? osdT.targets.map(str).filter(Boolean).map((x: string) => x.toLowerCase()) : cur.osd.targets,
    }
    const tb = { ...SETTINGS_DEFAULTS.taskbar }
    const map: [keyof typeof tb, string][] = [["enabled", "tbEnabled"], ["singleLine", "tbSingleLine"], ["barPosition", "tbBarPosition"], ["offset", "tbOffset"], ["customLayout", "tbCustomLayout"], ["size", "tbSize"], ["bold", "tbBold"], ["itemSpace", "tbItemSpace"], ["innerSpace", "tbInnerSpace"], ["padding", "tbPadding"], ["colorsEnabled", "tbColorsEnabled"], ["bg", "tbBg"], ["label", "tbLabel"], ["safe", "tbSafe"], ["warn", "tbWarn"], ["crit", "tbCrit"], ["warnLoad", "tbWarnLoad"], ["critLoad", "tbCritLoad"], ["warnTemp", "tbWarnTemp"], ["critTemp", "tbCritTemp"], ["metrics", "tbMetrics"]]
    for (const [k, o] of map) if (osd[o] !== undefined && typeof osd[o] === typeof tb[k]) (tb as Obj)[k] = osd[o]
    s.taskbar = tb
  }
  useSettings.getState().set(s)

  const fans = fansOf(fan?.configs)
  const active = Array.isArray(gpu?.profiles) ? gpu.profiles.find((p: Obj) => p.id === gpu.activeId) : null
  useProfiles.getState().set({
    fans,
    gpu: active ? { oc: (active.settings ?? {}) as GpuOc, onStartup: !!gpu?.applyOnStartup } : useProfiles.getState().gpu,
  })

  // sessions: old files are bare sample arrays; meta + summary lived in the store
  for (const h of (hist?.sessions ?? []) as Obj[]) {
    if (!h?.id) continue
    const raw = await api.sessionLoad(h.id).catch(() => null)
    let samples: unknown
    try { samples = JSON.parse(raw ?? "null") } catch { continue }
    if (!Array.isArray(samples)) continue // already new-format or missing
    const meta = { exe: h.exe, path: h.path ?? null, startedAt: h.startedAt, endedAt: h.endedAt, durationSec: h.durationSec, cpuName: h.cpuName ?? null, gpuName: h.gpuName ?? null }
    await api.sessionSave(h.id, JSON.stringify({ id: h.id, meta, summary: h.summary ?? {}, samples })).catch(() => {})
  }
  useProfiles.getState().set({ imported: true })
}

async function pass2() {
  const [st, osd, groups, ui] = await Promise.all(["corepilot-settings", "corepilot-osd", "corepilot-groups", "corepilot-ui"].map(old))
  const cur = useSettings.getState()
  const s: Partial<Settings> = {}
  if (st && STYLES.some((x) => x.id === st.themeStyle)) s.style = st.themeStyle as ThemeStyle
  if (st && ["off", "soft", "medium", "intense"].includes(st.glow)) s.glow = st.glow as Glow
  if (osd) {
    const pos = String(osd.position ?? "tl")
    s.osd = {
      ...cur.osd,
      layout: osd.style === "vertical" ? "column" : "row",
      position: OSD_POSITIONS.includes(pos as OsdPosition) ? (pos as OsdPosition) : "tl",
      scale: typeof osd.scale === "number" ? osd.scale : cur.osd.scale,
      bg: typeof osd.opacity === "number" ? osd.opacity : cur.osd.bg,
      rounded: typeof osd.rounded === "boolean" ? osd.rounded : cur.osd.rounded,
      metrics: Array.isArray(osd.metrics) && osd.metrics.length ? osd.metrics.map(String) : cur.osd.metrics,
    }
  }
  useSettings.getState().set(s)

  const gs: Group[] = []
  for (const g of (groups?.groups ?? []) as Obj[]) {
    const mask = g?.mask?.$bigint ?? (typeof g?.mask === "string" ? g.mask : null)
    if (!mask) continue
    gs.push({ id: String(g.id ?? crypto.randomUUID()), name: String(g.name ?? "分组"), hue: typeof g.hue === "number" ? g.hue : 182, mask, priority: typeof g.priority === "number" ? g.priority : null, patterns: ((g.patterns ?? []) as string[]).map((x) => String(x).toLowerCase()) })
  }
  useProfiles.getState().set({
    ...(gs.length ? { groups: gs } : {}),
    ...(typeof ui?.optimizeOnStartup === "boolean" ? { optimizeOnStartup: ui.optimizeOnStartup } : {}),
    legacy2: true,
  })
}

async function pass3() {
  const fan = await old("corepilot-fan-profiles")
  const fanProfiles: FanProfile[] = ((fan?.profiles ?? []) as Obj[])
    .filter((p) => p?.id && p?.configs)
    .map((p) => ({ id: String(p.id), name: String(p.name ?? "配置"), fans: fansOf(p.configs) }))
  const labels: Record<string, string> = {}
  for (const [k, v] of Object.entries((fan?.labels ?? {}) as Obj)) if (typeof v === "string" && v.trim()) labels[k] = v
  useProfiles.getState().set({
    ...(fanProfiles.length ? { fanProfiles } : {}),
    ...(typeof fan?.activeProfileId === "string" ? { fanActive: fan.activeProfileId } : {}),
    ...(Object.keys(labels).length ? { fanLabels: labels } : {}),
    ...(Array.isArray(fan?.spunFans) ? { spun: (fan.spunFans as unknown[]).map(String) } : {}),
    legacy3: true,
  })
}

async function pass4() {
  const [st, ui] = await Promise.all(["corepilot-settings", "corepilot-ui"].map(old))
  const s: Partial<Settings> = {}
  if (st) {
    if (typeof st.pollMs === "number") s.pollMs = Math.min(5000, Math.max(250, st.pollMs))
    if (typeof st.gpuRender === "boolean") s.gpuMode = st.gpuRender ? "full" : "low"
    if (typeof st.acrylic === "boolean") s.glass = st.acrylic
    for (const k of ["bgRecord", "autoShowReport", "gameNotify", "tuneAllowBusy", "autoCheckUpdates"] as const) if (typeof st[k] === "boolean") s[k] = st[k]
    if (st.perfCards && typeof st.perfCards === "object") {
      const d = { ...SETTINGS_DEFAULTS.perfDevices }
      for (const k of Object.keys(d) as (keyof typeof d)[]) if (typeof st.perfCards[k] === "boolean") d[k] = st.perfCards[k]
      s.perfDevices = d
    }
  }
  if (typeof ui?.amdTuningUnlocked === "boolean") s.amdTuning = ui.amdTuningUnlocked
  useSettings.getState().set(s)
  useProfiles.getState().set({ legacy4: true })
}

export async function importLegacy() {
  if (!useProfiles.getState().imported) await pass1()
  if (!useProfiles.getState().legacy2) await pass2()
  if (!useProfiles.getState().legacy3) await pass3()
  if (!useProfiles.getState().legacy4) await pass4()
  // the taskbar plate was redrawn (regular device grid, tray-docked): start every
  // existing setup from the new defaults once, keeping only on/off
  const s = useSettings.getState()
  if (!s.tbV3) s.set({ taskbar: { ...SETTINGS_DEFAULTS.taskbar, enabled: s.taskbar.enabled }, tbV3: true })
}
