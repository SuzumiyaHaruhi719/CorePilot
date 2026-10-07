import { useEffect, useRef } from "react"
import uPlot from "uplot"
import { useSettings } from "../lib/store"
import { cssVar } from "./kit"

export interface ChartSeries { label: string; color: string; width?: number; fill?: boolean; scale?: string }
/** Thin uPlot wrapper themed from CSS vars; x = seconds from session start. */
export function Chart({ x, ys, series, height = 180, yFmt, sync }: { x: number[]; ys: (number | null)[][]; series: ChartSeries[]; height?: number; yFmt?: (v: number) => string; sync?: string }) {
  const el = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const theme = useSettings((s) => s.theme)

  useEffect(() => {
    const root = el.current!
    const css = (v: string) => cssVar(root, v)
    const axis = { stroke: css("--ink-3"), grid: { stroke: css("--grid"), width: 1 }, ticks: { show: false }, font: "11px Bahnschrift, Segoe UI", gap: 6 }
    const opts: uPlot.Options = {
      width: root.clientWidth,
      height,
      padding: [8, 8, 0, 0],
      cursor: { sync: sync ? { key: sync } : undefined, points: { size: 6 } },
      legend: { show: false },
      scales: { x: { time: false } },
      axes: [
        { ...axis, values: (_u, v) => v.map((s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`) },
        { ...axis, size: 44, values: yFmt ? (_u, v) => v.map(yFmt) : undefined },
      ],
      series: [
        {},
        ...series.map((s) => {
          const c = css(s.color)
          return {
            label: s.label, stroke: c, width: s.width ?? 1.5, scale: s.scale ?? "y", points: { show: false },
            fill: s.fill ? (u: uPlot) => { const g = u.ctx.createLinearGradient(0, 0, 0, u.bbox.height); g.addColorStop(0, c + "40"); g.addColorStop(1, c + "00"); return g } : undefined,
          }
        }),
      ],
    }
    plot.current = new uPlot(opts, [x, ...ys] as uPlot.AlignedData, root)
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: root.clientWidth, height }))
    ro.observe(root)
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null }
  }, [theme, height, series.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { plot.current?.setData([x, ...ys] as uPlot.AlignedData) }, [x, ys])
  return <div ref={el} style={{ width: "100%" }} />
}
