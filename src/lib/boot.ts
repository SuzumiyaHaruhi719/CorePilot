// Main-window background services: visibility gate, the one telemetry poller,
// one-way config pushes into Rust statics (rule 6), the affinity enforcer and
// event listeners. Started once after the persisted stores hydrate.
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { api, logUi, on, PRIORITY, type FanConfig, type TunedCurve } from "./ipc"
import { overlayFlags } from "./osd"
import { go, HIST, motionReduced, sysReduce, tf, toast, useLive, useProfiles, useSettings, type Group, type Mood, type Series } from "./store"
import { GLOW_LEVEL, overlayPalette, PALETTE } from "./themes"
import { maskOf } from "./util"

const push = (arr: number[], v: number) => {
  const a = arr.length >= HIST ? arr.slice(1) : arr.slice()
  a.push(v)
  return a
}

/** Machine mood with hysteresis (enter at the high mark, leave below the low one),
 *  so the ambient tint doesn't flicker when load hovers around a threshold. */
export function moodOf(was: Mood, cpu: number, gpu: number | null, cpuT: number | null, gpuT: number | null, game: boolean): Mood {
  const hot = was === "hot" ? (cpuT ?? 0) >= 80 || (gpuT ?? 0) >= 78 : (cpuT ?? 0) >= 86 || (gpuT ?? 0) >= 83
  if (hot) return "hot"
  if (game) return "game"
  const busy = was === "busy" ? cpu >= 42 || (gpu ?? 0) >= 50 : cpu >= 60 || (gpu ?? 0) >= 70
  return busy ? "busy" : "calm"
}

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

/** Windows notification, permission-guarded and best-effort. */
async function notify(body: string) {
  try {
    const ok = (await isPermissionGranted()) || (await requestPermission()) === "granted"
    if (ok) sendNotification({ title: "CorePilot", body })
  } catch (e) { logUi("warn", `notification failed: ${String(e)}`) }
}
/** Bring the window to the front (a background process can't just SetForegroundWindow:
 *  pin on top for a moment, then unpin — same trick as tray.rs). */
