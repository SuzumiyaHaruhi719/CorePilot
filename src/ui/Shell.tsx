import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { AnimatePresence, MotionConfig, motion } from "motion/react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, Gamepad2, Gauge, Info, Maximize2, Minus, Palette, Search, Sparkles, Wand2, X, XCircle, Zap } from "lucide-react"
import { api } from "../lib/ipc"
import { act, go, motionReduced, tf, toast, useLive, useProfiles, useSettings, useT, type PageId } from "../lib/store"
import { STYLES, type ThemeStyle } from "../lib/themes"
import { runOneClick } from "../lib/optimize"
import { bytes, fixed, isNum, rate } from "../lib/util"
import { ConfirmHost, MenuHost, EASE, EASE_IN, GLIDE, SETTLE, useReducedMotion } from "./kit"
import { NAV, type NavItem } from "./nav"

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
export { NAV }

/** Theme switch: the new theme washes out from the click point (View Transition). */
export function setStyle(style: ThemeStyle, at?: { x: number; y: number }) {
  const apply = () => useSettings.getState().set({ style })
  const d = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } }
  if (!d.startViewTransition || motionReduced()) return apply()
  const x = at?.x ?? innerWidth / 2, y = at?.y ?? innerHeight / 2
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  d.startViewTransition(() => flushSync(apply)).ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 620, easing: "cubic-bezier(0.16, 1, 0.3, 1)", pseudoElement: "::view-transition-new(root)" },
    )
  }).catch(() => {})
}

function useBadge(id: PageId): { text: string; hot?: boolean } | null {
  const fps = useLive((s) => (s.fg?.isGame ? s.fps?.fps : null))
  const procs = useLive((s) => s.procCount)
  const coreOpt = useLive((s) => s.coreOpt)
  const groups = useProfiles((s) => s.groups.length)
  switch (id) {
    case "games": return isNum(fps) ? { text: fps.toFixed(0), hot: true } : null
    case "processes": return procs ? { text: procs > 999 ? "999+" : String(procs) } : null
    case "cores": return coreOpt && groups ? { text: String(groups), hot: true } : null
    default: return null
  }
}

function NavButton({ item }: { item: NavItem }) {
  const page = useLive((s) => s.page)
  const lang = useSettings((s) => s.lang)
  const badge = useBadge(item.id)
  const on = page === item.id
  const Icon = item.icon
  return (
    <motion.button className={`nav rv ${on ? "on" : ""}`} onClick={() => go(item.id)} aria-current={on ? "page" : undefined} title={lang === "en" ? item.en : item.zh}
      whileTap={{ scale: 0.95 }} transition={{ type: "spring", bounce: 0.3, visualDuration: 0.32 }}>
      {on && <motion.span className="nav-pill" layoutId="nav-pill" transition={GLIDE} />}
      <Icon size={21} strokeWidth={on ? 2.4 : 1.9} />
      <span className="t">{lang === "en" ? item.en : item.zh}</span>
      <AnimatePresence>
        {badge && (
          <motion.span key="b" className="badge" style={badge.hot && !on ? { color: "var(--ok)" } : undefined}
            initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.12 } }} transition={SETTLE}>
            {badge.text}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}

function Ring({ k, v, color }: { k: string; v: number | null | undefined; color: string }) {
  const r = 21
  const c = 2 * Math.PI * r
  const f = isNum(v) ? Math.min(1, Math.max(0, v / 100)) : 0
  return (
    <div className="ring" style={{ color }} title={`${k} ${isNum(v) ? v.toFixed(0) : "—"}%`}>
      <svg viewBox="0 0 50 50"><circle className="trk" cx="25" cy="25" r={r} /><circle className="val" cx="25" cy="25" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - f)} /></svg>
      <b>{isNum(v) ? v.toFixed(0) : "—"}</b>
      <span>{k}</span>
    </div>
  )
}

