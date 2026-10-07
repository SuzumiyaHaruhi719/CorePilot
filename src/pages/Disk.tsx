import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronRight, FolderOpen, HardDrive, RefreshCw, Square, X } from "lucide-react"
import { api, FLAG, on, type ItemRow, type ScanProgress, type TreeNode, type TreeView, type Volume } from "../lib/ipc"
import { act, useSettings, useT } from "../lib/store"
import { bytes, squarify, type Rect } from "../lib/util"
import { Empty, Meter, Page, PageHead, Panel, swapVariants, useAsync, useReducedMotion } from "../ui/kit"

// ------------------------------------------------------------ file kinds → signal colors
const KINDS: [RegExp, string][] = [
  [/\.(mp4|mkv|mov|avi|wmv|webm|flv|m4v|ts)$/i, "--net"],
  [/\.(png|jpe?g|gif|bmp|webp|heic|psd|tiff?|raw|cr2|nef|dds)$/i, "--disk"],
  [/\.(mp3|flac|wav|ogg|aac|m4a|opus|wem|bank)$/i, "--gpu"],
  [/\.(zip|rar|7z|tar|gz|xz|zst|cab|iso|pak|vpk|bin|dat|bundle|arc)$/i, "--cpu"],
  [/\.(exe|dll|sys|msi|so|pdb|lib)$/i, "--mem"],
]
const kindOf = (name: string) => KINDS.find(([re]) => re.test(name))?.[1] ?? "--ink-3"

interface Box extends Rect { n: TreeNode; depth: number; head: boolean }
const HEAD = 15
function layout(nodes: TreeNode[], w: number, h: number): Box[] {
  if (!nodes.length) return []
  const kids = new Map<number, TreeNode[]>()
  for (const n of nodes.slice(1)) { const a = kids.get(n.parent); a ? a.push(n) : kids.set(n.parent, [n]) }
  const out: Box[] = []
  const walk = (n: TreeNode, r: Rect, depth: number) => {
    const ch = (kids.get(n.id) ?? []).filter((c) => c.allocSize > 0).sort((a, b) => b.allocSize - a.allocSize)
    const isDir = (n.flags & FLAG.DIR) !== 0
    const head = depth > 0 && isDir && r.w > 44 && r.h > 30
    out.push({ ...r, n, depth, head })
    if (!ch.length || r.w < 6 || r.h < 6) return
    const inner = depth === 0 ? { x: r.x, y: r.y, w: r.w, h: r.h } : { x: r.x + 2, y: r.y + (head ? HEAD : 2), w: r.w - 4, h: r.h - (head ? HEAD + 2 : 4) }
    if (inner.w < 3 || inner.h < 3) return
    // children only cover their share of the parent; the rest is the parent's own files/slack
    const total = Math.max(n.allocSize, ch.reduce((a, c) => a + c.allocSize, 0))
    const vals = ch.map((c) => c.allocSize)
    const rest = total - vals.reduce((a, b) => a + b, 0)
    const rects = squarify(rest > total * 0.002 ? [...vals, rest].sort((a, b) => b - a) : vals, inner)
    let k = 0
    const order = rest > total * 0.002 ? [...vals, rest].map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v) : vals.map((v, i) => ({ v, i }))
    for (const o of order) {
      const rr = rects[k++]
      if (o.i < ch.length && rr.w >= 1 && rr.h >= 1) walk(ch[o.i], rr, depth + 1)
    }
  }
  walk(nodes[0], { x: 0, y: 0, w, h }, 0)
  return out
}

