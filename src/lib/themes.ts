// Theme style presets. CSS tokens live in styles.css under [data-style=…];
// this file holds what JS needs: picker metadata and the per-metric palette
// that also colors the OSD plate, the injected overlay and the taskbar plate.

export type ThemeStyle = "graphite" | "midnight" | "terminal" | "cyberpunk" | "porcelain" | "sandstone"
export type Glow = "off" | "soft" | "medium" | "intense"
export type MetricCat = "fps" | "cpu" | "gpu" | "mem" | "disk" | "net"

export interface StyleDef {
  id: ThemeStyle
  zh: string
  en: string
  descZh: string
  descEn: string
  light: boolean
  /** [page, surface, accent] for the picker miniature */
  swatch: [string, string, string]
}

export const STYLES: StyleDef[] = [
  { id: "cyberpunk", zh: "赛博朋克", en: "Cyberpunk", descZh: "黑 · 黄 · 电光蓝，暗夜街头", descEn: "Black, yellow and electric blue", light: false, swatch: ["#00060e", "#0b2a3d", "#fee801"] },
  { id: "midnight", zh: "午夜", en: "Midnight", descZh: "深邃蓝紫，冷静专注", descEn: "Deep blue-violet, calm focus", light: false, swatch: ["#0a0b1c", "#1a1c3a", "#8b7bff"] },
  { id: "graphite", zh: "石墨", en: "Graphite", descZh: "中性纯黑 + 暖橙，久用不累", descEn: "Neutral black + warm orange", light: false, swatch: ["#0b0b0c", "#1d1d1f", "#ff8a3d"] },
  { id: "terminal", zh: "终端", en: "Terminal", descZh: "近黑 + 磷光绿，极客风", descEn: "Near-black + phosphor green", light: false, swatch: ["#070a08", "#141a16", "#3ee07a"] },
  { id: "porcelain", zh: "瓷白", en: "Porcelain", descZh: "高对比浅色，淡蓝强调", descEn: "High-contrast light, soft blue", light: true, swatch: ["#f7f8fb", "#e8ebf2", "#2f7fd6"] },
  { id: "sandstone", zh: "砂岩", en: "Sandstone", descZh: "暖调浅色，明亮环境更舒适", descEn: "Warm light for bright rooms", light: true, swatch: ["#f8f2e6", "#efe5d2", "#b4561e"] },
]

/** Per-metric palette. The OSD plate is always dark, so light styles use bright variants here. */
export const PALETTE: Record<ThemeStyle, Record<MetricCat, string>> = {
  cyberpunk: { fps: "#ffe600", cpu: "#ffc42e", gpu: "#18c5de", mem: "#11a9e8", disk: "#3b90f0", net: "#5e84f2" },
  midnight: { fps: "#a78bfa", cpu: "#818cf8", gpu: "#5b9bf0", mem: "#4cc6e0", disk: "#c77df0", net: "#5fd0b0" },
  graphite: { fps: "#ff9e47", cpu: "#ff8259", gpu: "#f2b43c", mem: "#4ec9c4", disk: "#5aaee6", net: "#5fd08f" },
  terminal: { fps: "#46e07a", cpu: "#8fe04a", gpu: "#36e0a0", mem: "#3fd9c0", disk: "#d7e04a", net: "#36d6e0" },
  porcelain: { fps: "#5ab0f5", cpu: "#4fc4e6", gpu: "#7a9cf5", mem: "#54c8c0", disk: "#c78cee", net: "#5fcf92" },
  sandstone: { fps: "#f0a24e", cpu: "#f08259", gpu: "#e6b43c", mem: "#6cc78a", disk: "#5aaee6", net: "#f07aa8" },
}

export const GLOW_LEVEL: Record<Glow, number> = { off: 0, soft: 0.45, medium: 1, intense: 1.75 }

/** Native overlay row colors, packed 0xRRGGBBAA in IPC row order:
 *  FPS, FRAMETIME, CPU, GPU, VRAM, RAM, DISK, NET. */
export function overlayPalette(style: ThemeStyle): number[] {
  const p = PALETTE[style] ?? PALETTE.midnight
  const order: MetricCat[] = ["fps", "fps", "cpu", "gpu", "gpu", "mem", "disk", "net"]
  return order.map((c) => ((parseInt(p[c].slice(1), 16) << 8) | 0xff) >>> 0)
}