function Rail() {
  const t = useT()
  const m = useLive((s) => s.metrics)
  const sn = useLive((s) => s.sensors)
  return (
    <nav className="rail" aria-label={t("主导航", "Main navigation")}>
      {NAV.map((item, i) => (
        <Fragment key={item.id}>
          {i > 0 && NAV[i - 1].group !== item.group && <i className="sep" />}
          <NavButton item={item} />
        </Fragment>
      ))}
      <div className="rail-foot">
        <Ring k="CPU" v={m?.cpuOverall} color="var(--cpu)" />
        <Ring k="GPU" v={sn?.gpuPct} color="var(--gpu)" />
        <Ring k="RAM" v={m?.memTotal ? (m.memUsed / m.memTotal) * 100 : null} color="var(--mem)" />
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
  const pages: Cmd[] = NAV.map((n) => ({ id: n.id, zh: n.zh, en: n.en, icon: <n.icon size={14} />, kind: "page", run: () => go(n.id) }))
  const acts: Cmd[] = [
    { id: "oneclick", zh: "一键优化", en: "One-click optimize", icon: <Wand2 size={14} />, kind: "action", run: async () => { const r = await runOneClick(); toast(r.ok ? "ok" : "warn", tf("一键优化完成", "One-click optimize done"), r.text) } },
    { id: "free", zh: "释放进程工作集内存", en: "Trim process working sets", icon: <Zap size={14} />, kind: "action", run: () => act(api.freeWorkingSets(), tf("已释放工作集", "Working sets trimmed")) },
    { id: "purge", zh: "清空待机内存", en: "Purge standby memory", icon: <Zap size={14} />, kind: "action", run: () => act(api.purgeStandby(), tf("待机内存已清空", "Standby list purged")) },
    { id: "temp", zh: "清理临时文件", en: "Clean temp files", icon: <Sparkles size={14} />, kind: "action", run: () => act(api.cleanTemp(), (r) => tf(`已清理 ${bytes(r.bytes)}`, `Freed ${bytes(r.bytes)}`)) },
    { id: "dns", zh: "刷新 DNS 缓存", en: "Flush DNS cache", icon: <Activity size={14} />, kind: "action", run: () => act(api.flushDns(), tf("DNS 缓存已刷新", "DNS cache flushed")) },
    { id: "ultimate", zh: "切换到卓越性能电源计划", en: "Switch to Ultimate Performance plan", icon: <Gauge size={14} />, kind: "action", run: () => act(api.setPowerPlan("ultimate"), tf("已切换到卓越性能", "Ultimate Performance active")) },
    { id: "high", zh: "切换到高性能电源计划", en: "Switch to High performance plan", icon: <Gauge size={14} />, kind: "action", run: () => act(api.setPowerPlan("high"), tf("已切换到高性能", "High performance active")) },
    { id: "bal", zh: "切换到平衡电源计划", en: "Switch to Balanced plan", icon: <Gauge size={14} />, kind: "action", run: () => act(api.setPowerPlan("balanced"), tf("已切换到平衡", "Balanced active")) },
    { id: "osd", zh: s.osd.mode === "off" ? "开启游戏 OSD" : "关闭游戏 OSD", en: s.osd.mode === "off" ? "Turn game OSD on" : "Turn game OSD off", icon: <Gamepad2 size={14} />, kind: "action", run: () => s.set({ osd: { ...s.osd, mode: s.osd.mode === "off" ? "window" : "off" } }) },
    ...STYLES.filter((x) => x.id !== s.style).map((x): Cmd => ({ id: `style-${x.id}`, zh: `主题：${x.zh}`, en: `Theme: ${x.en}`, icon: <Palette size={14} />, kind: "action", run: () => setStyle(x.id) })),
    { id: "lang", zh: "Switch to English", en: "切换到中文", icon: <Info size={14} />, kind: "action", run: () => s.set({ lang: s.lang === "zh" ? "en" : "zh" }) },
  ]
  return [...pages, ...acts]
}

function CommandPalette() {
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
          <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.2 } }} exit={{ opacity: 0, transition: { duration: 0.14 } }} onClick={close} />
          <motion.div className="palette" role="dialog" aria-label={t("命令面板", "Command palette")}
            initial={{ opacity: 0, y: -12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1, transition: SETTLE }} exit={{ opacity: 0, y: -6, scale: 0.985, transition: { duration: 0.12, ease: EASE_IN } }}>
            <div className="bar">
            <Search size={17} />
            <input autoFocus value={q} placeholder={t("输入页面或操作…", "Type a page or action…")} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(ordered.length - 1, x + 1)) }
                if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)) }
                if (e.key === "Enter") run(ordered[i])
                if (e.key === "Escape") close()
              }} />
            <span className="kbd">Esc</span>
            </div>
            <ul ref={ulRef}>
              {pages.length > 0 && <div className="group label">{t("页面", "Pages")}</div>}
              {pages.map((c, k) => <PItem key={c.id} c={c} on={k === i} onRun={() => run(c)} onHover={() => setI(k)} />)}
              {acts.length > 0 && <div className="group label">{t("操作", "Actions")}</div>}
              {acts.map((c, k) => <PItem key={c.id} c={c} on={k + pages.length === i} onRun={() => run(c)} onHover={() => setI(k + pages.length)} />)}
              {!ordered.length && <div className="empty" style={{ padding: 28 }}>{t("没有匹配项", "No matches")}</div>}
            </ul>
            <div className="foot">
              <span><span className="kbd">↑</span><span className="kbd">↓</span>{t("选择", "Select")}</span>
              <span><span className="kbd">Enter</span>{t("执行", "Run")}</span>
              <span style={{ marginLeft: "auto" }}><span className="kbd">Ctrl</span><span className="kbd">1–9</span>{t("直达页面", "Jump to page")}</span>
            </div>
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
      {on && <motion.i className="hl" layoutId="pal-hl" transition={GLIDE} />}
      <span className="tile">{c.icon}</span>
      <span>{t(c.zh, c.en)}</span>
      {on && <span className="k">{c.kind === "page" ? <>{t("前往", "Open")}<ArrowRight size={13} /></> : <span className="kbd">Enter</span>}</span>}
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
            initial={{ opacity: 0, x: 40, scale: 0.97 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 40, scale: 0.98, transition: { duration: 0.16, ease: EASE_IN } }} transition={SETTLE}>
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
const PAGE_V = {
  enter: (d: number) => ({ opacity: 0, y: 14 * d }),
  show: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE } },
  exit: (d: number) => ({ opacity: 0, y: -8 * d, transition: { duration: 0.13, ease: EASE_IN } }),
}

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
  // hover light: interactive surfaces (.rv) get a soft glow that follows the pointer —
  // one passive listener, rAF-coalesced, writing two CSS vars on the hovered element only
  useEffect(() => {
    let raf = 0, last: PointerEvent | null = null
    const move = (e: PointerEvent) => {
      last = e
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const el = (last?.target as Element | null)?.closest?.(".rv") as HTMLElement | null
        if (!el || !last) return
        const r = el.getBoundingClientRect()
        el.style.setProperty("--mx", `${last.clientX - r.left}px`)
        el.style.setProperty("--my", `${last.clientY - r.top}px`)
      })
    }
    addEventListener("pointermove", move, { passive: true })
    return () => { removeEventListener("pointermove", move); cancelAnimationFrame(raf) }
  }, [])
  const reduce = useReducedMotion()
  // page motion follows the rail: moving down the list content rises, moving up it falls
  const idx = NAV.findIndex((n) => n.id === page)
  const prevIdx = useRef(idx)
  const dir = idx >= prevIdx.current ? 1 : -1
  useEffect(() => { prevIdx.current = idx }, [idx])
  const visible = useLive((s) => s.visible)
  return (
    <MotionConfig reducedMotion={reduce ? "always" : "never"}>
    <div className="app" data-live={visible ? "1" : "0"}>
      {/* slow-drifting ambient light behind everything; the first blob takes the machine's mood color */}
      <div className="ambient" aria-hidden><i /><i /><i /></div>
      <TitleBar />
      <Rail />
      <main className="main" ref={main}>
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.div key={page} custom={dir} variants={PAGE_V} initial="enter" animate="show" exit="exit" style={{ minHeight: "100%" }}>
            {children}
          </motion.div>
        </AnimatePresence>
      </main>
      <StatusBar />
      <CommandPalette />
      <Toasts />
      <ConfirmHost />
      <MenuHost />
    </div>
    </MotionConfig>
  )
}
