import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react"
import { AnimatePresence, motion, useSpring } from "motion/react"
import { createPortal } from "react-dom"
import { create } from "zustand"
import { Check, Inbox } from "lucide-react"
import { celebrate } from "./fx"
import { NAV } from "./nav"
import { motionReduced, sysReduce, useLive, useSettings, useT } from "../lib/store"
import { clamp, isNum } from "../lib/util"

// ------------------------------------------------------------ hooks
/** Interval poll. Pauses while the window is hidden/occluded unless `always`. */
export function usePoll(fn: () => void | Promise<unknown>, ms: number, opts: { always?: boolean; enabled?: boolean } = {}) {
  const visible = useLive((s) => s.visible)
  const ref = useRef(fn)
  ref.current = fn
  const run = opts.enabled !== false && (opts.always || visible)
  useEffect(() => {
    if (!run) return
    let busy = false
    const tick = async () => {
      if (busy) return // never stack calls behind a slow backend
      busy = true
      try { await ref.current() } catch { /* surfaced by callers */ } finally { busy = false }
    }
    tick()
    const id = setInterval(tick, ms)
    return () => clearInterval(id)
  }, [run, ms])
}

/** One-shot async load with reload(). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  const ref = useRef(fn)
  ref.current = fn
  const load = () => {
    setState((s) => ({ ...s, loading: true }))
    return ref.current().then(
      (data) => setState({ data, loading: false }),
      (e) => setState((s) => ({ ...s, error: String(e), loading: false })),
    )
  }
  useEffect(() => { load() }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: load, set: (data: T) => setState({ data, loading: false }) }
}

const subSys = (cb: () => void) => (sysReduce?.addEventListener("change", cb), () => sysReduce?.removeEventListener("change", cb))
export const useReducedMotion = () => {
  useSyncExternalStore(subSys, () => !!sysReduce?.matches)
  const low = useLive((s) => s.lowGpu)
  return useSettings(motionReduced) || low
}

// ------------------------------------------------------------ motion system
// One vocabulary. Nothing bounces for show and nothing floats on hover: things
// move because you moved them, glide without overshoot, and land with a hint
// of mass. CSS mirrors these as --ease / --spring (styles.css).
/** Expo ease-out — entrances and reveals: fast start, long quiet settle. */
export const EASE = [0.16, 1, 0.3, 1] as const
/** Accelerating exit — leaving layers get out of the way quickly. */
export const EASE_IN = [0.4, 0, 1, 1] as const
/** Sheet curve — drawers slide like a physical panel. */
export const SHEET = [0.32, 0.72, 0, 1] as const
/** Indicators (nav pill, segment thumb, highlights): critically damped glide. */
export const GLIDE = { type: "spring", bounce: 0, visualDuration: 0.3 } as const
/** Floating layers (dialogs, toasts, palette) landing with a touch of mass. */
export const SETTLE = { type: "spring", bounce: 0.12, visualDuration: 0.36 } as const

// ------------------------------------------------------------ rolling digits
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
/** Odometer readout: each digit is a 0–9 strip translated into place. */
export function Roll({ value, className }: { value: string; className?: string }) {
  const chars = value.split("")
  return (
    <span className={`roll ${className ?? ""}`} aria-label={value}>
      {chars.map((c, i) => {
        const key = chars.length - i // keyed from the right so units keep identity
        if (c < "0" || c > "9") return <span key={`c${key}`} className="ch">{c}</span>
        return (
          <span key={key} className="d" aria-hidden>
            <span className="s" style={{ transform: `translateY(${-Number(c)}em)` }}>
              {DIGITS.map((d) => <span key={d}>{d}</span>)}
            </span>
          </span>
        )
      })}
    </span>
  )
}

/**
 * Spring-tweened number. Writes textContent imperatively — no React render per
 * frame — and jumps instantly when reduce-motion is on or the window is hidden.
 */
