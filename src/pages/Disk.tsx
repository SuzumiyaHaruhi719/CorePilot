import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { AnimatePresence, motion } from "motion/react"
import { create } from "zustand"
import { Check, ChevronRight, Copy, CornerLeftUp, FolderOpen, HardDrive, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Square, X, ZoomIn } from "lucide-react"
import { api, FLAG, on, type ItemRow, type ScanProgress, type TreeNode, type TreeView, type Volume } from "../lib/ipc"
import { act, tf, useSettings, useT } from "../lib/store"
import { bytes, clamp } from "../lib/util"
import { contextMenu, EASE, EASE_IN, Empty, GLIDE, Page, PageHead, Panel, Range, Seg, useAsync, useReducedMotion } from "../ui/kit"
import { copyPath } from "./Processes"

// ============================================================ tabs (survive page switches)
interface Tab { id: string; focus: string | null; lod: number }
const useDisk = create<{ tabs: Tab[]; active: string | null; prog: Record<string, ScanProgress> }>(() => ({ tabs: [], active: null, prog: {} }))
const patchTab = (id: string, p: Partial<Tab>) => useDisk.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) }))

/** 细节密度 1–10 → size floor below which children merge server-side (1 = everything). */
const minBytesFor = (d: number) => (d <= 1 ? 0 : 64 * 1024 * 2 ** (d - 1)) // 2 → 128 KB … 10 → 32 MB (as before) … 17 → 4 GB
const LOD_MAX = 17
const lodLabel = (d: number, all: string) => (d <= 1 ? all : bytes(minBytesFor(d), 0))

// ============================================================ layout
interface R { x: number; y: number; w: number; h: number }
/** `chain`: single-child folders folded into this tile's header ("TOXIC WT › starfish"); `path` is set for files too. */
interface Box extends R { key: string; n: TreeNode; depth: number; hue: number; head: boolean; kind: "dir" | "file" | "agg" | "pend" | "rest"; path: string | null; chain?: TreeNode[]; inner?: boolean; of?: TreeNode }
const joinPath = (dir: string | null | undefined, name: string) => (dir ? (dir.endsWith("\\") ? dir + name : `${dir}\\${name}`) : null)
/** the folder a dir tile opens: the deepest node of its folded chain */
const target = (b: Box) => b.chain?.[b.chain.length - 1] ?? b.n
const HEAD = 18, GAP = 2
/** children below ~20×20 px are unreadable noise: they fold into the 更小的项目 tile */
const MIN_AREA = 400
// curated hues that separate well on dark and light grounds
const HUES = [186, 262, 38, 318, 148, 216, 14, 92, 344, 200]
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0 }

function squarify(items: TreeNode[], r: R, out: (n: TreeNode, rect: R) => void) {
  const total = items.reduce((a, n) => a + n.allocSize, 0)
  if (total <= 0 || r.w < 1 || r.h < 1) return
  const scale = (r.w * r.h) / total
  let { x, y, w, h } = r
  let i = 0
  while (i < items.length) {
    const short = Math.min(w, h)
    const row: TreeNode[] = []
    let sum = 0, worst = Infinity
    while (i < items.length) {
      const a = items[i].allocSize * scale
      const s2 = sum + a
      const mx = Math.max(...row.map((n) => n.allocSize * scale), a), mn = Math.min(...row.map((n) => n.allocSize * scale), a)
      const wr = Math.max((short * short * mx) / (s2 * s2), (s2 * s2) / (short * short * mn))
      if (row.length && wr > worst) break
      row.push(items[i]); sum = s2; worst = wr; i++
    }
    const thick = sum / short
    let off = 0
    for (const n of row) {
      const len = (n.allocSize * scale) / thick
      out(n, w >= h ? { x, y: y + off, w: thick, h: len } : { x: x + off, y, w: len, h: thick })
      off += len
    }
    if (w >= h) { x += thick; w -= thick } else { y += thick; h -= thick }
  }
}

/** The not-yet-scanned remainder, laid out as one more top-level tile. */
const PENDING_ID = -2
const PENDING_KEY = "\u0001pending"
/** What the slice left out of a folder (below the detail floor), as one tile. */
const REST_ID = -3

