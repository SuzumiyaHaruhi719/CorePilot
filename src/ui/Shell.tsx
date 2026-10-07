import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { AnimatePresence, MotionConfig, motion } from "motion/react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  Activity, AlertTriangle, ArrowRight, CheckCircle2, Cpu, Fan, Gamepad2, Gauge, HardDrive, Info, LayoutDashboard, ListTree,
  Maximize2, Minus, Search, Settings2, SlidersHorizontal, Sparkles, X, XCircle, Zap,
} from "lucide-react"
import { api } from "../lib/ipc"
import { act, go, tf, useLive, useProfiles, useSettings, useT, type PageId } from "../lib/store"
import { bytes, fixed, isNum, rate } from "../lib/util"
import { ConfirmHost } from "./kit"

export function Mark({ size = 18, animate = false }: { size?: number; animate?: boolean }) {
  const pins = [5, 9, 13]
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="3.5" y="3.5" width="11" height="11" rx="2.2" stroke="var(--acc)" strokeWidth="1.4" />
      <motion.rect x="6.5" y="6.5" width="5" height="5" rx="1" fill="var(--acc)" initial={animate ? { scale: 0, opacity: 0 } : false} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.35, duration: 0.4, ease: [0.16, 1, 0.3, 1] }} style={{ transformOrigin: "9px 9px" }} />
      {pins.flatMap((p, i) => [
        [p, 0.6, p, 2.6], [p, 15.4, p, 17.4], [0.6, p, 2.6, p], [15.4, p, 17.4, p],
      ].map(([x1, y1, x2, y2], j) => (
        <motion.line key={`${i}${j}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ink-3)" strokeWidth="1.2" strokeLinecap="round"
          initial={animate ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ delay: 0.04 * (i * 4 + j), duration: 0.25 }} />
      )))}
    </svg>
  )
}

// ------------------------------------------------------------ navigation
interface NavItem { id: PageId; zh: string; en: string; icon: typeof Cpu; group: number }
export const NAV: NavItem[] = [
  { id: "overview", zh: "总览", en: "Overview", icon: LayoutDashboard, group: 0 },
  { id: "processes", zh: "进程", en: "Processes", icon: ListTree, group: 0 },
  { id: "cores", zh: "核心调度", en: "Cores", icon: Cpu, group: 0 },
  { id: "games", zh: "游戏", en: "Games", icon: Gamepad2, group: 1 },
  { id: "thermals", zh: "散热", en: "Thermals", icon: Fan, group: 2 },
  { id: "tuning", zh: "超频调校", en: "Tuning", icon: Gauge, group: 2 },
  { id: "system", zh: "系统维护", en: "System", icon: SlidersHorizontal, group: 3 },
  { id: "disk", zh: "磁盘分析", en: "Disk", icon: HardDrive, group: 3 },
  { id: "settings", zh: "设置", en: "Settings", icon: Settings2, group: 4 },
]
const GROUPS: [string, string][] = [["监控", "Monitor"], ["游戏", "Play"], ["硬件", "Hardware"], ["维护", "Maintain"], ["", ""]]

function useNavValue(id: PageId): string {
  const m = useLive((s) => s.metrics)
  const sn = useLive((s) => s.sensors)
  const fps = useLive((s) => s.fps?.fps)
  const procs = useLive((s) => s.procCount)
  const rules = useProfiles((s) => s.rules.filter((r) => r.on).length)
  switch (id) {
    case "overview": return m ? `${m.cpuOverall.toFixed(0)}%` : ""
    case "processes": return procs ? String(procs) : ""
    case "cores": return rules ? `${rules}×` : ""
    case "games": return isNum(fps) ? `${fps.toFixed(0)}` : ""
    case "thermals": return isNum(sn?.cpuTemp) ? `${sn!.cpuTemp!.toFixed(0)}°` : ""
    case "tuning": return isNum(sn?.gpuPower) ? `${sn!.gpuPower!.toFixed(0)}W` : ""
    case "system": return m?.memTotal ? `${((m.memUsed / m.memTotal) * 100).toFixed(0)}%` : ""
    case "disk": return isNum(sn?.diskPct) ? `${sn!.diskPct!.toFixed(0)}%` : ""
    default: return ""
  }
}

function NavButton({ item, n }: { item: NavItem; n: number }) {
  const page = useLive((s) => s.page)
  const lang = useSettings((s) => s.lang)
  const v = useNavValue(item.id)
  const on = page === item.id
  return (
    <button className={`nav ${on ? "on" : ""}`} onClick={() => go(item.id)} aria-current={on ? "page" : undefined}>
      <span className="nav-bg" />
      {on && <motion.span className="nav-ind" layoutId="nav-ind" transition={{ type: "spring", stiffness: 480, damping: 40 }} />}
      <span className="n">{String(n).padStart(2, "0")}</span>
      <span className="t">{lang === "en" ? item.en : item.zh}</span>
      <span className="v">{v}</span>
    </button>
  )
}

function Vital({ k, v, color }: { k: string; v: number | null | undefined; color: string }) {
  return (
    <div className="vital" style={{ color }}>
      <span className="label" style={{ color: "var(--ink-3)" }}>{k}</span>
      <span className="bar"><i style={{ transform: `scaleX(${isNum(v) ? Math.min(1, v / 100) : 0})` }} /></span>
      <span className="num" style={{ textAlign: "right", color: "var(--ink-2)" }}>{isNum(v) ? `${v.toFixed(0)}%` : "—"}</span>
    </div>
  )
}

function Rail() {
  const t = useT()
  const m = useLive((s) => s.metrics)
  const sn = useLive((s) => s.sensors)
  let n = 0
  return (
    <nav className="rail" aria-label={t("主导航", "Main navigation")}>
      {GROUPS.map(([zh, en], g) => (
        <div key={g} style={g === 4 ? { marginTop: 8 } : undefined}>
          {zh && <div className="sect label">{t(zh, en)}</div>}
          {NAV.filter((i) => i.group === g).map((i) => <NavButton key={i.id} item={i} n={++n} />)}
        </div>
      ))}
      <div className="rail-foot">
        <Vital k="CPU" v={m?.cpuOverall} color="var(--cpu)" />
        <Vital k="GPU" v={sn?.gpuPct} color="var(--gpu)" />
        <Vital k="RAM" v={m?.memTotal ? (m.memUsed / m.memTotal) * 100 : null} color="var(--mem)" />
      </div>
    </nav>
  )
}

// ------------------------------------------------------------ titlebar
function TitleBar() {
  const t = useT()
  const page = useLive((s) => s.page)
  const fg = useLive((s) => s.fg)
  const fps = useLive((s) => s.fps)
  const rec = useSettings((s) => s.recorder)
  const item = NAV.find((i) => i.id === page)!
  const idx = NAV.indexOf(item) + 1
  const win = getCurrentWindow()
  const recording = !!fg?.isGame && rec.enabled && !!fg.exe && !rec.black.includes(fg.exe.toLowerCase())
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <Mark />
        <span data-tauri-drag-region>Core<b>Pilot</b></span>
      </div>
      <div className="crumb" data-tauri-drag-region>
        <i />
        <span className="mono" style={{ color: "var(--ink-4)" }}>{String(idx).padStart(2, "0")}</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={page} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>{t(item.zh, item.en)}</motion.span>
        </AnimatePresence>
      </div>
      <button className="cmdk" onClick={() => useLive.setState({ palette: true })}>
        <Search size={13} />
        <span>{t("跳转或执行命令…", "Jump to or run a command…")}</span>
        <span style={{ marginLeft: "auto" }} className="kbd">Ctrl K</span>
      </button>
      <div className="row" style={{ gap: 6 }}>
        <AnimatePresence>
          {fg?.isGame && (
            <motion.button key="g" className="pill game" onClick={() => go("games")} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
              <span className="dot pulse" />
              <span style={{ maxWidth: 140 }} className="ellipsis">{fg.exe?.replace(/\.exe$/i, "")}</span>
              {isNum(fps?.fps) && <b className="num">{fps!.fps!.toFixed(0)}</b>}
            </motion.button>
          )}
          {recording && (
            <motion.span key="r" className="pill rec" title={t("正在记录性能数据", "Recording performance")} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
              <span className="dot pulse" />REC
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <div className="winctl">
        <button aria-label={t("最小化", "Minimize")} onClick={() => win.minimize()}><Minus size={15} strokeWidth={1.6} /></button>
        <button aria-label={t("最大化", "Maximize")} onClick={() => win.toggleMaximize()}><Maximize2 size={13} strokeWidth={1.6} /></button>
        <button aria-label={t("关闭", "Close")} className="x" onClick={() => win.close()}><X size={16} strokeWidth={1.6} /></button>
      </div>
    </header>
  )
}

// ------------------------------------------------------------ status ticker
function StatusBar() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const ov = useLive((x) => x.overview)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(id) }, [])
  return (
    <footer className="statusbar">
      <span className="ellipsis" style={{ maxWidth: 280 }}>{ov?.cpuName ?? "—"}</span>
      <span className="sep" />
      <span>CPU <b>{fixed(s?.cpuPower, 0, " W")}</b></span>
      <span>GPU <b>{fixed(s?.gpuPower, 0, " W")}</b></span>
      <span className="sep" />
      <span className="c-net">▲</span><b>{rate(s?.netUp)}</b>
      <span className="c-net">▼</span><b>{rate(s?.netDown)}</b>
      <span className="sep" />
      <span>{t("读", "R")} <b>{rate(s?.diskRead)}</b></span>
      <span>{t("写", "W")} <b>{rate(s?.diskWrite)}</b></span>
      {isNum(s?.vramUsed) && <><span className="sep" /><span>VRAM <b>{bytes(s!.vramUsed)}</b></span></>}
      <span style={{ marginLeft: "auto" }}>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
    </footer>
  )
}

// ------------------------------------------------------------ command palette
interface Cmd { id: string; zh: string; en: string; icon: ReactNode; kind: "page" | "action"; run: () => unknown }
function commands(): Cmd[] {
  const s = useSettings.getState()
  const pages: Cmd[] = NAV.map((n) => ({ id: n.id, zh: n.zh, en: n.en, icon: <n.icon size={15} />, kind: "page", run: () => go(n.id) }))
  const acts: Cmd[] = [
    { id: "free", zh: "释放进程工作集内存", en: "Trim process working sets", icon: <Zap size={15} />, kind: "action", run: () => act(api.freeWorkingSets(), tf("已释放工作集", "Working sets trimmed")) },
    { id: "purge", zh: "清空待机内存", en: "Purge standby memory", icon: <Zap size={15} />, kind: "action", run: () => act(api.purgeStandby(), tf("待机内存已清空", "Standby list purged")) },
    { id: "temp", zh: "清理临时文件", en: "Clean temp files", icon: <Sparkles size={15} />, kind: "action", run: () => act(api.cleanTemp(), (r) => tf(`已清理 ${bytes(r.bytes)}`, `Freed ${bytes(r.bytes)}`)) },
    { id: "dns", zh: "刷新 DNS 缓存", en: "Flush DNS cache", icon: <Activity size={15} />, kind: "action", run: () => act(api.flushDns(), tf("DNS 缓存已刷新", "DNS cache flushed")) },
    { id: "high", zh: "切换到高性能电源计划", en: "Switch to High performance plan", icon: <Gauge size={15} />, kind: "action", run: () => act(api.setPowerPlan("high"), tf("已切换到高性能", "High performance active")) },
    { id: "bal", zh: "切换到平衡电源计划", en: "Switch to Balanced plan", icon: <Gauge size={15} />, kind: "action", run: () => act(api.setPowerPlan("balanced"), tf("已切换到平衡", "Balanced active")) },
    { id: "osd", zh: s.osd.mode === "off" ? "开启游戏 OSD" : "关闭游戏 OSD", en: s.osd.mode === "off" ? "Turn game OSD on" : "Turn game OSD off", icon: <Gamepad2 size={15} />, kind: "action", run: () => s.set({ osd: { ...s.osd, mode: s.osd.mode === "off" ? "window" : "off" } }) },
    { id: "theme", zh: s.theme === "dark" ? "切换到浅色主题" : "切换到深色主题", en: s.theme === "dark" ? "Switch to light theme" : "Switch to dark theme", icon: <Sparkles size={15} />, kind: "action", run: () => s.set({ theme: s.theme === "dark" ? "light" : "dark" }) },
    { id: "lang", zh: "Switch to English", en: "切换到中文", icon: <Info size={15} />, kind: "action", run: () => s.set({ lang: s.lang === "zh" ? "en" : "zh" }) },
  ]
  return [...pages, ...acts]
}

function Palette() {
  const open = useLive((s) => s.palette)
  const t = useT()
  const [q, setQ] = useState("")
  const [i, setI] = useState(0)
  const list = useMemo(() => {
    if (!open) return []
    const k = q.trim().toLowerCase()
    return commands().filter((c) => !k || c.zh.toLowerCase().includes(k) || c.en.toLowerCase().includes(k) || c.id.includes(k))
  }, [q, open])
  useEffect(() => { setI(0) }, [q])
  useEffect(() => { if (open) setQ("") }, [open])
  const close = () => useLive.setState({ palette: false })
  const run = (c?: Cmd) => { if (!c) return; close(); c.run() }
  const ulRef = useRef<HTMLUListElement>(null)
  useEffect(() => { ulRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" }) }, [i])
  const pages = list.filter((c) => c.kind === "page")
  const acts = list.filter((c) => c.kind === "action")
  const ordered = [...pages, ...acts]
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
          <motion.div className="palette" role="dialog" aria-label={t("命令面板", "Command palette")}
            initial={{ opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.985 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
            <Search size={17} className="ico" />
            <input autoFocus value={q} placeholder={t("输入页面或操作…", "Type a page or action…")} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(ordered.length - 1, x + 1)) }
                if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)) }
                if (e.key === "Enter") run(ordered[i])
                if (e.key === "Escape") close()
              }} />
            <ul ref={ulRef}>
              {pages.length > 0 && <div className="group label">{t("页面", "Pages")}</div>}
              {pages.map((c, k) => <PItem key={c.id} c={c} on={k === i} onRun={() => run(c)} onHover={() => setI(k)} />)}
              {acts.length > 0 && <div className="group label">{t("操作", "Actions")}</div>}
              {acts.map((c, k) => <PItem key={c.id} c={c} on={k + pages.length === i} onRun={() => run(c)} onHover={() => setI(k + pages.length)} />)}
              {!ordered.length && <div className="empty" style={{ padding: 28 }}>{t("没有匹配项", "No matches")}</div>}
            </ul>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
function PItem({ c, on, onRun, onHover }: { c: Cmd; on: boolean; onRun: () => void; onHover: () => void }) {
  const t = useT()
  return (
    <li className={on ? "on" : ""} onClick={onRun} onMouseMove={onHover}>
      {c.icon}
      <span>{t(c.zh, c.en)}</span>
      <span className="k">{c.kind === "page" ? <ArrowRight size={13} /> : t("执行", "Run")}</span>
    </li>
  )
}

// ------------------------------------------------------------ toasts
function Toasts() {
  const toasts = useLive((s) => s.toasts)
  const icon = { ok: <CheckCircle2 size={16} className="c-ok" />, warn: <AlertTriangle size={16} className="c-warn" />, err: <XCircle size={16} className="c-crit" />, info: <Info size={16} className="c-acc" /> }
  const color = { ok: "var(--ok)", warn: "var(--warn)", err: "var(--crit)", info: "var(--acc)" }
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((x) => (
          <motion.div key={x.id} layout className="toast" style={{ "--c": color[x.kind] } as CSSProperties}
            initial={{ opacity: 0, x: 24, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }} transition={{ type: "spring", stiffness: 420, damping: 34 }}>
            {icon[x.kind]}
            <span className="tt">{x.title}</span>
            {x.body && <span className="tb">{x.body}</span>}
            <i className="life" style={{ animationDuration: x.kind === "err" ? "7s" : "4.2s" }} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

// ------------------------------------------------------------ shell
export function Shell({ children }: { children: ReactNode }) {
  const page = useLive((s) => s.page)
  const main = useRef<HTMLElement>(null)
  useEffect(() => { main.current?.scrollTo({ top: 0 }) }, [page])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); useLive.setState((s) => ({ palette: !s.palette })) }
      if (e.ctrlKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); go(NAV[Number(e.key) - 1].id) }
    }
    window.addEventListener("keydown", k)
    return () => window.removeEventListener("keydown", k)
  }, [])
  const reduce = useSettings((s) => s.reduceMotion)
  return (
    <MotionConfig reducedMotion={reduce ? "always" : "user"}>
    <div className="app">
      <TitleBar />
      <Rail />
      <main className="main" ref={main}>
        <AnimatePresence mode="wait">
          <motion.div key={page} exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }} style={{ minHeight: "100%" }}>
            {children}
          </motion.div>
        </AnimatePresence>
      </main>
      <StatusBar />
      <Palette />
      <Toasts />
      <ConfirmHost />
    </div>
    </MotionConfig>
  )
}
