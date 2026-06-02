import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

/**
 * GamePP-style time-series chart for a finished perf session, rendered with
 * uPlot (canvas) for crisp lines and a shared, synced cursor.
 *
 * Visual: smooth spline line + a vertical area-gradient fill, a subtle grid, and
 * dashed avg / min / max reference lines (drawn in a `draw` hook so they sit
 * under the series). A null sample bridges across the gap (spanGaps) so the line
 * never dives to zero.
 *
 * Interaction: every chart in a report joins the same `uPlot.sync(syncKey)`
 * group, so hovering anywhere moves the vertical crosshair to the SAME timestamp
 * on every chart at once. On cursor move the chart reports the hovered sample
 * index up via `onHover`, letting the parent render one shared tooltip listing
 * the full hardware status at that instant. Charts are uncontrolled re-mounts:
 * the data/refs are fixed for a finished session, so the plot is built once and
 * only resized on container width changes.
 */

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

export interface RefLine {
  value: number;
  /** Short prefix shown before the formatted value, e.g. "平均". */
  label: string;
  /** Dim the line/label for secondary references (min/max vs. avg). */
  muted?: boolean;
}

interface TimeSeriesChartProps {
  /** x-axis values: elapsed seconds per sample (shared across all charts). */
  timesSec: number[];
  /** y-values in sample order; null points are bridged. */
  values: Array<number | null>;
  /** Accent hue (oklch) used for line + area gradient. */
  hue: number;
  /** Format a y value for the reference labels + axis ticks. */
  format: (v: number) => string;
  /** Horizontal reference lines (avg / min / max). */
  refLines?: RefLine[];
  /** Pin the y-axis floor to 0 (FPS); other metrics auto-fit their range. */
  zeroFloor?: boolean;
  height?: number;
  /** Cursor-sync group key — identical across all charts in one report. */
  syncKey: string;
  /** Reports the hovered sample index (null when the cursor leaves the plot). */
  onHover: (idx: number | null) => void;
}

const PAD_RIGHT = 56;
// uPlot paints axes/grid/points to <canvas>, which can't resolve CSS custom
// properties (var(--…)) — these must be literal color/font strings. They mirror
// the design tokens (--color-dim, --color-line, --font-mono) by hand.
const AXIS_STROKE = "oklch(54% 0.018 265)";
const GRID_STROKE = "oklch(100% 0 0 / 0.06)";
const POINT_FILL = "oklch(15% 0.014 265)";
const AXIS_FONT = '10px "Cascadia Mono", ui-monospace, monospace';

/** Resolve an oklch line color and a low-alpha fill stop for the gradient. */
function colors(hue: number): { line: string; fill: string } {
  return {
    line: `oklch(74% 0.15 ${hue})`,
    fill: `oklch(74% 0.15 ${hue})`,
  };
}