export function layout(view: TreeView, W: number, H: number, pending = 0): Box[] {
  const kids = new Map<number, TreeNode[]>()
  // the focus root is its own parent (parent === id) — never its own child
  for (const n of view.nodes) if (n.parent >= 0 && n.parent !== n.id) { const a = kids.get(n.parent); a ? a.push(n) : kids.set(n.parent, [n]) }
  for (const a of kids.values()) a.sort((p, q) => q.allocSize - p.allocSize)
  const sized = (n: TreeNode) => (kids.get(n.id) ?? []).filter((k) => k.allocSize > 0)
  const synth = (id: number, parent: TreeNode, size: number): TreeNode => ({ id, parent: parent.id, name: "", logicalSize: size, allocSize: size, fileCount: 0, flags: 0, hasMore: false, path: null })
  /** what gets drawn inside `parent` at rect `r`: readable children, then one tile for
   *  everything too small to read or left out by the slice (real share — nothing stretches) */
  const plan = (parent: TreeNode, r: R, top: boolean): TreeNode[] => {
    const all = sized(parent)
    const scale = (r.w * r.h) / Math.max(1, parent.allocSize + (top ? pending : 0))
    const list = all.filter((n) => n.allocSize * scale >= MIN_AREA)
    const rest = parent.allocSize - list.reduce((a, n) => a + n.allocSize, 0)
    if ((parent.hasMore || list.length < all.length) && rest > parent.allocSize * 0.004) list.push(synth(REST_ID, parent, rest))
    // unscanned space goes LAST so real folders grow from the top-left into it
    if (top && pending > 0) list.push(synth(PENDING_ID, parent, pending))
    return list
  }
  const out: Box[] = []
  const root = view.nodes[0]
  const walk = (parent: TreeNode, items: TreeNode[], r: R, depth: number, hue: number, pkey: string) => {
    squarify(items, r, (n, rect) => {
      const g = { x: rect.x + GAP / 2, y: rect.y + GAP / 2, w: rect.w - GAP, h: rect.h - GAP }
      if (g.w < 3 || g.h < 3) return // sub-3px tiles are noise — the parent fill shows through
      if (n.id === PENDING_ID) { out.push({ ...g, key: PENDING_KEY, n, depth: 0, hue: 0, head: false, kind: "pend", path: null }); return }
      if (n.id === REST_ID) { out.push({ ...g, key: `${pkey}\u0002rest`, n, depth, hue, head: false, kind: "rest", path: parent.path, of: parent }); return }
      const key = n.path ?? `${pkey}\u0000${n.name}`
      const h = depth === 0 ? HUES[hash(n.name) % HUES.length] : hue
      const dir = (n.flags & FLAG.DIR) !== 0
      const kind = n.flags & FLAG.AGGREGATED ? "agg" : dir ? "dir" : "file"
      // fold single-child folders into one header instead of a stack of bands
      let end = n
      const chain: TreeNode[] = []
      while (kind === "dir") {
        const k = sized(end)
        if (k.length !== 1 || !(k[0].flags & FLAG.DIR) || k[0].allocSize < end.allocSize * 0.995 || !sized(k[0]).length) break
        end = k[0]
        chain.push(end)
      }
      // a folder only opens up when it has room for its header AND something readable
      // inside; otherwise it's one solid, labelled tile (click to zoom in)
      const ir = { x: g.x + 1, y: g.y + HEAD, w: g.w - 2, h: g.h - HEAD - 1 }
      const inner = kind === "dir" && g.w >= 64 && g.h >= 44 ? plan(end, ir, false) : []
      const sub = inner.some((k) => k.id !== REST_ID)
      out.push({ ...g, key, n, depth, hue: h, head: sub, kind, path: dir ? n.path : joinPath(parent.path, n.name), chain: sub && chain.length ? chain : undefined, inner: sub })
      if (sub) walk(end, inner, ir, depth + 1, h, key)
    })
  }
  if (root) { const r0 = { x: 0, y: 0, w: W, h: H }; walk(root, plan(root, r0, true), r0, 0, 0, root.path ?? "") }
  return out
}

// ============================================================ renderer
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const quart = (t: number) => 1 - Math.pow(1 - t, 4) // long, quiet settle — user-driven moves
const sine = (t: number) => Math.sin((t * Math.PI) / 2) // gentle, no hard stop — live growth
/** One set of tiles moving from → to (fading a0 → a1); `delay` staggers a box (fraction of the run). */
/** `lab`: label tiles every frame (live growth); otherwise only near their final size (zooms, first reveal). */
interface Layer { boxes: Box[]; from: (b: Box) => R; to: (b: Box) => R; a0: number; a1: number; delay?: (b: Box) => number; lab?: boolean }
const ident = (b: Box) => b as R
const mapRect = (r: R, from: R, to: R): R => ({ x: to.x + ((r.x - from.x) / from.w) * to.w, y: to.y + ((r.y - from.y) / from.h) * to.h, w: (r.w / from.w) * to.w, h: (r.h / from.h) * to.h })
const seed = (b: R): R => ({ x: b.x, y: b.y, w: 0, h: 0 }) // grow out of the tile's own top-left corner

function fit(g: CanvasRenderingContext2D, s: string, max: number) {
  if (g.measureText(s).width <= max) return s
  let lo = 0, hi = s.length
  while (lo < hi) { const m = (lo + hi + 1) >> 1; g.measureText(s.slice(0, m) + "…").width <= max ? (lo = m) : (hi = m - 1) }
  return lo ? s.slice(0, lo) + "…" : ""
}

