// The corner OSD window (`index.html?osd`). Transparent, click-through,
// content-sized; Rust owns the HWND (osd.rs), this page only decides WHAT to
// draw and asks for bounds. Never writes settings — read-only consumer.
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { api, type FpsStats, type GpuInfo, type Metrics, type OsdRow, type Sensors } from "../lib/ipc"
import { DATA_COLORS, SETTINGS_DEFAULTS, SETTINGS_KEY, type Settings } from "../lib/store"
import { bytes, isNum } from "../lib/util"

export interface PlateData { fps: FpsStats | null; m: Metrics | null; s: Sensors | null; g: GpuInfo | null }

const n0 = (v: number | null | undefined, u = "") => (isNum(v) ? `${v.toFixed(0)}${u}` : "—")
const ghz = (mhz: number | null | undefined) => (isNum(mhz) && mhz > 0 ? `${(mhz / 1000).toFixed(2)}G` : "")
const rateShort = (v: number | null | undefined) => (isNum(v) ? bytes(v, 1).replace(" ", "") : "—")

/** Pure plate render — shared by the OSD window and the in-app preview. */
export function Plate({ d, rows, scale = 1 }: { d: PlateData; rows: Record<OsdRow, boolean>; scale?: number }) {
  const { fps, m, s, g } = d
  const C = DATA_COLORS
  const line = (k: string, color: string, v: React.ReactNode, x?: React.ReactNode, big = false) => (
    <>
      <span className="k" style={{ color }}>{k}</span>
      <span className={`v ${big ? "big" : ""}`}>{v}</span>
      <span className="x">{x}</span>
    </>
  )
  const vramTotal = g?.available ? g.memTotalBytes : s?.vramTotal
  const vramUsed = g?.available ? g.memUsedBytes : s?.vramUsed
  return (
    <div className="osd-plate" style={{ zoom: scale }}>
      {rows.fps && line("FPS", C.fps, n0(fps?.fps), isNum(fps?.low1) ? `1% ${fps!.low1!.toFixed(0)}` : "", true)}
      {rows.frametime && line("FT", C.fps, isNum(fps?.frametimeMs) ? fps!.frametimeMs!.toFixed(1) : "—", "ms")}
      {rows.cpu && line("CPU", C.cpu, n0(m?.cpuOverall, "%"), `${n0(s?.cpuTemp, "°")} ${ghz(s?.cpuClock)}`)}
      {rows.gpu && line("GPU", C.gpu, n0(g?.available ? g.utilizationGpu : s?.gpuPct, "%"), `${n0(g?.available ? g.temperature : s?.gpuTemp, "°")} ${ghz(g?.graphicsClock)}`)}
      {rows.vram && line("VRAM", C.gpu, bytes(vramUsed ?? null), isNum(vramTotal) ? `/ ${bytes(vramTotal, 0)}` : "")}
      {rows.ram && line("RAM", C.mem, bytes(m?.memUsed ?? null), m ? `/ ${bytes(m.memTotal, 0)}` : "")}
      {rows.disk && line("DISK", C.disk, `R ${rateShort(s?.diskRead)}`, `W ${rateShort(s?.diskWrite)}`)}
      {rows.net && line("NET", C.net, `▼ ${rateShort(s?.netDown)}`, `▲ ${rateShort(s?.netUp)}`)}
    </div>
  )
}

async function readSettings(): Promise<Settings> {
  const raw = await api.persistGet(SETTINGS_KEY).catch(() => null)
  try {
    const st = (typeof raw === "string" ? JSON.parse(raw) : raw)?.state as Partial<Settings> | undefined
    return { ...SETTINGS_DEFAULTS, ...st, osd: { ...SETTINGS_DEFAULTS.osd, ...st?.osd, rows: { ...SETTINGS_DEFAULTS.osd.rows, ...st?.osd?.rows } } }
  } catch {
    return SETTINGS_DEFAULTS
  }
}

const MARGIN = 14
export function Osd() {
  const [cfg, setCfg] = useState<Settings>(SETTINGS_DEFAULTS)
  const [show, setShow] = useState(false)
  const [d, setD] = useState<PlateData>({ fps: null, m: null, s: null, g: null })
  const plate = useRef<HTMLDivElement>(null)
  const injected = useRef(false)

  useEffect(() => {
    const beat = () => api.osdHeartbeat().catch(() => {})
    beat()
    // keep identity when unchanged so the loops below don't restart every read
    const load = () => readSettings().then((n) => setCfg((c) => (JSON.stringify(c) === JSON.stringify(n) ? c : n)))
    const ids = [setInterval(beat, 30_000), setInterval(load, 2000)]
    load()
    return () => ids.forEach(clearInterval)
  }, [])

  // Inject mode: the backend owns injection (overlay_config). The window plate
  // stays as the fallback whenever the game isn't actually injected.
  useEffect(() => {
    if (cfg.osd.mode !== "inject") { injected.current = false; return }
    const check = () => api.overlayStatus().then((st) => { injected.current = st.mode === "inject" && st.attached }).catch(() => {})
    check()
    const id = setInterval(check, 3000)
    return () => clearInterval(id)
  }, [cfg.osd.mode])

  useEffect(() => {
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const o = cfg.osd
        const fg = await api.foreground()
        const exe = fg.exe?.toLowerCase() ?? ""
        const forced = !!exe && o.targets.includes(exe)
        const eligible = (fg.isGame && o.autoGames) || forced
        const want = o.mode !== "off" && eligible && !(o.mode === "inject" && injected.current)
        setShow(want)
        if (!want) return
        const [fps, m, s, g] = await Promise.all([api.fps(), api.metrics(), api.sensors(), o.rows.gpu || o.rows.vram ? api.gpuInfo() : Promise.resolve(null)])
        setD({ fps, m, s, g })
      } catch { /* keep last frame */ } finally { busy = false }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [cfg.osd])

  // bounds: size to the plate, dock to the configured corner of the game's monitor
  useLayoutEffect(() => {
    let alive = true
    const place = async () => {
      if (!show || !plate.current) { await api.osdBounds(-30000, -30000, 1, 1).catch(() => {}); return }
      const r = plate.current.getBoundingClientRect()
      const mon = await api.osdMonitor().catch(() => null)
      if (!alive || !mon) return
      const [mx, my, mw, mh] = mon
      const w = Math.ceil(r.width) + 2, h = Math.ceil(r.height) + 2
      const c = cfg.osd.corner
      const x = c === 1 || c === 3 ? mx + mw - w - MARGIN : mx + MARGIN
      const y = c >= 2 ? my + mh - h - MARGIN : my + MARGIN
      await api.osdBounds(x, y, w, h).catch(() => {})
    }
    place()
    // re-assert ~1 Hz while showing: keeps the window topmost over rude fullscreen apps
    const id = show ? setInterval(place, 1000) : undefined
    return () => { alive = false; clearInterval(id) }
  }, [show, cfg.osd.corner, cfg.osd.scale, cfg.osd.rows])

  if (!show) return null
  return (
    <div ref={plate} style={{ display: "inline-block", width: "max-content" }}>
      <Plate d={d} rows={cfg.osd.rows} scale={cfg.osd.scale} />
    </div>
  )
}