export function AnimatedNumber({ value, digits = 0 }: { value: number; digits?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  const visible = useLive((s) => s.visible)
  const spring = useSpring(value, { stiffness: 140, damping: 22, mass: 0.6, restDelta: digits ? 0.05 : 0.5 })
  useEffect(() => {
    if (reduced || !visible) spring.jump(value)
    else spring.set(value)
  }, [value, reduced, visible, spring])
  useEffect(() => {
    const write = (v: number) => { if (ref.current) ref.current.textContent = v.toFixed(digits) }
    const a = spring.on("change", write)
    const b = spring.on("animationComplete", () => write(value))
    return () => { a(); b() }
  }, [spring, digits, value])
  return <span ref={ref}>{value.toFixed(digits)}</span>
}

export function Readout({ v, u, size, digits = 0, color, mode = "spring" }: { v: number | null | undefined; u?: string; size?: "md" | "sm"; digits?: number; color?: string; mode?: "spring" | "roll" | "static" }) {
  const n = isNum(v)
  return (
    <div className={`readout ${size ?? ""}`}>
      <span className="v" style={color ? { color } : undefined}>
        {!n ? "—" : mode === "roll" ? <Roll value={v.toFixed(digits)} /> : mode === "spring" ? <AnimatedNumber value={v} digits={digits} /> : v.toFixed(digits)}
      </span>
      {u && <span className="u">{u}</span>}
    </div>
  )
}

// ------------------------------------------------------------ layout
export function Panel({ title, color, right, children, className = "", pad = true, style }: { title?: ReactNode; color?: string; right?: ReactNode; children?: ReactNode; className?: string; pad?: boolean; style?: CSSProperties }) {
  return (
    <motion.section
      className={`panel ${pad ? "pad" : ""} ${className}`}
      style={style}
      variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } } }}
    >
      {(title || right) && (
        <header className="ph" style={{ padding: pad ? 0 : "14px 16px 0" }}>
          {title && <span className="label" style={{ "--c": color } as CSSProperties}>{title}</span>}
          {right && <div className="r">{right}</div>}
        </header>
      )}
      {children}
    </motion.section>
  )
}

export function PageHead({ title, sub, actions }: { idx?: string; title: string; sub?: ReactNode; actions?: ReactNode }) {
  const page = useLive((s) => s.page)
  const Icon = NAV.find((n) => n.id === page)?.icon
  return (
    <motion.header className="phead" variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } } }}>
      {Icon && (
        <motion.span className="phead-ic" variants={{ hidden: { scale: 0.6, rotate: -18, opacity: 0 }, show: { scale: 1, rotate: 0, opacity: 1, transition: { ...SETTLE, delay: 0.05 } } }}>
          <Icon size={21} strokeWidth={1.9} />
        </motion.span>
      )}
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </motion.header>
  )
}

/** Page wrapper: staggers its direct motion children in. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <motion.div className="page" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.03 } } }}>
      {children}
    </motion.div>
  )
}

export function Empty({ icon, title, body, children }: { icon?: ReactNode; title: string; body?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Inbox size={28} strokeWidth={1.4} />}
      <b>{title}</b>
      {body && <div style={{ maxWidth: 420 }}>{body}</div>}
      {children}
    </div>
  )
}

// ------------------------------------------------------------ controls
export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  const id = useId()
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.v)} role="radio" aria-checked={o.v === value} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
          {o.v === value && <motion.i className="thumb" layoutId={`seg${id}`} transition={GLIDE} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Range({ value, min, max, step = 1, onChange, color, disabled, onCommit }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: (v: number) => void; color?: string; disabled?: boolean }) {
  const p = ((clamp(value, min, max) - min) / Math.max(1e-9, max - min)) * 100
  return (
    <input
      type="range"
      className="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      style={{ "--p": `${p}%`, "--c": color } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
    />
  )
}

export function Field({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="ft">{title}</div>
      {desc && <div className="fd">{desc}</div>}
      <div className="fc">{children}</div>
    </div>
  )
}

export function Meter({ v, max = 100, color, lg }: { v: number | null | undefined; max?: number; color?: string; lg?: boolean }) {
  const f = isNum(v) ? clamp(v / max, 0, 1) : 0
  return (
    <div className={`meter ${lg ? "lg" : ""}`} style={{ "--c": color } as CSSProperties}>
      <i style={{ transform: `scaleX(${f})` }} />
    </div>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="spin" style={{ animation: "spin .9s linear infinite" }}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** Button that shows a spinner while its async action runs. `fx` (optimization
 *  actions): on success — anything but undefined/false, which is what `act()` returns
 *  on failure — the button flips to a check and sparks fly from it. */
