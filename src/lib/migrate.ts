// One-time import of data persisted by the previous frontend (keys
// "corepilot-*"). Non-destructive: the old keys are left in place; only the
// new "cp.*" stores are written, and old perf-session files (samples-only
// arrays indexed from the store) are rewritten into self-contained sessions.
import { api, type FanConfig, type GpuOc, type OsdRow } from "./ipc"
import { SETTINGS_DEFAULTS, useProfiles, useSettings, type Rule, type Settings } from "./store"

type Obj = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
async function old(key: string): Promise<Obj | null> {
  const raw = await api.persistGet(key).catch(() => null)
  if (raw == null) return null
  try { return ((typeof raw === "string" ? JSON.parse(raw) : raw) as Obj)?.state ?? null } catch { return null }
}
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "object" && v && "name" in v ? String((v as Obj).name) : "")

function rowsFrom(metrics: unknown): Record<OsdRow, boolean> | null {
  if (!Array.isArray(metrics)) return null
  const m = metrics.map(String)
  const has = (re: RegExp) => m.some((x) => re.test(x))
  return { fps: has(/^fps$|^fps\.low/), frametime: has(/frametime/), cpu: has(/^cpu\./), gpu: has(/^gpu\.(util|temp|power|coreClock|fan)/), vram: has(/^gpu\.vram/), ram: has(/^mem\./), disk: has(/^disk\./), net: has(/^net\./) }
}

export async function importLegacy() {
  if (useProfiles.getState().imported) return
  const [st, osd, osdT, rec, fan, gpu, groups, hist] = await Promise.all(
    ["corepilot-settings", "corepilot-osd", "corepilot-osd-targets", "corepilot-record-targets", "corepilot-fan-profiles", "corepilot-gpu-profiles", "corepilot-groups", "corepilot-perf-history"].map(old),
  )
  const s: Partial<Settings> = {}
  const cur = useSettings.getState()
  if (st) {
    if (st.language === "en" || st.language === "zh") s.lang = st.language
    if (st.theme === "light" || st.theme === "dark") s.theme = st.theme
    if (["violet", "ember", "mint", "sky"].includes(st.accent)) s.accent = st.accent
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
    const pos = String(osd.position ?? "tl")
    const corner = (pos.startsWith("b") ? 2 : 0) + (pos.endsWith("r") ? 1 : 0)
    s.osd = {
      ...cur.osd,
      mode: osd.enabled === false ? "off" : osd.inject || osd.autoInject ? "inject" : "window",
      corner: corner as 0 | 1 | 2 | 3,
      scale: typeof osd.scale === "number" ? osd.scale : cur.osd.scale,
      rows: rowsFrom(osd.metrics) ?? cur.osd.rows,
      targets: Array.isArray(osdT?.targets) ? osdT.targets.map(str).filter(Boolean).map((x: string) => x.toLowerCase()) : cur.osd.targets,
    }
    const tb = { ...SETTINGS_DEFAULTS.taskbar }
    const map: [keyof typeof tb, string][] = [["enabled", "tbEnabled"], ["singleLine", "tbSingleLine"], ["barPosition", "tbBarPosition"], ["offset", "tbOffset"], ["customLayout", "tbCustomLayout"], ["size", "tbSize"], ["bold", "tbBold"], ["itemSpace", "tbItemSpace"], ["innerSpace", "tbInnerSpace"], ["padding", "tbPadding"], ["colorsEnabled", "tbColorsEnabled"], ["bg", "tbBg"], ["label", "tbLabel"], ["safe", "tbSafe"], ["warn", "tbWarn"], ["crit", "tbCrit"], ["warnLoad", "tbWarnLoad"], ["critLoad", "tbCritLoad"], ["warnTemp", "tbWarnTemp"], ["critTemp", "tbCritTemp"], ["metrics", "tbMetrics"]]
    for (const [k, o] of map) if (osd[o] !== undefined && typeof osd[o] === typeof tb[k]) (tb as Obj)[k] = osd[o]
    s.taskbar = tb
  }
  useSettings.getState().set(s)

  const fans: Record<string, FanConfig> = {}
  for (const [id, c] of Object.entries((fan?.configs ?? {}) as Record<string, Obj>)) {
    if (!c || !Array.isArray(c.curve)) continue
    fans[id] = { controlId: id, mode: ["auto", "manual", "curve"].includes(c.mode) ? c.mode : "auto", manualPct: c.manualPct ?? 50, tempSourceId: c.tempSourceId ?? null, curve: c.curve, minDuty: c.minDuty ?? 0, spinUpPct: c.spinUpPct ?? 100, spinDownPct: c.spinDownPct ?? 100, tempSourceId2: c.tempSourceId2 ?? null, curve2: Array.isArray(c.curve2) ? c.curve2 : [] }
  }
  const active = Array.isArray(gpu?.profiles) ? gpu.profiles.find((p: Obj) => p.id === gpu.activeId) : null
  const rules: Rule[] = []
  for (const g of (groups?.groups ?? []) as Obj[]) {
    const mask = g?.mask?.$bigint ?? (typeof g?.mask === "string" ? g.mask : null)
    for (const exe of (g?.patterns ?? []) as string[]) {
      const e = String(exe).toLowerCase()
      if (e && !rules.some((r) => r.exe === e)) rules.push({ exe: e, mask, priority: typeof g.priority === "number" ? g.priority : null, on: true })
    }
  }
  useProfiles.getState().set({
    fans, rules,
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
