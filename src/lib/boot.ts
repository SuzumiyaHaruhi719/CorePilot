// Main-window background services: visibility gate, the one telemetry poller,
// one-way config pushes into Rust statics (rule 6), the affinity enforcer and
// event listeners. Started once after the persisted stores hydrate.
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut"
import { api, on, osdFlags, type FanConfig, type TunedCurve } from "./ipc"
import { DATA_COLORS, go, HIST, tf, toast, useLive, useProfiles, useSettings, type Series } from "./store"
import { rgba32 } from "./util"

const push = (arr: number[], v: number) => {
  const a = arr.length >= HIST ? arr.slice(1) : arr.slice()
  a.push(v)
  return a
}

export const OSD_PALETTE = [DATA_COLORS.fps, DATA_COLORS.fps, DATA_COLORS.cpu, DATA_COLORS.gpu, DATA_COLORS.gpu, DATA_COLORS.mem, DATA_COLORS.disk, DATA_COLORS.net]

/** Fold tuned curves into the per-fan configs (autotune result / passive learning). */
export function applyTunedCurves(curves: TunedCurve[], cpuSrc: string | null, gpuSrc: string | null) {
  const fans = { ...useProfiles.getState().fans }
  for (const c of curves) {
    const prev = fans[c.controlId]
    fans[c.controlId] = {
      controlId: c.controlId, mode: "curve", manualPct: prev?.manualPct ?? 50,
      tempSourceId: cpuSrc ?? prev?.tempSourceId ?? null, curve: c.curve,
      tempSourceId2: c.curve2.length ? gpuSrc : null, curve2: c.curve2,
      minDuty: c.minDuty, spinUpPct: c.spinUpPct, spinDownPct: c.spinDownPct,
    } satisfies FanConfig
  }
  useProfiles.getState().set({ fans })
}

function passiveConfig() {
  const p = useProfiles.getState()
  const r = p.tune
  if (!p.passive || !r) return null
  return { enabled: true, params: r.params, model: r.model, modelGpu: r.modelGpu, calibrations: r.calibrations, pDesign: r.pDesign, pDesignGpu: r.pDesignGpu }
}

