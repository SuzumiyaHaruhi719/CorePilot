// Pure helpers: formatting, affinity masks, treemap layout, curve math.

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]
export function bytes(n: number | null | undefined, digits = 1): string {
  if (!isNum(n)) return "—"
  let i = 0
  let v = Math.abs(n)
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
  return `${(n < 0 ? -v : v).toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${UNITS[i]}`
}
/** Split bytes into [value, unit] so the unit can be typeset smaller. */
export function bytesParts(n: number | null | undefined, digits = 1): [string, string] {
  const s = bytes(n, digits)
  const k = s.lastIndexOf(" ")
  return k < 0 ? [s, ""] : [s.slice(0, k), s.slice(k + 1)]
}
export const rate = (n: number | null | undefined) => (isNum(n) ? `${bytes(n)}/s` : "—")
export const fixed = (n: number | null | undefined, d = 0, unit = "") => (isNum(n) ? `${n.toFixed(d)}${unit}` : "—")

export function duration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`
}

// ------------------------------------------------------------ affinity masks
// Masks cross IPC as decimal strings (u64 > 2^53); bigint everywhere here.
export const maskOf = (cpus: Iterable<number>) => {
  let m = 0n
  for (const c of cpus) m |= 1n << BigInt(c)
  return m
}
export const cpusOf = (mask: bigint | string, count: number) => {
  const m = typeof mask === "string" ? BigInt(mask || "0") : mask
  const out: number[] = []
  for (let i = 0; i < count; i++) if ((m >> BigInt(i)) & 1n) out.push(i)
  return out
}

// ------------------------------------------------------------ squarified treemap
export interface Rect { x: number; y: number; w: number; h: number }
/** Bruls et al. squarified layout. `values` must be sorted descending, all > 0. */
export function squarify(values: number[], r: Rect): Rect[] {
  const out: Rect[] = new Array(values.length)
  const total = values.reduce((a, b) => a + b, 0)
  if (!total || r.w <= 0 || r.h <= 0) return values.map(() => ({ x: r.x, y: r.y, w: 0, h: 0 }))
  const scale = (r.w * r.h) / total
  let { x, y, w, h } = r
  let i = 0
  while (i < values.length) {
    const side = Math.min(w, h)
    let j = i
    let sum = 0
    let worst = Infinity
    // grow the row while the worst aspect ratio improves
    while (j < values.length) {
      const a = values[j] * scale
      const s2 = sum + a
      const rowMin = values[j] * scale // descending → last is min
      const rowMax = values[i] * scale
      const wst = Math.max((side * side * rowMax) / (s2 * s2), (s2 * s2) / (side * side * rowMin))
      if (wst > worst) break
      worst = wst
      sum = s2
      j++
    }
    const thick = sum / side
    let off = 0
    for (let k = i; k < j; k++) {
      const len = (values[k] * scale) / thick
      out[k] = w >= h ? { x, y: y + off, w: thick, h: len } : { x: x + off, y, w: len, h: thick }
      off += len
    }
    if (w >= h) { x += thick; w -= thick } else { y += thick; h -= thick }
    i = j
  }
  return out
}

// ------------------------------------------------------------ fan curves
export interface Pt { tempC: number; duty: number }
/** Piecewise-linear duty at `t`, flat beyond the ends (matches the fan engine). */
export function curveAt(curve: Pt[], t: number): number {
  if (!curve.length) return 0
  if (t <= curve[0].tempC) return curve[0].duty
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i]
    if (t <= b.tempC) return a.duty + ((b.duty - a.duty) * (t - a.tempC)) / Math.max(1e-6, b.tempC - a.tempC)
  }
  return curve[curve.length - 1].duty
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

/** Hex `#rrggbb` → packed 0xRRGGBBAA (overlay palette). */
export const rgba32 = (hex: string) => ((parseInt(hex.slice(1, 7), 16) << 8) | 0xff) >>> 0

export const lower = (s: string) => s.trim().toLowerCase()
export const exeBase = (p: string | null | undefined) => (p ? p.split(/[\\/]/).pop()!.toLowerCase() : "")
