import { StrictMode, useEffect, useState } from "react"
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
import { Disk } from "./pages/Disk"
import { Settings } from "./pages/Settings"
import { Osd } from "./osd/Osd"

const PAGES = { overview: Overview, processes: Processes, cores: Cores, games: Games, thermals: Thermals, tuning: Tuning, system: System, disk: Disk, settings: Settings }

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
      {ready && <Shell><P /></Shell>}
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
