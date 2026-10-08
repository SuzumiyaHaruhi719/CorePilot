import { Component, StrictMode, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { AnimatePresence, motion } from "motion/react"
import "uplot/dist/uPlot.min.css"
import "./styles.css"
import { hydrated, useLive, useProfiles, useSettings } from "./lib/store"
import { startServices } from "./lib/boot"
import { importLegacy } from "./lib/migrate"
import { Mark, Shell } from "./ui/Shell"
import { Overview } from "./pages/Overview"
import { Processes } from "./pages/Processes"
import { Cores } from "./pages/Cores"
import { Games } from "./pages/Games"
import { Thermals } from "./pages/Thermals"
import { Tuning } from "./pages/Tuning"
import { System } from "./pages/System"
import { Cron } from "./pages/Cron"
import { Disk } from "./pages/Disk"
import { Settings } from "./pages/Settings"
import { Osd } from "./osd/Osd"
import { logUi } from "./lib/ipc"
import { tf } from "./lib/store"

/** A page that throws (unexpected data on some other PC) logs and offers a retry
 *  instead of blanking the whole window. */
class PageBoundary extends Component<{ page: string; children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  componentDidCatch(err: Error, info: { componentStack?: string | null }) { logUi("error", `page ${this.props.page} crashed: ${err.stack ?? err}${info.componentStack ?? ""}`) }
  componentDidUpdate(prev: { page: string }) { if (prev.page !== this.props.page && this.state.err) this.setState({ err: null }) }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div className="panel pad col" style={{ margin: 32, gap: 10 }}>
        <b>{tf("这个页面出错了", "This page hit an error")}</b>
        <span className="faint selectable" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{String(this.state.err.message)}</span>
        <span className="faint" style={{ fontSize: 12 }}>{tf("已写入调试日志（设置 → 导出调试日志）。", "Written to the debug log (Settings → Export debug logs).")}</span>
        <div><button className="btn primary" onClick={() => this.setState({ err: null })}>{tf("重试", "Retry")}</button></div>
      </div>
    )
  }
}
addEventListener("error", (e) => logUi("error", `uncaught: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`))
addEventListener("unhandledrejection", (e) => logUi("error", `unhandled rejection: ${e.reason?.stack ?? String(e.reason)}`))

const PAGES = { overview: Overview, processes: Processes, cores: Cores, games: Games, thermals: Thermals, tuning: Tuning, system: System, cron: Cron, disk: Disk, settings: Settings }

function App() {
  const [ready, setReady] = useState(false)
  const page = useLive((s) => s.page)
  useEffect(() => {
    // ≥ 520 ms so the mark's boot animation completes instead of flashing
    Promise.all([hydrated().then(importLegacy).catch(console.error), new Promise((r) => setTimeout(r, 520))]).then(() => { startServices(); setReady(true) })
  }, [])
  const P = PAGES[page]
  return (
    <>
      {ready && <Shell><PageBoundary page={page}><P /></PageBoundary></Shell>}
      <AnimatePresence>
        {!ready && (
          <motion.div className="boot" exit={{ opacity: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } }}>
            <motion.div className="mark" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ scale: 1.06 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}>
              <Mark size={44} animate />
              <span className="word">COREPILOT</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

async function mount() {
  // Browser preview (no Tauri host): install the mocked IPC. Dead-code
  // eliminated from production builds by the DEV guard.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) await import("./dev/mock")
  if (import.meta.env.DEV) Object.assign(window, { __cp: { useLive, useSettings, useProfiles } }) // devtools handle
  const osd = new URLSearchParams(location.search).has("osd")
  if (osd) document.documentElement.classList.add("osd")
  createRoot(document.getElementById("root")!).render(<StrictMode>{osd ? <Osd /> : <App />}</StrictMode>)
}
mount()