export function TimeSeriesChart({
  timesSec,
  values,
  hue,
  format,
  refLines = [],
  zeroFloor = false,
  height = 168,
  syncKey,
  onHover,
}: TimeSeriesChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [width, setWidth] = useState(640);

  // Keep the latest onHover in a ref so the (once-built) plot's hook always
  // calls the current callback without forcing a rebuild.
  const onHoverRef = useRef(onHover);
  useEffect(() => {
    onHoverRef.current = onHover;
  }, [onHover]);

  // Width tracking — uPlot needs an explicit pixel size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build the plot once per data identity. For a finished session the inputs are
  // stable, so this runs on mount / when the selected session changes.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const { line, fill } = colors(hue);
    const hasData = values.some(isNum);

    // Cache the latest cursor x-index in CSS px for the ref-line + tooltip hook.
    const refVals = refLines.map((r) => r.value).filter(isNum);

    const data: uPlot.AlignedData = [
      Float64Array.from(timesSec),
      Float64Array.from(values.map((v) => (isNum(v) ? v : NaN))),
    ];

    const opts: uPlot.Options = {
      width,
      height,
      // Compact: no built-in legend/title; we render our own shared tooltip.
      legend: { show: false },
      padding: [10, PAD_RIGHT, 2, 0],
      cursor: {
        // Vertical crosshair only; sync x across the whole report.
        x: true,
        y: false,
        points: { show: true, size: 6, width: 2, stroke: line, fill: POINT_FILL },
        sync: { key: syncKey, setSeries: false },
        // Bridge nulls when scanning for the closest hover index.
        hover: { skip: [undefined, NaN] },
      },
      scales: {
        x: { time: false },
        y: zeroFloor
          ? { range: (_u, _min, max) => [0, max <= 0 ? 1 : max * 1.08] }
          : {
              range: (_u, min, max) => {
                const lo = Math.min(min, ...refVals);
                const hi = Math.max(max, ...refVals);
                const span = hi - lo || 1;
                return [Math.max(0, lo - span * 0.08), hi + span * 0.08];
              },
            },
      },
      axes: [
        {
          stroke: AXIS_STROKE,
          grid: { show: false },
          ticks: { show: false },
          font: AXIS_FONT,
          size: 22,
          // Elapsed seconds → m:ss tick labels.
          values: (_u, splits) =>
            splits.map((s) => {
              const t = Math.max(0, Math.round(s));
              return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
            }),
        },
        {
          stroke: AXIS_STROKE,
          side: 1,
          grid: { stroke: GRID_STROKE, width: 1 },
          ticks: { show: false },
          font: AXIS_FONT,
          size: PAD_RIGHT,
          values: (_u, splits) => splits.map((v) => format(v)),
        },
      ],
      series: [
        {},
        {
          label: "value",
          stroke: line,
          width: 1.8,
          fill: (u) => {
            const ctx = u.ctx;
            const grad = ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
            grad.addColorStop(0, withAlpha(fill, 0.34));
            grad.addColorStop(1, withAlpha(fill, 0));
            return grad;
          },
          paths: uPlot.paths.spline ? uPlot.paths.spline() : undefined,
          spanGaps: true,
          points: { show: false },
        },
      ],
      hooks: {
        // Dashed avg/min/max reference lines, drawn under the series stroke.
        drawClear: [
          (u) => {
            if (!hasData) return;
            const ctx = u.ctx;
            const { left, width: w } = u.bbox;
            ctx.save();
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1 * uPlot.pxRatio;
            for (const r of refLines) {
              if (!isNum(r.value)) continue;
              const y = Math.round(u.valToPos(r.value, "y", true));
              ctx.strokeStyle = r.muted ? "oklch(70% 0.02 265 / 0.5)" : withAlpha(line, 0.85);
              ctx.beginPath();
              ctx.moveTo(left, y);
              ctx.lineTo(left + w, y);
              ctx.stroke();
            }
            ctx.restore();
          },
        ],
        // Report the hovered sample index up to the parent for the shared tooltip.
        setCursor: [
          (u) => {
            const idx = u.cursor.idx ?? null;
            onHoverRef.current(idx);
          },
        ],
      },
    };

    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;

    // Clear the shared tooltip when the pointer leaves this plot.
    const over = plot.over;
    const onLeave = () => onHoverRef.current(null);
    over.addEventListener("mouseleave", onLeave);

    return () => {
      over.removeEventListener("mouseleave", onLeave);
      plot.destroy();
      plotRef.current = null;
    };
    // Rebuild only when the underlying data identity changes (finished session).
    // width is applied via setSize below, not a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timesSec, values, hue, zeroFloor, syncKey]);

  // Apply width changes without tearing down the plot.
  useEffect(() => {
    if (plotRef.current) plotRef.current.setSize({ width, height });
  }, [width, height]);

  const hasData = values.some(isNum);
  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {!hasData && (
        <div className="absolute inset-0 grid place-items-center text-[11px] text-dim">
          无数据
        </div>
      )}
    </div>
  );
}

/** Replace the alpha of an `oklch(L C H)` string, producing `oklch(L C H / a)`. */
function withAlpha(oklch: string, alpha: number): string {
  const inner = oklch.slice(oklch.indexOf("(") + 1, oklch.lastIndexOf(")")).trim();
  return `oklch(${inner} / ${alpha})`;
}