function Treemap({ view, pending, live, sel, onOpen, onSelect, onUp, onRescan }: { view: TreeView; pending: number; live: boolean; sel: string | null; onOpen: (n: TreeNode) => void; onSelect: (n: Box) => void; onUp: (() => void) | null; onRescan: () => void }) {
  const t = useT()
  const wrap = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hov, setHov] = useState<{ b: Box; x: number; y: number } | null>(null)
  const reduced = useReducedMotion()
  const light = ["porcelain", "sandstone"].includes(useSettings((s) => s.style))
  const pendLabel = t("扫描中…", "Scanning…")
  const st = useRef({
    boxes: [] as Box[], focus: null as string | null, layers: [] as Layer[], start: 0, dur: 0, raf: 0, ease: quart,
    hover: null as Box | null, stripes: null as CanvasPattern | null,
    /** fitted label text per tile + width bucket; reset with every new layout */
    fit: new Map<string, string>(),
    /** where every tile of the NEWEST layout is on screen right now — retargets start here */
    cur: new Map<string, R>(),
  })

  useLayoutEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const draw = (p: number) => {
    const c = cv.current
    if (!c) return
    const s = st.current
    const g = c.getContext("2d")!
    const dpr = window.devicePixelRatio || 1
    if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) { c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr); s.stripes = null }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, size.w, size.h)
    if (!s.stripes) {
      const pc = document.createElement("canvas"); pc.width = pc.height = 8
      const pg = pc.getContext("2d")!; pg.strokeStyle = light ? "rgba(0,0,0,.09)" : "rgba(255,255,255,.07)"; pg.lineWidth = 1.2
      pg.beginPath(); pg.moveTo(0, 8); pg.lineTo(8, 0); pg.stroke()
      s.stripes = g.createPattern(pc, "repeat")
    }
    const labels: { b: Box; r: R; a: number }[] = []
    const L = (d: number, kind: Box["kind"]) => light ? (kind === "file" ? 76 : kind === "agg" ? 88 : 91 - d * 4) : (kind === "file" ? 31 : kind === "agg" ? 17 : Math.max(12, 23 - d * 3))
    for (const layer of s.layers) {
      const newest = layer.boxes === s.boxes
      for (const b of layer.boxes) {
        const d = layer.delay?.(b) ?? 0
        const lp = d ? clamp((p - d) / (1 - d), 0, 1) : p
        const e = s.ease(lp)
        const alpha = lerp(layer.a0, layer.a1, e)
        const f = layer.from(b), to = layer.to(b)
        const r = lp >= 1 ? to : { x: lerp(f.x, to.x, e), y: lerp(f.y, to.y, e), w: lerp(f.w, to.w, e), h: lerp(f.h, to.h, e) }
        if (newest) s.cur.set(b.key, r)
        if (alpha <= 0.01 || r.w < 1 || r.h < 1 || r.x > size.w || r.y > size.h || r.x + r.w < 0 || r.y + r.h < 0) continue
        g.globalAlpha = alpha
        // labels go in a second pass on top of every fill (a small folder's name was
        // painted over by its own children); only for tiles near their final size so
        // text never slides around with a zoom
        if (newest && (layer.lab || Math.abs(r.w - b.w) <= Math.max(2, b.w * 0.05)) && Math.abs(r.h - b.h) <= Math.max(2, b.h * 0.05)) labels.push({ b, r, a: alpha })
        if (b.kind === "pend") {
          // unscanned space: a quiet hatched field that shrinks as the scan lands
          g.fillStyle = light ? "rgba(0,0,0,.025)" : "rgba(255,255,255,.025)"
          g.fillRect(r.x, r.y, r.w, r.h)
          if (s.stripes) { g.fillStyle = s.stripes; g.fillRect(r.x, r.y, r.w, r.h) }
          if (r.w > 90 && r.h > 30) {
            g.font = "500 12px 'Segoe UI Variable Text', 'Microsoft YaHei UI', sans-serif"; g.textBaseline = "middle"; g.textAlign = "center"
            g.fillStyle = light ? "rgba(20,20,30,.4)" : "rgba(255,255,255,.4)"
            g.fillText(pendLabel, r.x + r.w / 2, r.y + r.h / 2)
            g.textAlign = "left"
          }
          continue
        }
        if (b.kind === "rest") {
          // what the detail floor folded away: the folder's own tint, hatched
          g.fillStyle = `hsl(${b.hue} ${light ? 22 : 16}% ${light ? 90 : 14}%)`
          g.fillRect(r.x, r.y, r.w, r.h)
          if (s.stripes) { g.fillStyle = s.stripes; g.fillRect(r.x, r.y, r.w, r.h) }
          continue
        }
        const sat = b.kind === "agg" ? 14 : light ? 42 : 34
        g.fillStyle = `hsl(${b.hue} ${sat}% ${L(b.depth, b.kind)}%)`
        g.fillRect(r.x, r.y, r.w, r.h)
        if (b.kind === "agg" && s.stripes) { g.fillStyle = s.stripes; g.fillRect(r.x, r.y, r.w, r.h) }
        if (r.w > 6 && r.h > 6) {
          // bevel: a lit top edge and a shaded bottom edge give the tiles body
          g.fillStyle = light ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.06)"; g.fillRect(r.x, r.y, r.w, 1)
          g.fillStyle = light ? "rgba(0,0,0,.06)" : "rgba(0,0,0,.28)"; g.fillRect(r.x, r.y + r.h - 1, r.w, 1)
        }
        if (b.head && r.h >= 36) {
          g.fillStyle = `hsl(${b.hue} ${light ? 40 : 38}% ${light ? 82 - b.depth * 3 : 30 - b.depth * 2.5}%)`
          g.fillRect(r.x, r.y, r.w, Math.min(HEAD, r.h))
        }
      }
    }
    // ---- label pass
    const ink = (a: number) => (light ? `rgba(20,20,30,${a})` : `rgba(255,255,255,${a})`)
    const fitted = (b: Box, text: string, max: number, font: string) => {
      const k = `${b.key}|${font.length}|${Math.floor(max / 4)}`
      let v = s.fit.get(k)
      if (v === undefined) { v = fit(g, text, max); s.fit.set(k, v) }
      return v
    }
    const F_HEAD = "600 11.5px 'Segoe UI Variable Text', 'Microsoft YaHei UI', sans-serif"
    const F_TILE = "500 11px 'Segoe UI Variable Text', 'Microsoft YaHei UI', sans-serif"
    for (const { b, r, a } of labels) {
      g.globalAlpha = a
      if (b.kind === "rest") {
        if (r.w < 34 || r.h < 17) continue
        g.font = F_TILE; g.textBaseline = "middle"; g.textAlign = "center"
        const txt = r.w > 120 && r.h > 30 ? fitted(b, `${tf("更小的项目", "Smaller items")} · ${bytes(b.n.allocSize, 0)}`, r.w - 12, F_TILE) : fitted(b, bytes(b.n.allocSize, 0), r.w - 8, F_TILE)
        g.fillStyle = ink(0.42); g.fillText(txt, r.x + r.w / 2, r.y + r.h / 2)
        g.textAlign = "left"
        continue
      }
      const nm = b.chain ? [b.n, ...b.chain].map((x) => x.name).join(" › ") : b.n.name
      if (b.head && r.h >= 36) {
        if (r.w < 40) continue
        g.font = F_HEAD; g.textBaseline = "middle"
        const sz = bytes(b.n.allocSize, 0)
        const szW = g.measureText(sz).width
        const room = r.w - 12 - (r.w > szW + 70 ? szW + 8 : 0)
        // a long chain keeps its ends: "orca › … › starfish"
        let name = fitted(b, nm, room, F_HEAD)
        if (b.chain && name !== nm) { const short = `${b.n.name} › … › ${target(b).name}`; name = g.measureText(short).width <= room ? short : fitted(b, target(b).name, room, F_HEAD + "c") }
        g.fillStyle = ink(0.9); g.fillText(name, r.x + 6, r.y + HEAD / 2 + 0.5)
        if (r.w > szW + 70 && name) { g.fillStyle = ink(0.5); g.fillText(sz, r.x + r.w - szW - 6, r.y + HEAD / 2 + 0.5) }
      } else {
        if (r.w < 30 || r.h < 17) continue
        g.font = F_TILE; g.textBaseline = "top"
        const name = fitted(b, nm, r.w - 10, F_TILE)
        if (!name || (name !== nm && name.length < 4)) continue // "1…" says nothing
        g.fillStyle = ink(0.8); g.fillText(name, r.x + 5, r.y + 5)
        if (r.h >= 34 && r.w >= 40) { g.fillStyle = ink(0.46); g.fillText(fitted(b, bytes(b.n.allocSize, 0), r.w - 10, F_TILE + "s"), r.x + 5, r.y + 19) }
      }
    }
    g.globalAlpha = 1
    if (p >= 1) {
      const outline = (b: Box, color: string, wpx: number) => { g.strokeStyle = color; g.lineWidth = wpx; g.strokeRect(b.x + wpx / 2, b.y + wpx / 2, b.w - wpx, b.h - wpx) }
      const sb = sel ? s.boxes.find((b) => b.path === sel || b.key === sel) : null
      if (sb) outline(sb, light ? "rgba(0,0,0,.75)" : "rgba(255,255,255,.95)", 2)
      const hb = s.hover
      if (hb && hb !== sb && hb.kind !== "pend") { g.fillStyle = light ? "rgba(0,0,0,.05)" : "rgba(255,255,255,.07)"; g.fillRect(hb.x, hb.y, hb.w, hb.h); outline(hb, light ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.6)", 1.5) }
    }
  }

  // new data → one continuous motion: live growth, first reveal, zoom in/out or cross-fade
  useEffect(() => {
    if (!size.w || !size.h) return
    const s = st.current
    const prev = s.boxes, prevFocus = s.focus
    const next = layout(view, size.w, size.h, live ? pending : 0)
    const full: R = { x: 0, y: 0, w: size.w, h: size.h }
    const focus = view.focusPath
    const was = new Map(s.cur) // on-screen positions right now (mid-flight included)
    s.boxes = next; s.focus = focus; s.hover = null; s.cur = new Map(); s.fit = new Map(); setHov(null)
    cancelAnimationFrame(s.raf)
    const settle = () => { s.layers = [{ boxes: next, from: ident, to: ident, a0: 1, a1: 1 }]; draw(1) }
    if (reduced) return settle()
    const norm = (p: string | null) => (p ?? "").replace(/\\+$/, "").toLowerCase()
    const nf = norm(focus), pf = norm(prevFocus)
    const realPrev = prev.filter((b) => b.kind !== "pend")
    if (!realPrev.length || prevFocus === null) {
      // first real data (an MFT scan lands whole, or a finished scan opens): the
      // map grows in — every tile unfolds from its corner, outer levels first
      const pend = was.get(PENDING_KEY)
      s.layers = [{ boxes: next, from: (b) => (b.kind === "pend" ? (pend ?? b) : seed(b)), to: ident, a0: 1, a1: 1, delay: (b) => Math.min(0.45, b.depth * 0.09) }]
      s.dur = 1100; s.ease = quart
    } else if (nf === pf) {
      // same folder, fresher data: everything continues from where it is now;
      // new tiles grow out of their corner. Live scans glide with a gentle curve
      // a bit longer than the poll, so the map never stops between updates.
      s.layers = [{ boxes: next, from: (b) => was.get(b.key) ?? seed(b), to: ident, a0: 1, a1: 1, lab: true }]
      s.dur = live ? 900 : 520; s.ease = live ? sine : quart
    } else if (nf.startsWith(pf)) {
      const r = prev.find((b) => norm(b.n.path) === nf) ?? full
      s.layers = [
        { boxes: prev, from: ident, to: (b) => mapRect(b, r, full), a0: 1, a1: 0 },
        { boxes: next, from: (b) => mapRect(b, full, r), to: ident, a0: 0.2, a1: 1 },
      ]
      s.dur = 560; s.ease = quart
    } else if (pf.startsWith(nf)) {
      const r = next.find((b) => norm(b.n.path) === pf) ?? full
      s.layers = [
        { boxes: next, from: (b) => mapRect(b, r, full), to: ident, a0: 0.2, a1: 1 },
        { boxes: prev, from: ident, to: (b) => mapRect(b, full, r), a0: 1, a1: 0 },
      ]
      s.dur = 560; s.ease = quart
    } else {
      s.layers = [{ boxes: prev, from: ident, to: ident, a0: 1, a1: 0 }, { boxes: next, from: ident, to: ident, a0: 0, a1: 1 }]
      s.dur = 420; s.ease = quart
    }
    s.start = performance.now()
    const frame = (now: number) => {
      const p = clamp((now - s.start) / s.dur, 0, 1)
      draw(p)
      if (p < 1) s.raf = requestAnimationFrame(frame)
      else settle()
    }
    s.raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(s.raf)
  }, [view, size.w, size.h, reduced, light, pending, live]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (performance.now() - st.current.start > st.current.dur) draw(1) }, [sel]) // eslint-disable-line react-hooks/exhaustive-deps

  const hit = (x: number, y: number) => {
    let found: Box | null = null
    for (const b of st.current.boxes) if (b.kind !== "pend" && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) found = b // deepest wins (children follow parents)
    return found
  }
  const total = view.nodes[0]?.allocSize || 1
  return (
    <div ref={wrap} className="tm"
      onContextMenu={(e) => {
        const rc = e.currentTarget.getBoundingClientRect()
        const b = hit(e.clientX - rc.left, e.clientY - rc.top)
        const real = b && b.kind !== "rest" ? b : null
        if (real && real.kind !== "dir") onSelect(real)
        const isDir = real?.kind === "dir"
        contextMenu(e, [
          isDir && real.n.path && { label: t("进入", "Open"), icon: <ZoomIn />, onClick: () => onOpen(target(real)) },
          onUp && { label: t("返回上级", "Up one level"), icon: <CornerLeftUp />, hint: "Esc", onClick: onUp },
          real && "sep",
          real && { label: isDir ? t("在资源管理器中打开", "Open in Explorer") : t("在资源管理器中显示", "Show in Explorer"), icon: <FolderOpen />, disabled: !real.path, onClick: () => act(isDir ? api.openFolder(target(real).path ?? real.path!) : api.reveal(real.path!)) },
          real && { label: t("复制路径", "Copy path"), icon: <Copy />, disabled: !real.path, onClick: () => copyPath(isDir ? target(real).path ?? real.path! : real.path!) },
          "sep",
          { label: t("重新扫描", "Rescan"), icon: <RefreshCw />, onClick: onRescan },
        ])
      }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const b = hit(e.clientX - r.left, e.clientY - r.top)
        if (b !== st.current.hover) { st.current.hover = b; if (performance.now() - st.current.start > st.current.dur) draw(1) }
        setHov(b ? { b, x: e.clientX - r.left, y: e.clientY - r.top } : null)
      }}
      onMouseLeave={() => { st.current.hover = null; setHov(null); if (performance.now() - st.current.start > st.current.dur) draw(1) }}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const b = hit(e.clientX - r.left, e.clientY - r.top)
        if (!b) return
        if (b.kind === "rest") { if (b.of?.path && b.of.id !== view.nodes[0]?.id) onOpen(b.of); return }
        if (b.kind === "dir" && b.n.path) onOpen(target(b))
        else onSelect(b)
      }}>
      <canvas ref={cv} style={{ width: size.w, height: size.h }} aria-label={t("磁盘占用树图", "Disk usage treemap")} />
      {hov && (
        <div className="tm-tip" style={{ left: Math.min(hov.x + 16, size.w - 260), top: Math.min(hov.y + 18, size.h - 96) }}>
          <b className="ellipsis">{hov.b.kind === "rest" ? t("更小的项目", "Smaller items") : hov.b.chain ? [hov.b.n, ...hov.b.chain].map((x) => x.name).join(" › ") : hov.b.n.name}</b>
          <span className="num"><span style={{ color: "var(--ink)" }}>{bytes(hov.b.n.allocSize)}</span> · {((hov.b.n.allocSize / total) * 100).toFixed(1)}%</span>
          {hov.b.kind !== "file" && hov.b.kind !== "rest" && <span className="num faint">{hov.b.n.fileCount.toLocaleString()} {t("个文件", "files")}{hov.b.kind === "agg" ? t(" · 已合并的小项目", " · merged small items") : ""}</span>}
          <span className="faint" style={{ fontSize: 11 }}>{hov.b.kind === "rest" ? t("太小无法单独显示的项目 · 单击放大该文件夹，或调低细节密度", "Too small to show one by one · click to zoom into the folder, or lower 细节密度") : hov.b.kind === "dir" ? t("单击进入 · 右键菜单", "Click to open · right-click for more") : t("单击选中 · 右键菜单", "Click to select · right-click for more")}</span>
        </div>
      )}
    </div>
  )
}

