// Celebration effects for optimization actions: sparks + a shockwave ring drawn on
// one shared full-window canvas. The canvas exists only while particles are alive
// (rAF stops, element removed), so idle cost is zero. Skipped under reduced motion.

interface P { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; kind: "spark" | "dot" | "ring"; r?: number }

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let parts: P[] = []
let raf = 0

const reduced = () => document.documentElement.dataset.motion === "reduced"
/** additive glow on dark themes, plain paint on light ones (set per burst) */
let blend: GlobalCompositeOperation = "lighter"

function palette(): string[] {
  const cs = getComputedStyle(document.documentElement)
  return ["--acc", "--acc-2", "--ok", "--cpu", "--gpu", "--mem"].map((v) => cs.getPropertyValue(v).trim()).filter(Boolean)
}

function ensure() {
  if (canvas) return
  canvas = document.createElement("canvas")
  canvas.className = "fx-canvas"
  document.body.appendChild(canvas)
  ctx = canvas.getContext("2d")
  size()
  addEventListener("resize", size)
}
function size() {
  if (!canvas || !ctx) return
  const dpr = devicePixelRatio || 1
  canvas.width = innerWidth * dpr
  canvas.height = innerHeight * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}
function teardown() {
  removeEventListener("resize", size)
  canvas?.remove()
  canvas = ctx = null
  raf = 0
}

function frame() {
  try { draw() } catch { parts = [] } // a drawing error must never leave a frozen frame on screen
  raf = parts.length ? requestAnimationFrame(frame) : (teardown(), 0)
}

function draw() {
  if (!ctx || !canvas) return
  ctx.clearRect(0, 0, innerWidth, innerHeight)
  ctx.globalCompositeOperation = blend
  parts = parts.filter((p) => ++p.life < p.max)
  for (const p of parts) {
    if (p.life < 0) continue // delayed (second shockwave)
    const k = 1 - p.life / p.max // 1 → 0
    if (p.kind === "ring") {
      // shockwave: fast ease-out radius, thinning stroke
      const e = 1 - Math.pow(k, 3)
      ctx.strokeStyle = p.color
      ctx.globalAlpha = k * 0.75
      ctx.lineWidth = 1 + 3 * k
      ctx.beginPath()
      ctx.arc(p.x, p.y, 6 + e * p.r!, 0, Math.PI * 2)
      ctx.stroke()
      continue
    }
    p.vx *= 0.955
    p.vy = p.vy * 0.955 + 0.09 // drag + a little gravity
    p.x += p.vx
    p.y += p.vy
    ctx.globalAlpha = Math.min(1, k * 1.6)
    if (p.kind === "spark") {
      ctx.strokeStyle = p.color
      ctx.lineWidth = p.size
      ctx.lineCap = "round"
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(p.x - p.vx * 3.2, p.y - p.vy * 3.2)
      ctx.stroke()
    } else {
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size * (0.4 + k * 0.6), 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

/** Sparks flying out of (x, y). `power` scales count, speed and the shockwave. */
export function burst(x: number, y: number, power = 1, colors = palette()) {
  if (reduced() || !colors.length) return
  blend = getComputedStyle(document.documentElement).colorScheme === "light" ? "source-over" : "lighter"
  ensure()
  const n = Math.round(18 + 34 * power)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const v = (1.6 + Math.random() * 4.6) * (0.7 + power * 0.5)
    parts.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.2 * power,
      life: 0, max: 38 + Math.random() * 34 * (0.6 + power * 0.4),
      size: 1 + Math.random() * 1.8, color: colors[i % colors.length], kind: Math.random() < 0.62 ? "spark" : "dot",
    })
  }
  parts.push({ x, y, vx: 0, vy: 0, life: 0, max: 34 + 14 * power, size: 0, color: colors[0], kind: "ring", r: 14 + 110 * power })
  if (power >= 1) parts.push({ x, y, vx: 0, vy: 0, life: -8, max: 44 + 14 * power, size: 0, color: colors[2] ?? colors[0], kind: "ring", r: 70 + 130 * power })
  if (!raf) raf = requestAnimationFrame(frame)
}

/** Celebrate a finished optimization on an element: sparks from its center, plus a
 *  light sweep across the surrounding card (CSS `.fx-swept`). */
export function celebrate(el: Element | null, power = 0.45) {
  if (!el) return
  const r = el.getBoundingClientRect()
  burst(r.left + r.width / 2, r.top + r.height / 2, power)
  const card = el.closest(".fx-card")
  if (card && !reduced()) {
    card.classList.remove("fx-swept")
    void (card as HTMLElement).offsetWidth // restart the animation
    card.classList.add("fx-swept")
    setTimeout(() => card.classList.remove("fx-swept"), 1300)
  }
}