function Treemap({ view, onDrill, onHover }: { view: TreeView; onDrill: (n: TreeNode, r: Rect) => void; onHover: (b: Box | null) => void }) {
  const cv = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 480 })
  const boxes = useMemo(() => layout(view.nodes, size.w, size.h), [view, size])
  const hover = useRef<Box | null>(null)
  const zoom = useRef<{ from: Rect | null; t0: number }>({ from: null, t0: 0 })
  const theme = useSettings((s) => s.theme)
  const reduced = useReducedMotion()
  const raf = useRef(0)

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setSize({ w: wrap.current!.clientWidth, h: wrap.current!.clientHeight }))
    ro.observe(wrap.current!)
    return () => ro.disconnect()
  }, [])

  const draw = (k = 1) => {
    const c = cv.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = size.w * dpr; c.height = size.h * dpr
    const g = c.getContext("2d")!
    const st = getComputedStyle(c)
    const col = (v: string) => st.getPropertyValue(v).trim()
    const panel = col("--panel-2"), line = col("--line-2"), ink = col("--ink-2"), acc = col("--acc")
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, size.w, size.h)
    // zoom-in: interpolate from the clicked rect to the full canvas
    const f = zoom.current.from
    if (f && k < 1) {
      const e = 1 - Math.pow(1 - k, 3)
      const sx = (f.w + (size.w - f.w) * e) / size.w, sy = (f.h + (size.h - f.h) * e) / size.h
      g.translate(f.x * (1 - e), f.y * (1 - e)); g.scale(sx, sy)
      g.globalAlpha = 0.4 + 0.6 * e
    }
    g.font = "500 11px Bahnschrift, Segoe UI, sans-serif"
    g.textBaseline = "middle"
    for (const b of boxes) {
      if (b.depth === 0) continue
      const isDir = (b.n.flags & FLAG.DIR) !== 0
      if (isDir) {
        g.fillStyle = panel
        g.globalAlpha *= 1
        g.fillRect(b.x, b.y, b.w, b.h)
        g.strokeStyle = line
        g.lineWidth = 1
        g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1)
      } else {
        const c0 = col(kindOf(b.n.name))
        g.fillStyle = c0
        const a = g.globalAlpha
        g.globalAlpha = a * 0.55
        g.fillRect(b.x + 0.5, b.y + 0.5, Math.max(0.5, b.w - 1), Math.max(0.5, b.h - 1))
        g.globalAlpha = a
        if (b.w > 60 && b.h > 18) { g.fillStyle = "rgba(0,0,0,.55)"; g.fillText(b.n.name, b.x + 5, b.y + 10, b.w - 10) }
      }
      if (b.head) { g.fillStyle = ink; g.fillText(`${b.n.name}  ${bytes(b.n.allocSize, 0)}`, b.x + 5, b.y + 8, b.w - 10) }
    }
    const h = hover.current
    if (h && k >= 1) { g.strokeStyle = acc; g.lineWidth = 2; g.strokeRect(h.x + 1, h.y + 1, h.w - 2, h.h - 2) }
  }

  useEffect(() => {
    cancelAnimationFrame(raf.current)
    if (!zoom.current.from || reduced) { draw(1); return }
    zoom.current.t0 = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - zoom.current.t0) / 380)
      draw(k)
      if (k < 1) raf.current = requestAnimationFrame(step)
      else zoom.current.from = null
    }
    raf.current = requestAnimationFrame(step)
  }, [boxes, theme]) // eslint-disable-line react-hooks/exhaustive-deps

  const hit = (e: React.MouseEvent) => {
    const r = cv.current!.getBoundingClientRect()
    const x = e.clientX - r.left, y = e.clientY - r.top
    let best: Box | null = null
    for (const b of boxes) if (b.depth > 0 && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) best = b // deepest wins (pre-order)
    return best
  }
  return (
    <div ref={wrap} style={{ position: "absolute", inset: 0 }}>
      <canvas ref={cv} style={{ width: size.w, height: size.h, display: "block", cursor: "pointer" }}
        onMouseMove={(e) => { const b = hit(e); if (b !== hover.current) { hover.current = b; onHover(b); draw(1) } }}
        onMouseLeave={() => { hover.current = null; onHover(null); draw(1) }}
        onClick={(e) => {
          let b = hit(e)
          // clicking a file drills into its folder
          while (b && !(b.n.flags & FLAG.DIR)) b = boxes.find((x) => x.n.id === b!.n.parent && x.depth > 0) ?? null
          if (b?.n.path) { zoom.current.from = { x: b.x, y: b.y, w: b.w, h: b.h }; onDrill(b.n, b) }
        }} />
    </div>
  )
}