async function surface() {
  try {
    const w = getCurrentWindow()
    await w.show(); await w.unminimize(); await w.setAlwaysOnTop(true); await w.setFocus(); await w.setAlwaysOnTop(false)
  } catch (e) { logUi("warn", `raising the window failed: ${String(e)}`) }
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

  // ---------------- update check (设置 → 自动检查更新)
  if (useSettings.getState().autoCheckUpdates) setTimeout(() => {
    api.updateCheck().then((u) => { if (u.available) toast("info", tf(`发现新版本 ${u.latestVersion}`, `Version ${u.latestVersion} available`), tf("在 设置 → 更新 中安装", "Install it in Settings → Updates")) }).catch(() => {})
  }, 20_000)

  // ---------------- static facts
  api.topology().then((topo) => live({ topo })).catch(() => {})
  api.overview().then((overview) => live({ overview })).catch(() => {})

  // ---------------- telemetry: one poller feeds every view
  let busy = false
  const sample = async () => {
    // 后台记录 keeps the history filling while the window is hidden
    if (busy || (!useLive.getState().visible && !useSettings.getState().bgRecord)) return
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
        clk: push(h.clk, s.cpuClock ?? 0),
        vram: push(h.vram, s.vramUsed != null && s.vramTotal ? (s.vramUsed / s.vramTotal) * 100 : 0),
        dsk: push(h.dsk, s.diskPct ?? 0),
        fps: push(h.fps, useLive.getState().fg?.isGame ? useLive.getState().fps?.fps ?? 0 : 0),
      }
      const { coreHist: ch, mood: was, fg } = useLive.getState()
      const mood = moodOf(was, m.cpuOverall, s.gpuPct, s.cpuTemp, s.gpuTemp, !!fg?.isGame)
      if (mood !== was) document.documentElement.dataset.mood = mood
      live((st) => ({ metrics: m, sensors: s, hist: next, coreHist: m.perCore.map((v, i) => push(ch[i] ?? [], v)), mood, tick: st.tick + 1 }))
    } catch { /* keep last frame */ } finally { busy = false }
  }
  // 刷新间隔: re-read every round so a change applies on the next sample
  const loop = () => { void sample(); setTimeout(loop, Math.max(250, useSettings.getState().pollMs)) }
  loop()

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
    el.dataset.style = s.style
    el.dataset.glow = s.glow
    el.style.setProperty("--glow-o", String(GLOW_LEVEL[s.glow]))
    // GPU 渲染: "low" drops glow, blur and motion; "auto" does that while a game is in front
    const low = s.gpuMode === "low" || (s.gpuMode === "auto" && !!useLive.getState().fg?.isGame)
    if (useLive.getState().lowGpu !== low) useLive.setState({ lowGpu: low })
    el.dataset.gpu = low ? "low" : "full"
    el.dataset.glass = s.glass ? "on" : "off"
    el.dataset.motion = motionReduced(s) ? "reduced" : "full"
    el.lang = s.lang === "en" ? "en" : "zh-CN"
  }
  applySettings()
  sysReduce?.addEventListener("change", applySettings)
  useLive.subscribe((st, prev) => { if (st.fg?.isGame !== prev.fg?.isGame && useSettings.getState().gpuMode === "auto") applySettings() })
  let last = ""
  let lastAuto = ""
  const pushSettings = () => {
    const s = useSettings.getState()
    applySettings()
    const auto = JSON.stringify(s.automation)
    if (auto !== lastAuto) { lastAuto = auto; api.automationConfig(s.automation).catch(() => {}) }
    const key = JSON.stringify([s.recorder, s.osd, s.taskbar, s.closeToTray, s.opacity, s.style])
    if (key === last) return
    last = key
    const pal = PALETTE[s.style]
    const tb = s.taskbar
    api.recorderConfig(s.recorder.enabled, s.recorder.white, s.recorder.black, s.osd.targets).catch(() => {})
    // empty per-metric colors follow the theme style's palette
    api.tbmonConfig({ ...tb, themeFps: tb.themeFps || pal.fps, themeCpu: tb.themeCpu || pal.cpu, themeGpu: tb.themeGpu || pal.gpu, themeMem: tb.themeMem || pal.mem, themeDisk: tb.themeDisk || pal.disk, themeNet: tb.themeNet || pal.net }).catch(() => {})
    api.overlayConfig(s.osd.mode === "inject", s.osd.injectAllow, overlayFlags(s.osd.metrics)).catch(() => {})
    api.overlayPalette(overlayPalette(s.style)).catch(() => {})
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

  // ---------------- core groups: master switch defaults to "optimize on startup"
  live({ coreOpt: useProfiles.getState().optimizeOnStartup })
  const applied = new Map<number, string>() // pid → group signature already applied
  setInterval(() => { if (useLive.getState().coreOpt) enforceGroups(applied) }, 5000)
  let wasOn = useLive.getState().coreOpt
  useLive.subscribe((st) => {
    if (st.coreOpt === wasOn) return
    wasOn = st.coreOpt
    if (st.coreOpt) enforceGroups(applied)
    else { applied.clear(); restoreGroups() }
  })

  // ---------------- 定时任务: failures and leak alerts surface; everything else stays in the history
  on("auto://run", (r) => {
    if (!r.ok) toast("err", tf("定时任务失败", "Scheduled task failed"), r.detail)
    else if (r.task === "leak_alert") { toast("warn", tf("疑似内存泄漏", "Possible memory leak"), r.detail); notify(r.detail) }
  })

  // ---------------- perf sessions: backend records, we persist + announce
  on("perf://session", async (payload) => {
    const id = crypto.randomUUID()
    try {
      await api.sessionSave(id, JSON.stringify({ id, ...payload }))
      live({ openSession: id })
      const line = `${payload.meta.exe} · ${payload.summary.avgFps?.toFixed(0) ?? "—"} FPS`
      toast("ok", tf("游戏性能报告已生成", "Game performance report ready"), line)
      const s = useSettings.getState()
      if (s.gameNotify) notify(tf(`${payload.meta.exe} 性能报告已生成`, `${payload.meta.exe} performance report ready`))
      if (s.autoShowReport) { go("games"); surface() }
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

/** Processes owned by a group (first group claiming the exe name wins). */
function owner(groups: Group[], name: string) {
  const n = name.toLowerCase()
  return groups.find((g) => g.patterns.includes(n))
}

/** Apply each group's mask/priority to its running members (runs even when hidden). */
export async function enforceGroups(applied: Map<number, string> = new Map()) {
  const groups = useProfiles.getState().groups.filter((g) => g.patterns.length)
  if (!groups.length) return 0
  const procs = await api.processes().catch(() => null)
  if (!procs) return 0 // stale roster → skip the round, never act on a dead PID
  const alive = new Set<number>()
  let n = 0
  for (const p of procs) {
    alive.add(p.pid)
    const g = owner(groups, p.name)
    if (!g || !p.settable) continue
    const sig = `${g.mask}|${g.priority}`
    if (g.mask !== "0" && p.affinity !== g.mask) { await api.setAffinity(p.pid, BigInt(g.mask)).catch(() => {}); n++ }
    if (g.priority != null && applied.get(p.pid) !== sig) await api.setPriority(p.pid, g.priority).catch(() => {})
    applied.set(p.pid, sig)
  }
  for (const pid of applied.keys()) if (!alive.has(pid)) applied.delete(pid)
  return n
}

/** Master switch off: give group members back every core and normal priority. */
export async function restoreGroups(only?: Group[]) {
  const topo = useLive.getState().topo
  if (!topo) return 0
  const all = maskOf(topo.logical.map((l) => l.id)).toString()
  const groups = only ?? useProfiles.getState().groups
  const procs = await api.processes().catch(() => null)
  if (!procs) return 0
  let failed = 0
  for (const p of procs) {
    const g = owner(groups, p.name)
    if (!g || !p.settable) continue
    if (p.affinity !== all) await api.setAffinity(p.pid, BigInt(all)).catch(() => { failed++ })
    if (g.priority != null) await api.setPriority(p.pid, PRIORITY.normal).catch(() => {})
  }
  return failed
}
