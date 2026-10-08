// The corner OSD window (`index.html?osd`). Transparent, click-through,
// content-sized; Rust owns the HWND (osd.rs), this page only decides WHAT to
// draw and asks for bounds. Never writes settings — read-only consumer.
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { api } from "../lib/ipc"
import { CAT_LABEL, CAT_ORDER, METRICS, type OsdPosition, type PlateData } from "../lib/osd"
import { mergeSettings, SETTINGS_DEFAULTS, SETTINGS_KEY, type OsdConfig, type Settings } from "../lib/store"
import { PALETTE, type ThemeStyle } from "../lib/themes"

export type { PlateData }

/** Pure plate render — shared by the OSD window and the in-app preview. Metrics
 *  group by device in a fixed order, so all GPU readings sit together. */
export function Plate({ d, osd, style }: { d: PlateData; osd: Pick<OsdConfig, "metrics" | "layout" | "scale" | "bg" | "rounded" | "position">; style: ThemeStyle }) {
  const on = new Set(osd.metrics)
  const pal = PALETTE[style] ?? PALETTE.midnight
  const groups = CAT_ORDER.map((cat) => ({ cat, items: METRICS.filter((m) => m.cat === cat && on.has(m.key)) })).filter((g) => g.items.length)
  return (
    // text hugs the screen edge it's docked to: labels on the left for left docks, mirrored on the right
    <div className={`osd-plate ${osd.layout === "column" ? "column" : ""} ${osd.position.endsWith("r") ? "right" : osd.position.endsWith("c") ? "center" : ""}`}
      style={{ zoom: osd.scale, background: `rgba(6, 9, 16, ${osd.bg})`, borderRadius: osd.rounded ? 8 : 3, boxShadow: osd.bg > 0.05 ? `inset 0 0 0 1px ${pal.fps}55` : "none" }}>
      {groups.map((g) => (
        <span key={g.cat} className="grp">
          <span className="k" style={{ color: pal[g.cat] }}>{CAT_LABEL[g.cat]}</span>
          {g.items.map((m) => <span key={m.key} className="v">{m.value(d) ?? "—"}</span>)}
        </span>
      ))}
      {!groups.length && <span className="v" style={{ opacity: 0.6 }}>—</span>}
    </div>
  )
}

async function readSettings(): Promise<Settings> {
  const raw = await api.persistGet(SETTINGS_KEY).catch(() => null)
  try {
    return mergeSettings((typeof raw === "string" ? JSON.parse(raw) : raw)?.state)
  } catch {
    return SETTINGS_DEFAULTS
  }
}

/** gap between the plate and the monitor edge (logical px); the studio scales it too */
export const OSD_MARGIN = 14
const MARGIN = OSD_MARGIN
function place(pos: OsdPosition, [mx, my, mw, mh]: [number, number, number, number], w: number, h: number) {
  const x = pos.endsWith("l") ? mx + MARGIN : pos.endsWith("r") ? mx + mw - w - MARGIN : mx + (mw - w) / 2
  const y = pos.startsWith("t") ? my + MARGIN : my + mh - h - MARGIN
  return [Math.round(x), Math.round(y)] as const
}

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
        const needGpu = o.metrics.some((m) => m.startsWith("gpu."))
        const [fps, m, s, g] = await Promise.all([api.fps(), api.metrics(), api.sensors(), needGpu ? api.gpuInfo() : Promise.resolve(null)])
        setD({ fps, m, s, g })
      } catch { /* keep last frame */ } finally { busy = false }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [cfg.osd])

  // bounds: size to the plate, dock to the configured spot on the game's monitor
  useLayoutEffect(() => {
    let alive = true
    const bounds = async () => {
      if (!show || !plate.current) { await api.osdBounds(-30000, -30000, 1, 1).catch(() => {}); return }
      const r = plate.current.getBoundingClientRect()
      const mon = await api.osdMonitor().catch(() => null)
      if (!alive || !mon) return
      const w = Math.ceil(r.width) + 2, h = Math.ceil(r.height) + 2
      const [x, y] = place(cfg.osd.position, mon, w, h)
      await api.osdBounds(x, y, w, h).catch(() => {})
    }
    bounds()
    // re-assert ~1 Hz while showing: keeps the window topmost over rude fullscreen apps
    const id = show ? setInterval(bounds, 1000) : undefined
    return () => { alive = false; clearInterval(id) }
  }, [show, cfg.osd.position, cfg.osd.scale, cfg.osd.metrics, cfg.osd.layout])

  if (!show) return null
  return (
    <div ref={plate} style={{ display: "inline-block", width: "max-content" }}>
      <Plate d={d} osd={cfg.osd} style={cfg.style} />
    </div>
  )
}