let started = false
export function startServices() {
  if (started) return
  started = true
  const live = useLive.setState

  // ---------------- visibility gate (rule: never re-sample while unseen)
  let occluded = false
  const recompute = () => live({ visible: document.visibilityState === "visible" && !occluded })
  document.addEventListener("visibilitychange", recompute)
  on("app://focus", (f) => { if (f) { occluded = false; recompute() } })
  setInterval(async () => { occluded = await api.occluded().catch(() => false); recompute() }, 1500)

  // ---------------- static facts
  api.topology().then((topo) => live({ topo })).catch(() => {})
  api.overview().then((overview) => live({ overview })).catch(() => {})

  // ---------------- telemetry: one poller feeds every view
  let busy = false
  setInterval(async () => {
    if (busy || !useLive.getState().visible) return
    busy = true
    try {
      const [m, s] = await Promise.all([api.metrics(), api.sensors()])
      const h = useLive.getState().hist
      const next: Record<Series, number[]> = {
        cpu: push(h.cpu, m.cpuOverall),
        mem: push(h.mem, m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0),
        gpu: push(h.gpu, s.gpuPct ?? 0),
        cpuT: push(h.cpuT, s.cpuTemp ?? 0),
        gpuT: push(h.gpuT, s.gpuTemp ?? 0),
        up: push(h.up, s.netUp ?? 0),
        down: push(h.down, s.netDown ?? 0),
        rd: push(h.rd, s.diskRead ?? 0),
        wr: push(h.wr, s.diskWrite ?? 0),
        cpuW: push(h.cpuW, s.cpuPower ?? 0),
        gpuW: push(h.gpuW, s.gpuPower ?? 0),
      }
      live((st) => ({ metrics: m, sensors: s, hist: next, tick: st.tick + 1 }))
    } catch { /* keep last frame */ } finally { busy = false }
  }, 1000)

  let fgBusy = false
  setInterval(async () => {
    if (fgBusy || !useLive.getState().visible) return
    fgBusy = true
    try {
      const fg = await api.foreground()
      const fps = fg.isGame ? await api.fps() : null
      const prev = useLive.getState()
      if (prev.fg?.pid !== fg.pid || prev.fg?.isGame !== fg.isGame || fps || prev.fps) live({ fg, fps })
    } catch { /* ignore */ } finally { fgBusy = false }
  }, 1000)

  // ---------------- settings → document + Rust statics
  const applySettings = () => {
    const s = useSettings.getState()
    const el = document.documentElement
    el.dataset.theme = s.theme
    el.dataset.accent = s.accent
    el.dataset.motion = s.reduceMotion ? "reduced" : "full"
    el.lang = s.lang === "en" ? "en" : "zh-CN"
  }
  applySettings()
  let last = ""
  const pushSettings = () => {
    const s = useSettings.getState()
    applySettings()
    const key = JSON.stringify([s.recorder, s.osd, s.taskbar, s.closeToTray, s.opacity])
    if (key === last) return
    last = key
    api.recorderConfig(s.recorder.enabled, s.recorder.white, s.recorder.black, s.osd.targets).catch(() => {})
    api.tbmonConfig(s.taskbar).catch(() => {})
    api.overlayConfig(s.osd.mode === "inject", s.osd.injectAllow, osdFlags(s.osd.rows)).catch(() => {})
    api.overlayPalette(OSD_PALETTE.map(rgba32)).catch(() => {})
    api.closeToTray(s.closeToTray).catch(() => {})
    api.opacity(s.opacity).catch(() => {})
  }
  pushSettings()
  useSettings.subscribe(pushSettings)

  // ---------------- profiles → fan engine / passive learner
  let lastFans = ""
  let lastPassive = ""
  const pushProfiles = () => {
    const p = useProfiles.getState()
    const fans = JSON.stringify(p.fans)
    if (fans !== lastFans) { lastFans = fans; api.fanSetConfig(Object.values(p.fans)).catch((e) => toast("err", tf("风扇配置下发失败", "Fan config push failed"), String(e))) }
    const pc = passiveConfig()
    const pk = pc ? `${p.tune?.finishedAtMs}` : ""
    if (pk !== lastPassive) { lastPassive = pk; api.passiveConfigure(pc).catch(() => {}) }
  }
  pushProfiles()
  useProfiles.subscribe(pushProfiles)

  on("fan-autotune-passive", (adj) => {
    const r = useProfiles.getState().tune
    applyTunedCurves(adj.curves, r?.cpuSourceId ?? null, r?.gpuSourceId ?? null)
    toast("info", tf("风扇曲线已自适应微调", "Fan curves self-adjusted"), `${adj.axis.toUpperCase()} ${adj.deltaC > 0 ? "+" : ""}${adj.deltaC.toFixed(1)} °C`)
  })

  // ---------------- GPU OC startup apply, behind the crash guard
  const { gpu } = useProfiles.getState()
  if (gpu.onStartup && Object.values(gpu.oc).some((v) => v != null)) {
    api.gpuGuard().then((g) => {
      if (g.blocked) toast("warn", tf("已跳过开机 GPU 超频", "Skipped startup GPU OC"), tf("检测到上次异常关机或显示驱动故障", "Previous unclean shutdown or display-driver fault detected") + (g.detail ? ` · ${g.detail}` : ""))
      else api.gpuApply(gpu.oc).catch((e) => toast("err", tf("GPU 超频应用失败", "GPU OC apply failed"), String(e)))
    }).catch(() => {})
  }

  // ---------------- affinity / priority enforcer (runs even when hidden)
  const applied = new Map<number, string>() // pid → rule signature already applied
  setInterval(async () => {
    const rules = useProfiles.getState().rules.filter((r) => r.on)
    if (!rules.length) return
    const procs = await api.processes().catch(() => null)
    if (!procs) return // stale roster → skip the round, never act on a dead PID
    const alive = new Set<number>()
    for (const p of procs) {
      alive.add(p.pid)
      const r = rules.find((r) => r.exe === p.name.toLowerCase())
      if (!r || !p.settable) continue
      const sig = `${r.mask}|${r.priority}`
      if (r.mask && p.affinity !== r.mask) await api.setAffinity(p.pid, BigInt(r.mask)).catch(() => {})
      if (r.priority != null && applied.get(p.pid) !== sig) await api.setPriority(p.pid, r.priority).catch(() => {})
      applied.set(p.pid, sig)
    }
    for (const pid of applied.keys()) if (!alive.has(pid)) applied.delete(pid)
  }, 5000)

  // ---------------- perf sessions: backend records, we persist + announce
  on("perf://session", async (payload) => {
    const id = crypto.randomUUID()
    try {
      await api.sessionSave(id, JSON.stringify({ id, ...payload }))
      live({ openSession: id })
      toast("ok", tf("游戏性能报告已生成", "Game performance report ready"), `${payload.meta.exe} · ${payload.summary.avgFps?.toFixed(0) ?? "—"} FPS`)
    } catch (e) {
      toast("err", tf("报告保存失败", "Report save failed"), String(e))
    }
  })

  // ---------------- OSD hotkey
  let hk = ""
  let lastMode: "window" | "inject" = "window"
  const bindHotkey = async () => {
    const s = useSettings.getState().osd
    if (s.mode !== "off") lastMode = s.mode
    if (s.hotkey === hk) return
    hk = s.hotkey
    await unregisterAll().catch(() => {})
    if (!hk) return
    register(hk, (e) => {
      if (e.state !== "Pressed") return
      const cur = useSettings.getState()
      cur.set({ osd: { ...cur.osd, mode: cur.osd.mode === "off" ? lastMode : "off" } })
    }).catch(() => toast("warn", tf("OSD 热键注册失败", "OSD hotkey registration failed"), hk))
  }
  bindHotkey()
  useSettings.subscribe(bindHotkey)

  // ---------------- automation hook (COREPILOT_STARTUP=disk)
  api.startupDirective().then((d) => { if (d === "disk") go("disk") }).catch(() => {})
}