// ------------------------------------------------------------ scan workspace
function Workspace({ vol, prog, onClose, onRescan }: { vol: Volume; prog: ScanProgress | undefined; onClose: () => void; onRescan: () => void }) {
  const t = useT()
  const [focus, setFocus] = useState<string | null>(null)
  const [view, setView] = useState<TreeView | null>(null)
  const [top, setTop] = useState<ItemRow[]>([])
  const [hov, setHov] = useState<{ n: TreeNode } | null>(null)
  const gen = prog?.generation ?? 0
  const scanning = prog?.status === "scanning"
  useEffect(() => {
    let live = true
    api.diskTree(vol.scanId, focus, { maxNodes: 14000 }).then((v) => live && setView(v)).catch(() => {})
    api.diskTop(vol.scanId, focus, 40).then((r) => live && setTop(r)).catch(() => {})
    return () => { live = false }
  }, [vol.scanId, focus, scanning ? Math.floor(gen / 3) : gen]) // eslint-disable-line react-hooks/exhaustive-deps
  const crumbs = useMemo(() => {
    const root = vol.root
    if (!focus) return [{ name: vol.letter || root, path: null as string | null }]
    const rest = focus.slice(root.length).split(/[\\/]/).filter(Boolean)
    return [{ name: vol.letter || root, path: null }, ...rest.map((name, i) => ({ name, path: root + rest.slice(0, i + 1).join("\\") }))]
  }, [focus, vol])
  const used = vol.total - vol.free
  const maxTop = top[0]?.allocSize ?? 1
  return (
    <div className="col" style={{ "--gap": "14px" } as CSSProperties}>
      <div className="panel pad row" style={{ "--gap": "18px" } as CSSProperties}>
        <button className="btn ghost icon sm" onClick={onClose} aria-label={t("返回", "Back")}><X size={15} /></button>
        <div className="col" style={{ "--gap": "2px" } as CSSProperties}>
          <b style={{ font: "600 18px var(--f-num)" }}>{vol.letter} {vol.label}</b>
          <span className="faint" style={{ fontSize: 12 }}>{vol.fileSystem} · {bytes(used)} / {bytes(vol.total)}</span>
        </div>
        <div className="grow col" style={{ "--gap": "6px" } as CSSProperties}>
          <div className="row spread" style={{ fontSize: 12 }}>
            <span className={scanning ? "c-acc" : "faint"}>{scanning ? t("扫描中", "Scanning") : prog?.status === "done" ? t("扫描完成", "Scan complete") : prog?.status ?? ""}</span>
            <span className="num dim">{prog ? <>{prog.filesSeen.toLocaleString("en-US")} {t("个文件", "files")} · {bytes(prog.bytesAlloc)} · {(prog.elapsedMs / 1000).toFixed(1)} s</> : "—"}</span>
          </div>
          <Meter v={prog?.bytesAlloc ?? 0} max={used || 1} lg />
          {scanning && <span className="mono faint ellipsis" style={{ fontSize: 10.5 }}>{prog?.currentPath}</span>}
        </div>
        {scanning ? <button className="btn sm" onClick={() => api.scanCancel(vol.scanId)}><Square size={11} />{t("停止", "Stop")}</button> : <button className="btn sm" onClick={onRescan}><RefreshCw size={12} />{t("重新扫描", "Rescan")}</button>}
      </div>

      <div className="row" style={{ "--gap": "2px", flexWrap: "wrap" } as CSSProperties}>
        {crumbs.map((c, i) => (
          <span key={i} className="row" style={{ "--gap": "2px" } as CSSProperties}>
            {i > 0 && <ChevronRight size={13} className="faint" />}
            <button className={`btn ghost sm ${i === crumbs.length - 1 ? "" : "dim"}`} onClick={() => setFocus(c.path)} disabled={i === crumbs.length - 1}>{c.name}</button>
          </span>
        ))}
        <span className="grow" />
        <AnimatePresence>
          {hov && (
            <motion.span key="h" className="row faint" style={{ fontSize: 12 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <b style={{ color: "var(--ink)", fontWeight: 500 }} className="ellipsis">{hov.n.name}</b>
              <span className="num">{bytes(hov.n.allocSize)}</span>
              {(hov.n.flags & FLAG.DIR) !== 0 && <span className="num">{hov.n.fileCount.toLocaleString()} {t("个文件", "files")}</span>}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 14, height: "calc(100vh - 330px)", minHeight: 340 }}>
        <div className="panel" style={{ position: "relative", overflow: "hidden", padding: 0 }}>
          {view ? <Treemap view={view} onDrill={(n) => setFocus(n.path)} onHover={(b) => setHov(b ? { n: b.n } : null)} /> : <div className="skeleton" style={{ position: "absolute", inset: 8 }} />}
        </div>
        <div className="panel col" style={{ overflow: "hidden", "--gap": 0 } as CSSProperties}>
          <div className="ph" style={{ padding: "14px 16px 0", marginBottom: 8 }}><span className="label">{t("最大的项目", "Largest items")}</span></div>
          <div style={{ overflow: "auto", flex: 1, padding: "0 8px 8px" }}>
            {top.map((r) => (
              <div key={r.path} className="col" style={{ padding: "7px 8px", borderRadius: 6, "--gap": "5px" } as CSSProperties}>
                <div className="row spread" style={{ fontSize: 12.5 }}>
                  <span className="ellipsis" title={r.path} style={{ color: (r.flags & FLAG.DIR) ? "var(--ink)" : `var(${kindOf(r.name)})` }}>{r.name}</span>
                  <span className="row" style={{ "--gap": "4px" } as CSSProperties}>
                    <span className="num dim">{bytes(r.allocSize)}</span>
                    <button className="btn ghost icon sm" title={t("在资源管理器中显示", "Show in Explorer")} onClick={() => act(api.reveal(r.path))}><FolderOpen size={12} /></button>
                  </span>
                </div>
                <Meter v={r.allocSize} max={maxTop} color={(r.flags & FLAG.DIR) ? "var(--ink-3)" : `var(${kindOf(r.name)})`} />
              </div>
            ))}
          </div>
          <div className="row wrap" style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", "--gap": "10px", fontSize: 11 } as CSSProperties}>
            {[["--net", t("视频", "Video")], ["--disk", t("图片", "Image")], ["--gpu", t("音频", "Audio")], ["--cpu", t("压缩/资源包", "Archive")], ["--mem", t("程序", "Binary")]].map(([c, l]) => (
              <span key={c} className="row faint" style={{ "--gap": "5px" } as CSSProperties}><i style={{ width: 8, height: 8, borderRadius: 2, background: `var(${c})`, opacity: 0.7 }} />{l}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ page
let openVol: string | null = null
export function Disk() {
  const t = useT()
  const vols = useAsync(api.volumes)
  const [prog, setProg] = useState<Record<string, ScanProgress>>({})
  const [open, setOpen] = useState<string | null>(openVol)
  const pick = (id: string | null) => { openVol = id; setOpen(id) }
  useEffect(() => { const u = on("disk-scan://progress", (p) => setProg((s) => ({ ...s, [p.scanId]: p }))); return () => { u.then((f) => f()) } }, [])
  useEffect(() => { (vols.data ?? []).forEach((v) => api.scanStatus(v.scanId).then((p) => setProg((s) => ({ ...s, [p.scanId]: p }))).catch(() => {})) }, [vols.data])
  const start = async (v: Volume) => { await act(api.scanStart([v.scanId])); pick(v.scanId) }
  const rescan = async (v: Volume) => { await api.scanCancel(v.scanId).catch(() => {}); await act(api.scanStart([v.scanId])) }
  const vol = vols.data?.find((v) => v.scanId === open)
  return (
    <Page>
      <PageHead idx="08" title={t("磁盘分析", "Disk analyzer")} sub={t("基于 MFT 的极速扫描，直观看到空间被谁占用", "MFT-speed scanning — see exactly what is eating your space")} />
      <AnimatePresence mode="wait" initial={false}>
        {vol ? (
          <motion.div key="ws" variants={swapVariants(0, 8)} initial="hidden" animate="show" exit="exit">
            <Workspace vol={vol} prog={prog[vol.scanId]} onClose={() => pick(null)} onRescan={() => rescan(vol)} />
          </motion.div>
        ) : (
          <motion.div key="pick" className="grid g3" variants={swapVariants(0, 8)} initial="hidden" animate="show" exit="exit">
            {!vols.data ? [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 170 }} />) : vols.data.length === 0 ? <Panel className="fill"><Empty title={t("没有可扫描的磁盘", "No volumes to scan")} /></Panel> : vols.data.map((v, i) => {
              const used = v.total - v.free
              const p = prog[v.scanId]
              const pct = v.total ? (used / v.total) * 100 : 0
              return (
                <motion.div key={v.scanId} className="panel pad col ticks" style={{ "--gap": "14px" } as CSSProperties} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                  <div className="row spread">
                    <div className="row" style={{ "--gap": "12px" } as CSSProperties}>
                      <HardDrive size={22} strokeWidth={1.4} className="c-disk" />
                      <div className="col" style={{ "--gap": "1px" } as CSSProperties}>
                        <b style={{ font: "600 20px var(--f-num)" }}>{v.letter}</b>
                        <span className="faint" style={{ fontSize: 12 }}>{v.label || t("本地磁盘", "Local disk")} · {v.fileSystem} · {v.driveType === "removable" ? t("可移动", "removable") : t("固定", "fixed")}</span>
                      </div>
                    </div>
                    <div className="readout sm"><span className="v">{pct.toFixed(0)}</span><span className="u">%</span></div>
                  </div>
                  <Meter v={pct} lg color={pct > 90 ? "var(--crit)" : pct > 75 ? "var(--warn)" : "var(--disk)"} />
                  <div className="row spread faint num" style={{ fontSize: 12 }}><span>{bytes(used)} {t("已用", "used")}</span><span>{bytes(v.free)} {t("可用", "free")}</span></div>
                  <div className="row">
                    {p && p.status !== "cancelled" ? <button className="btn sm primary" onClick={() => pick(v.scanId)}>{p.status === "scanning" ? t("查看进度", "View progress") : t("打开结果", "Open results")}</button>
                      : <button className="btn sm primary" disabled={!v.supported} onClick={() => start(v)}>{t("扫描", "Scan")}</button>}
                    {!v.supported && <span className="faint" style={{ fontSize: 11.5 }}>{t("不支持此文件系统", "Unsupported file system")}</span>}
                  </div>
                </motion.div>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </Page>
  )
}