// ============================================================ workspace (one per tab)
const KINDS: [RegExp, string, string, string][] = [
  [/\.(mp4|mkv|mov|avi|webm|flv|wmv|m4v)$/i, "--net", "视频", "Video"],
  [/\.(png|jpe?g|gif|bmp|webp|heic|tiff?|psd|raw|dds)$/i, "--disk", "图片", "Image"],
  [/\.(mp3|flac|wav|aac|ogg|m4a|opus)$/i, "--gpu", "音频", "Audio"],
  [/\.(zip|rar|7z|tar|gz|iso|pak|bundle|vpk|cab|vhdx?|vdi|wim|esd)$/i, "--cpu", "压缩/资源包", "Archive"],
  [/\.(exe|dll|sys|msi|bin|so|pdb|lib|node)$/i, "--mem", "程序", "Binary"],
]
const kindOf = (name: string) => KINDS.find(([re]) => re.test(name))

function Workspace({ tab, vol }: { tab: Tab; vol: Volume }) {
  const t = useT()
  const prog = useDisk((s) => s.prog[tab.id])
  const [view, setView] = useState<TreeView | null>(null)
  const [gone, setGone] = useState(false)
  const [top, setTop] = useState<ItemRow[]>([])
  const [side, setSide] = useState<"here" | "files">("here")
  const [max, setMax] = useState(false)
  const [rail, setRail] = useState(true)
  const [sel, setSel] = useState<string | null>(null)
  const scanning = prog?.status === "scanning"
  const used = vol.total - vol.free

  // one in-flight tree fetch at a time; while scanning, refresh ~every 700 ms
  useEffect(() => {
    let live = true, busy = false
    const pull = async () => {
      if (busy) return
      busy = true
      try {
        const v = await api.diskTree(tab.id, tab.focus, { minBytes: minBytesFor(tab.lod), maxNodes: 9000 })
        if (live) { setView(v); setGone(false) }
      } catch { if (live) setGone(true) } finally { busy = false }
    }
    pull()
    const id = scanning ? window.setInterval(pull, 700) : 0
    return () => { live = false; clearInterval(id) }
  }, [tab.id, tab.focus, tab.lod, scanning, prog?.status])
  useEffect(() => {
    let live = true
    api.diskTop(tab.id, tab.focus, 80).then((r) => live && setTop(r)).catch(() => {})
    return () => { live = false }
  }, [tab.id, tab.focus, prog?.status, scanning ? Math.floor((prog?.generation ?? 0) / 8) : 0]) // eslint-disable-line react-hooks/exhaustive-deps

  const root = view?.nodes[0]
  const children = useMemo(() => (view && root ? view.nodes.filter((n) => n.parent === root.id && n.id !== root.id).sort((a, b) => b.allocSize - a.allocSize) : []), [view, root])
  const files = useMemo(() => top.filter((r) => !(r.flags & FLAG.DIR)), [top])
  const crumbs = useMemo(() => {
    const base = vol.root.replace(/\\+$/, "")
    const rest = tab.focus ? tab.focus.replace(/\\+$/, "").slice(base.length).split(/[\\/]/).filter(Boolean) : []
    return [{ name: vol.letter || base, path: null as string | null }, ...rest.map((name, i) => ({ name, path: `${base}\\${rest.slice(0, i + 1).join("\\")}` }))]
  }, [tab.focus, vol])
  const open = (p: string | null) => { setSel(null); patchTab(tab.id, { focus: p }) }
  const up = () => crumbs.length > 1 && open(crumbs[crumbs.length - 2].path)
  const rescan = async () => { setView(null); await api.scanCancel(tab.id).catch(() => {}); await act(api.scanStart([tab.id])) }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === "Escape" && max) return setMax(false)
      if (e.key === "Backspace" || e.key === "Escape") up()
      if (e.key.toLowerCase() === "f" && !e.ctrlKey) setMax((v) => !v)
    }
    const m = (e: MouseEvent) => { if (e.button === 3) up() }
    window.addEventListener("keydown", k); window.addEventListener("mouseup", m)
    return () => { window.removeEventListener("keydown", k); window.removeEventListener("mouseup", m) }
  })

  const pct = used ? clamp(((prog?.bytesAlloc ?? 0) / used) * 100, 0, 100) : 0
  const maxList = (side === "here" ? children[0]?.allocSize : files[0]?.allocSize) || 1
  return (
    <div className="col" style={{ "--gap": "14px" } as CSSProperties}>
      {/* status strip */}
      <div className="panel dstat">
        <div className="col" style={{ "--gap": "3px", minWidth: 0 } as CSSProperties}>
          <span className="row" style={{ "--gap": "10px" } as CSSProperties}><b className="dletter">{vol.letter}</b><span className="ellipsis" style={{ fontWeight: 600 }}>{vol.label || t("本地磁盘", "Local disk")}</span></span>
          <span className="faint num" style={{ fontSize: 12 }}>{vol.fileSystem} · {bytes(used)} / {bytes(vol.total)}</span>
        </div>
        <div className="col grow" style={{ "--gap": "7px", minWidth: 0 } as CSSProperties}>
          <div className="row spread" style={{ fontSize: 12 }}>
            <span className={scanning ? "c-acc row" : "faint row"} style={{ "--gap": "6px" } as CSSProperties}>
              {scanning ? <><i className="dot pulse" />{prog?.currentPath === "(reading $MFT…)" ? t("读取 MFT", "Reading MFT") : t("扫描中", "Scanning")}</> : prog?.status === "done" ? <><Check size={13} className="c-ok" />{t("扫描完成", "Scan complete")}</> : gone ? t("扫描已停止", "Scan stopped") : "—"}
            </span>
            <span className="num dim">{prog ? <>{prog.filesSeen.toLocaleString("en-US")} {t("个文件", "files")} · {bytes(prog.bytesAlloc)} · {(prog.elapsedMs / 1000).toFixed(1)} s</> : ""}</span>
          </div>
          <div className={`dbar ${scanning ? "live" : ""}`}><i style={{ transform: `scaleX(${pct / 100})` }} /></div>
          <span className="mono faint ellipsis" style={{ fontSize: 10.5, height: 14, opacity: scanning ? 1 : 0, transition: "opacity var(--t-med) var(--ease)" }}>{prog?.currentPath}</span>
        </div>
        {scanning
          ? <button className="btn sm" onClick={() => api.scanCancel(tab.id)}><Square size={11} />{t("停止", "Stop")}</button>
          : <button className="btn sm" onClick={rescan}><RefreshCw size={12} />{t("重新扫描", "Rescan")}</button>}
      </div>

      {/* toolbar */}
      <div className="row dtool" style={{ "--gap": "10px" } as CSSProperties}>
        <button className="btn ghost icon sm" onClick={up} disabled={crumbs.length < 2} title={t("上一级 (Backspace)", "Up (Backspace)")}><CornerLeftUp size={14} /></button>
        <div className="crumbs">
          <AnimatePresence initial={false}>
            {crumbs.map((c, i) => (
              <motion.span key={c.path ?? "root"} className="row" style={{ "--gap": "2px" } as CSSProperties} layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6, transition: { duration: 0.12 } }} transition={{ duration: 0.28, ease: EASE }}>
                {i > 0 && <ChevronRight size={13} className="faint" />}
                <button className={`crumb-btn ${i === crumbs.length - 1 ? "on" : ""}`} onClick={() => open(c.path)} disabled={i === crumbs.length - 1}>{c.name}</button>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
        <span className="grow" />
        <span className="faint" style={{ fontSize: 12 }}>{t("细节密度", "Detail")}</span>
        <div style={{ width: 150 }}><Range value={tab.lod} min={1} max={LOD_MAX} onChange={(lod) => patchTab(tab.id, { lod })} /></div>
        <span className="num dim" style={{ fontSize: 12, width: 64 }}>{t(`≥ ${lodLabel(tab.lod, "全部")}`, `≥ ${lodLabel(tab.lod, "all")}`)}</span>
      </div>

      <div className={`dgrid ${rail ? "" : "norail"}`}>
        <div className={`panel tm-panel ${max ? "max" : ""}`}>
          <div className="tm-ctl">
            {max && <span className="tm-crumb">{crumbs.map((c) => c.name).join(" › ")}</span>}
            {!max && <button className="btn ghost icon sm" onClick={() => setRail((v) => !v)} title={rail ? t("收起侧栏", "Hide side panel") : t("展开侧栏", "Show side panel")}>{rail ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}</button>}
            <button className="btn ghost icon sm" onClick={() => setMax((v) => !v)} title={max ? t("还原 (Esc)", "Restore (Esc)") : t("放大 (F)", "Enlarge (F)")}>{max ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
          </div>
          {view ? <Treemap view={view} pending={scanning ? Math.max(0, used - (prog?.bytesAlloc ?? 0)) : 0} live={scanning} sel={sel} onOpen={(n) => open(n.path)} onSelect={(b) => setSel(b.path ?? b.key)} onUp={crumbs.length > 1 ? up : null} onRescan={rescan} />
            : gone ? <Empty title={t("没有扫描数据", "No scan data")} body={t("扫描已停止或已关闭。", "The scan was stopped or closed.")}><button className="btn primary" onClick={rescan}><RefreshCw size={13} />{t("重新扫描", "Rescan")}</button></Empty>
            : <div className="skeleton" style={{ position: "absolute", inset: 10 }} />}
        </div>
        <div className="panel col dside" aria-hidden={!rail}>
          <div className="row spread" style={{ padding: "14px 14px 10px" }}>
            <Seg value={side} onChange={setSide} options={[{ v: "here", label: t("此目录", "This folder") }, { v: "files", label: t("最大文件", "Largest files") }]} />
            <span className="num faint" style={{ fontSize: 12 }}>{root ? bytes(root.allocSize) : ""}</span>
          </div>
          <div className="dlist">
            {(side === "here" ? children.map((n) => ({ key: n.path ?? n.name, name: n.name, path: n.path ?? (n.flags & FLAG.AGGREGATED ? null : joinPath(root?.path ?? view?.focusPath, n.name)), size: n.allocSize, flags: n.flags, files: n.fileCount })) : files.map((r) => ({ key: r.path, name: r.name, path: r.path as string | null, size: r.allocSize, flags: r.flags, files: r.fileCount }))).map((r) => {
              const dir = (r.flags & FLAG.DIR) !== 0
              const agg = (r.flags & FLAG.AGGREGATED) !== 0
              const k = !dir && !agg ? kindOf(r.name) : undefined
              const color = dir ? `hsl(${HUES[hash(r.name) % HUES.length]} 45% 55%)` : k ? `var(${k[1]})` : "var(--ink-3)"
              return (
                <div key={r.key} className={`drow ${sel && sel === r.path ? "on" : ""}`} onClick={() => (dir && r.path && side === "here" ? open(r.path) : setSel(r.path))}
                  onContextMenu={(e) => contextMenu(e, [
                    dir && r.path && side === "here" && { label: t("进入", "Open"), icon: <ZoomIn />, onClick: () => open(r.path) },
                    { label: dir ? t("在资源管理器中打开", "Open in Explorer") : t("在资源管理器中显示", "Show in Explorer"), icon: <FolderOpen />, disabled: !r.path || agg, onClick: () => act(dir ? api.openFolder(r.path!) : api.reveal(r.path!)) },
                    { label: t("复制路径", "Copy path"), icon: <Copy />, disabled: !r.path || agg, onClick: () => copyPath(r.path!) },
                  ])}>
                  <div className="row spread" style={{ "--gap": "8px" } as CSSProperties}>
                    <span className="row" style={{ "--gap": "8px", minWidth: 0 } as CSSProperties}>
                      <i className="sw" style={{ background: color }} />
                      <span className="ellipsis" title={r.path ?? r.name} style={{ color: agg ? "var(--ink-3)" : "var(--ink)" }}>{r.name}</span>
                    </span>
                    <span className="row" style={{ "--gap": "2px", flex: "none" } as CSSProperties}>
                      <span className="num dim" style={{ fontSize: 12 }}>{bytes(r.size)}</span>
                      {r.path && !agg && <button className="btn ghost icon sm" title={dir ? t("在资源管理器中打开", "Open in Explorer") : t("在资源管理器中显示", "Show in Explorer")} onClick={(e) => { e.stopPropagation(); act(dir ? api.openFolder(r.path!) : api.reveal(r.path!)) }}><FolderOpen size={12} /></button>}
                    </span>
                  </div>
                  <div className="dmeter"><i style={{ transform: `scaleX(${r.size / maxList})`, background: color }} /></div>
                </div>
              )
            })}
            {side === "files" && !files.length && <div className="faint" style={{ padding: 16, fontSize: 12.5 }}>{t("这里没有文件", "No files here")}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================ drive picker (the "+" tab)
function Ring({ pct, color }: { pct: number; color: string }) {
  const r = 30, c = 2 * Math.PI * r
  return (
    <svg width="76" height="76" viewBox="0 0 76 76" className="dring">
      <circle cx="38" cy="38" r={r} className="trk" />
      <motion.circle cx="38" cy="38" r={r} stroke={color} strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - pct / 100) }} transition={{ duration: 1.1, ease: EASE }} />
    </svg>
  )
}

function Picker({ vols, onPick }: { vols: Volume[] | null; onPick: (v: Volume) => void }) {
  const t = useT()
  const tabs = useDisk((s) => s.tabs)
  if (!vols) return <div className="grid g3">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 150 }} />)}</div>
  if (!vols.length) return <Panel><Empty icon={<HardDrive size={28} strokeWidth={1.4} />} title={t("没有可扫描的磁盘", "No volumes to scan")} /></Panel>
  return (
    <div className="grid g3">
      {vols.map((v, i) => {
        const used = v.total - v.free
        const pct = v.total ? (used / v.total) * 100 : 0
        const color = pct > 90 ? "var(--crit)" : pct > 75 ? "var(--warn)" : "var(--disk)"
        const opened = tabs.some((x) => x.id === v.scanId)
        return (
          <motion.button key={v.scanId} className="panel dcard rv" disabled={!v.supported} onClick={() => onPick(v)}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE, delay: i * 0.05 } }} whileTap={{ scale: 0.985 }}>
            <div style={{ position: "relative" }}>
              <Ring pct={pct} color={color} />
              <b className="dring-l">{v.letter}</b>
            </div>
            <div className="col" style={{ "--gap": "4px", minWidth: 0, alignItems: "flex-start" } as CSSProperties}>
              <b className="ellipsis" style={{ fontSize: 15 }}>{v.label || t("本地磁盘", "Local disk")}</b>
              <span className="faint" style={{ fontSize: 12 }}>{v.fileSystem} · {v.driveType === "removable" ? t("可移动", "removable") : t("固定", "fixed")}</span>
              <span className="num" style={{ fontSize: 13 }}><b>{bytes(used)}</b> <span className="faint">/ {bytes(v.total)} · {pct.toFixed(0)}%</span></span>
              <span className="dcta">{!v.supported ? t("不支持此文件系统", "Unsupported file system") : opened ? t("切换到此标签", "Switch to tab") : t("扫描", "Scan")} {v.supported && <ChevronRight size={13} />}</span>
            </div>
          </motion.button>
        )
      })}
    </div>
  )
}