export function AsyncButton({ onClick, children, className = "btn", disabled, title, fx }: { onClick: () => Promise<unknown>; children: ReactNode; className?: string; disabled?: boolean; title?: string; fx?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const click = async () => {
    setBusy(true)
    try {
      const v = await onClick()
      if (fx && v !== undefined && v !== false) {
        celebrate(ref.current)
        setOk(true)
        setTimeout(() => setOk(false), 1400)
      }
    } finally { setBusy(false) }
  }
  return (
    <button ref={ref} className={`${className} ${ok ? "did" : ""}`} title={title} disabled={disabled || busy} onClick={click}>
      {busy && <Spinner size={13} />}
      {ok && <motion.span className="row" initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: SETTLE }}><Check size={14} strokeWidth={2.8} /></motion.span>}
      {children}
    </button>
  )
}

/** Page dialogs render here, above the whole shell: inside a page they sat in the
 *  page's stacking layer, under the titlebar (the dialog's top was cut off). */
export const Layer = ({ children }: { children: ReactNode }) => createPortal(children, document.body)

// ------------------------------------------------------------ confirm dialog
interface Ask { title: string; body?: ReactNode; ok: string; danger?: boolean; resolve: (v: boolean) => void }
const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }))
export function confirmDialog(o: Omit<Ask, "resolve">): Promise<boolean> {
  return new Promise((resolve) => useAsk.setState({ ask: { ...o, resolve } }))
}
export function ConfirmHost() {
  const ask = useAsk((s) => s.ask)
  const t = useT()
  const done = (v: boolean) => { ask?.resolve(v); useAsk.setState({ ask: null }) }
  useEffect(() => {
    if (!ask) return
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") done(false); if (e.key === "Enter") done(true) }
    window.addEventListener("keydown", k)
    return () => window.removeEventListener("keydown", k)
  })
  return (
    <AnimatePresence>
      {ask && (
        <>
          <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.2 } }} exit={{ opacity: 0, transition: { duration: 0.14 } }} onClick={() => done(false)} />
          <motion.div className="modal" role="alertdialog" initial={{ opacity: 0, scale: 0.97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0, transition: SETTLE }} exit={{ opacity: 0, scale: 0.98, y: 4, transition: { duration: 0.12, ease: EASE_IN } }}>
            <h3>{ask.title}</h3>
            {ask.body && <p>{ask.body}</p>}
            <div className="row end">
              <button className="btn ghost" onClick={() => done(false)}>{t("取消", "Cancel")}</button>
              <button className={`btn ${ask.danger ? "danger" : "primary"}`} autoFocus onClick={() => done(true)}>{ask.ok}</button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

// ------------------------------------------------------------ context menu
export interface MenuItem { label: string; icon?: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean; hint?: string }
type MenuEntry = MenuItem | "sep" | false | "" | 0 | null | undefined
const useMenu = create<{ menu: { x: number; y: number; items: (MenuItem | "sep")[] } | null }>(() => ({ menu: null }))
/** Open the app's right-click menu at the pointer. Falsy entries are skipped. */
export function contextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, entries: MenuEntry[]) {
  e.preventDefault()
  e.stopPropagation()
  // drop leading, trailing and doubled separators left by entries that didn't apply
  const items: (MenuItem | "sep")[] = []
  for (const it of entries) if (it && !(it === "sep" && (!items.length || items[items.length - 1] === "sep"))) items.push(it)
  if (items[items.length - 1] === "sep") items.pop()
  if (items.length) useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items } })
}
export function MenuHost() {
  const menu = useMenu((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number; ox: string } | null>(null)
  const close = () => useMenu.setState({ menu: null })
  // flip at the window edges; the origin follows so it grows out of the pointer
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null)
    const w = ref.current.offsetWidth, h = ref.current.offsetHeight
    const left = menu.x + w > innerWidth - 8, up = menu.y + h > innerHeight - 8
    setPos({ x: left ? Math.max(8, menu.x - w) : menu.x, y: up ? Math.max(8, menu.y - h) : menu.y, ox: `${left ? "right" : "left"} ${up ? "bottom" : "top"}` })
  }, [menu])
  useEffect(() => {
    if (!menu) return
    // capture: Esc closes the menu without also popping a treemap level / exiting focus
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); close() } }
    addEventListener("keydown", key, true)
    addEventListener("pointerdown", close)
    addEventListener("blur", close)
    addEventListener("resize", close)
    addEventListener("wheel", close, { passive: true })
    return () => {
      removeEventListener("keydown", key, true)
      removeEventListener("pointerdown", close)
      removeEventListener("blur", close)
      removeEventListener("resize", close)
      removeEventListener("wheel", close)
    }
  }, [menu])
  return (
    <AnimatePresence>
      {menu && (
        <motion.div ref={ref} key={`${menu.x},${menu.y}`} className="cmenu" role="menu"
          style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, transformOrigin: pos?.ox, visibility: pos ? "visible" : "hidden" }}
          initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1, transition: { duration: 0.16, ease: EASE } }} exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1, ease: EASE_IN } }}
          onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          {menu.items.map((it, i) => it === "sep" ? <hr key={i} /> : (
            <button key={i} role="menuitem" className={it.danger ? "danger" : ""} disabled={it.disabled} onClick={() => { close(); it.onClick?.() }}>
              <span className="ic">{it.icon}</span><span className="grow ellipsis">{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ------------------------------------------------------------ virtual list
/** Fixed-row-height windowing; renders only rows in view (+overscan). */
/** Virtual list. `flip` = the sort (key + direction): when it changes, rows that stay
 *  on screen glide to their new spot and newly revealed rows cascade in — for a
 *  moment only, so scrolling and live re-sorts don't animate. `onScrollX` lets a
 *  sticky header outside the scroller follow horizontal scrolling. */
export function VList<T>({ items, row, height = 36, render, className, style, flip, onScrollX }: { items: T[]; row?: (t: T) => string | number; height?: number; render: (t: T, i: number) => ReactNode; className?: string; style?: CSSProperties; flip?: string | number; onScrollX?: (x: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const flipAt = useRef({ v: flip, at: 0 })
  if (flipAt.current.v !== flip) flipAt.current = { v: flip, at: performance.now() }
  const animating = performance.now() - flipAt.current.at < 700
  const [top, setTop] = useState(0)
  const [vh, setVh] = useState(600)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setVh(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const start = Math.max(0, Math.floor(top / height) - 8)
  const end = Math.min(items.length, Math.ceil((top + vh) / height) + 8)
  return (
    <div ref={ref} className={`scroller ${className ?? ""}`} style={{ overflow: "auto", ...style }} onScroll={(e) => { setTop(e.currentTarget.scrollTop); onScrollX?.(e.currentTarget.scrollLeft) }}>
      <div style={{ height: items.length * height, position: "relative" }}>
        <div style={{ position: "absolute", top: start * height, left: 0, right: 0 }}>
          {items.slice(start, end).map((it, k) => (
            <motion.div key={row ? row(it) : start + k} layout={animating && row ? "position" : false} transition={{ layout: GLIDE }}
              initial={animating ? { opacity: 0, y: 10 } : false} animate={{ opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE, delay: Math.min(k, 18) * 0.014 } }}>
              {render(it, start + k)}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ scope (live chart)
export interface Trace { data: number[]; color: string; fill?: boolean; width?: number }
/** Resolve "--x" or "var(--x)" to its computed value (canvas needs real colors). */
export const cssVar = (el: Element, v: string) => {
  const k = v.startsWith("var(") ? v.slice(4, -1) : v
  return k.startsWith("--") ? getComputedStyle(el).getPropertyValue(k).trim() : v
}

/**
 * Oscilloscope-style live chart. Each new sample adds one step of pending
 * scroll that drains at ~one sample per interval — slightly slower than the
 * poll, so the glide never stalls waiting for a late sample; unfinished
 * distance carries into the next one (no jump, no pause). rAF runs only while
 * distance remains. The graticule scrolls with the data.
 */
export function Scope({ traces, max, height = 120, tick, interval: ivProp, points = 120, grid = true }: { traces: Trace[]; max?: number; height?: number; tick: number; interval?: number; points?: number; grid?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const anim = useRef({ shift: 0, last: 0, raf: 0, tick: -1 })
  const reduced = useReducedMotion()
  const theme = useSettings((s) => s.style)
  const interval = ivProp ?? useSettings((s) => s.pollMs) // eslint-disable-line react-hooks/rules-of-hooks
  const visible = useLive((s) => s.visible)
  const data = useRef({ traces, max, tick })
  data.current = { traces, max, tick }

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext("2d")!
    // hex only (#rrggbb) — alpha suffixes are appended below
    const colors = data.current.traces.map((t) => cssVar(cv, t.color))
    const gridColor = cssVar(cv, "--grid")

    const draw = (shift: number) => {
      const dpr = window.devicePixelRatio || 1
      const w = cv.clientWidth, h = cv.clientHeight
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const { traces, max, tick } = data.current
      const step = w / (points - 1)
      const top = max ?? Math.max(1, ...traces.flatMap((t) => t.data)) * 1.15
      const y = (v: number) => h - 2 - (clamp(v, 0, top) / top) * (h - 6)
      if (grid) {
        ctx.strokeStyle = gridColor
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let k = 1; k < 4; k++) { const gy = Math.round((h * k) / 4) + 0.5; ctx.moveTo(0, gy); ctx.lineTo(w, gy) }
        // vertical graticule pinned to absolute sample index → scrolls with data
        for (let s = tick - (tick % 10); s > tick - points - 10; s -= 10) {
          const gx = Math.round(w - (tick - s - shift) * step) + 0.5
          if (gx >= 0 && gx <= w) { ctx.moveTo(gx, 0); ctx.lineTo(gx, h) }
        }
        ctx.stroke()
      }
      traces.forEach((t, ti) => {
        const d = t.data
        if (d.length < 2) return
        const xs = (i: number) => w - (d.length - 1 - i - shift) * step
        ctx.beginPath()
        ctx.moveTo(xs(0), y(d[0]))
        for (let i = 1; i < d.length; i++) {
          const mx = (xs(i - 1) + xs(i)) / 2
          ctx.quadraticCurveTo(xs(i - 1), y(d[i - 1]), mx, (y(d[i - 1]) + y(d[i])) / 2)
        }
        ctx.lineTo(xs(d.length - 1), y(d[d.length - 1]))
        ctx.strokeStyle = colors[ti]
        ctx.lineWidth = t.width ?? 1.6
        ctx.lineJoin = "round"
        ctx.stroke()
        if (t.fill) {
          ctx.lineTo(xs(d.length - 1), h)
          ctx.lineTo(xs(0), h)
          ctx.closePath()
          const g = ctx.createLinearGradient(0, 0, 0, h)
          g.addColorStop(0, colors[ti] + "26")
          g.addColorStop(1, colors[ti] + "00")
          ctx.fillStyle = g
          ctx.fill()
        }
        const lx = xs(d.length - 1), ly = y(d[d.length - 1])
        if (lx <= w + 1) {
          ctx.beginPath(); ctx.arc(lx, ly, 5, 0, Math.PI * 2); ctx.fillStyle = colors[ti] + "30"; ctx.fill()
          ctx.beginPath(); ctx.arc(lx, ly, 2.2, 0, Math.PI * 2); ctx.fillStyle = colors[ti]; ctx.fill()
        }
      })
    }
    ;(cv as unknown as { __draw: typeof draw }).__draw = draw
    const ro = new ResizeObserver(() => draw(anim.current.shift))
    ro.observe(cv)
    draw(anim.current.shift)
    return () => { ro.disconnect(); cancelAnimationFrame(anim.current.raf) }
  }, [theme, points, grid]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cv = ref.current as unknown as { __draw?: (s: number) => void } | null
    const draw = cv?.__draw
    if (!draw) return
    const a = anim.current
    cancelAnimationFrame(a.raf)
    if (reduced || !visible) { a.shift = 0; a.tick = tick; draw(0); return }
    if (tick !== a.tick) { a.shift = Math.min(a.shift + 1, 3); a.tick = tick }
    a.last = performance.now()
    const frame = (now: number) => {
      const dt = now - a.last
      a.last = now
      // ~6% slower than the poll; proportional catch-up once more than a step behind
      a.shift = Math.max(0, a.shift - (dt / interval) * 0.94 * Math.max(1, a.shift))
      draw(a.shift)
      if (a.shift > 0) a.raf = requestAnimationFrame(frame)
    }
    a.raf = requestAnimationFrame(frame)
  }, [tick, reduced, visible, interval])

  return <div className="scope" style={{ height }}><canvas ref={ref} /></div>
}

/** Tiny static sparkline (SVG) for table cells / cards. */
export function Spark({ data, color, w = 80, h = 22, max }: { data: number[]; color: string; w?: number; h?: number; max?: number }) {
  if (data.length < 2) return <svg width={w} height={h} />
  const top = max ?? Math.max(1, ...data)
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 1 - (clamp(v, 0, top) / top) * (h - 2)).toFixed(1)}`)
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

/** Task-Manager-style mini graph: framed, gridded, filled, always full width. The
 *  window is a fixed `points` slots and samples enter at the right edge, so a short
 *  history reads as "just started" instead of a 3-point line stretched across. */
export function Mini({ data, color, max = 100, points = 60, h = 40 }: { data: number[]; color: string; max?: number; points?: number; h?: number }) {
  const d = data.slice(-points)
  const x0 = points - d.length
  const y = (v: number) => (100 - (clamp(v, 0, max) / max) * 96).toFixed(2)
  const line = d.map((v, i) => `${i ? "L" : "M"}${x0 + i},${y(v)}`).join("")
  return (
    <svg className="mini" viewBox={`0 0 ${points - 1} 100`} preserveAspectRatio="none" style={{ height: h, "--c": color } as CSSProperties}>
      {d.length > 1 && <>
        <path d={`${line}L${points - 1},100L${x0},100Z`} className="mini-fill" />
        <path d={line} className="mini-line" vectorEffect="non-scaling-stroke" />
      </>}
    </svg>
  )
}

/**
 * Variants for any wrapper that mounts after the page entrance. Children
 * (Panel/PageHead) animate via inherited "hidden"/"show" labels, so a wrapper
 * with plain object animate props would leave them stuck invisible.
 */
export const swapVariants = (dx = 0, dy = 6) => ({
  hidden: { opacity: 0, x: dx, y: dy },
  show: { opacity: 1, x: 0, y: 0, transition: { duration: 0.3, ease: EASE, staggerChildren: 0.03 } },
  exit: { opacity: 0, x: -dx, y: -dy / 2, transition: { duration: 0.12, ease: EASE_IN } },
})
const SWAP = swapVariants()

/** Animated presence helper for swapping content blocks. */
export function Swap({ k, children }: { k: string | number; children: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={k} variants={SWAP} initial="hidden" animate="show" exit="exit">
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