// ============================================================ page
const TAB_V = {
  enter: (d: number) => ({ opacity: 0, x: 36 * d }),
  show: { opacity: 1, x: 0, transition: { type: "spring" as const, bounce: 0, visualDuration: 0.42 } },
  exit: (d: number) => ({ opacity: 0, x: -28 * d, transition: { duration: 0.22, ease: EASE_IN } }),
}

export function Disk() {
  const t = useT()
  const vols = useAsync(api.volumes)
  const { tabs, active, prog } = useDisk()
  useEffect(() => {
    const u = on("disk-scan://progress", (p) => useDisk.setState((s) => ({ prog: { ...s.prog, [p.scanId]: p } })))
    // catch up on anything that moved while this page was closed
    for (const tb of useDisk.getState().tabs) api.scanStatus(tb.id).then((p) => useDisk.setState((s) => ({ prog: { ...s.prog, [p.scanId]: p } }))).catch(() => {})
    return () => { u.then((f) => f()) }
  }, [])
  const pick = async (v: Volume) => {
    if (tabs.some((x) => x.id === v.scanId)) return useDisk.setState({ active: v.scanId })
    useDisk.setState((s) => ({ tabs: [...s.tabs, { id: v.scanId, focus: null, lod: 3 }], active: v.scanId }))
    await act(api.scanStart([v.scanId]))
  }
  const close = (id: string) => {
    api.scanCancel(id).catch(() => {}) // also frees the scanned tree
    useDisk.setState((s) => {
      const i = s.tabs.findIndex((x) => x.id === id)
      const rest = s.tabs.filter((x) => x.id !== id)
      const { [id]: _drop, ...p } = s.prog
      return { tabs: rest, prog: p, active: s.active === id ? (rest[Math.max(0, i - 1)]?.id ?? null) : s.active }
    })
  }
  const tab = tabs.find((x) => x.id === active)
  // tab order decides the slide direction ("+" sits at the end)
  const pos = tab ? tabs.indexOf(tab) : tabs.length
  const prevPos = useRef(pos)
  const dir = pos >= prevPos.current ? 1 : -1
  useEffect(() => { prevPos.current = pos }, [pos])
  const vol = vols.data?.find((v) => v.scanId === tab?.id)
  return (
    <Page>
      <PageHead title={t("存储分析", "Storage")} sub={t("基于 MFT 的快速扫描 · 多个标签同时扫描多块磁盘", "Fast MFT-based scanning · scan several drives at once in tabs")} />
      <div className="dtabs" role="tablist">
        {tabs.map((x) => {
          const p = prog[x.id]
          const v = vols.data?.find((y) => y.scanId === x.id)
          const used = v ? v.total - v.free : 0
          const f = p?.status === "scanning" && used ? clamp(p.bytesAlloc / used, 0, 1) : 1
          const on = x.id === active
          return (
            <div key={x.id} role="tab" aria-selected={on} className={`dtab ${on ? "on" : ""}`} onClick={() => useDisk.setState({ active: x.id })}>
              {on && <motion.i className="dtab-hl" layoutId="dtab" transition={GLIDE} />}
              <svg width="16" height="16" viewBox="0 0 16 16" className={`dtab-ring ${p?.status === "scanning" ? "live" : ""}`}>
                <circle cx="8" cy="8" r="6" className="trk" />
                <circle cx="8" cy="8" r="6" className="val" strokeDasharray={37.7} strokeDashoffset={37.7 * (1 - f)} />
              </svg>
              <b>{v?.letter ?? x.id}</b>
              <span className="faint ellipsis">{v?.label || t("本地磁盘", "Local disk")}</span>
              <button className="dtab-x" onClick={(e) => { e.stopPropagation(); close(x.id) }} aria-label={t("关闭标签", "Close tab")}><X size={12} /></button>
            </div>
          )
        })}
        <button className={`dtab add ${!tab ? "on" : ""}`} onClick={() => useDisk.setState({ active: null })} title={t("新标签：选择磁盘", "New tab: pick a drive")}>
          {!tab && <motion.i className="dtab-hl" layoutId="dtab" transition={GLIDE} />}
          <Plus size={14} /><span>{tabs.length ? "" : t("选择磁盘", "Pick a drive")}</span>
        </button>
      </div>
      <div className="dstage">
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div key={tab?.id ?? "+"} custom={dir} variants={TAB_V} initial="enter" animate="show" exit="exit">
            {tab && vol ? <Workspace tab={tab} vol={vol} /> : <Picker vols={vols.data ?? null} onPick={pick} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </Page>
  )
}
