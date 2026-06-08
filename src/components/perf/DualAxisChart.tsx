import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { hueColor, isLightTheme } from "../../lib/colors";
import { useSettings } from "../../store/settings";

/**
 * Dual-axis time-series chart for a finished perf session: two series sharing one
 * x-axis but each on its OWN y-scale — the `up` series against the LEFT axis and
 * `down` against the RIGHT — so two metrics of very different magnitude (network
 * upload vs download) are both legible in one chart. Joins the same
 * `uPlot.sync(syncKey)` group + reports the hovered index, exactly like
 * `TimeSeriesChart`, so the report's shared crosshair + tooltip still work.
 */

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

interface DualAxisChartProps {
  /** x-axis values: elapsed seconds per sample (shared across all charts). */
  timesSec: number[];
  /** Left-axis series (e.g. upload); null points are bridged. */
  up: Array<number | null>;
  /** Right-axis series (e.g. download); null points are bridged. */
  down: Array<number | null>;
  upHue: number;
  downHue: number;
  /** Format a y value for both axes' tick labels. */
  format: (v: number) => string;
  height?: number;
  syncKey: string;
  onHover: (idx: number | null) => void;
}

const AXIS_FONT = '10px "Cascadia Mono", ui-monospace, monospace';
const Y_AXIS_SIZE = 54;

/** Canvas axis/grid colors, tuned per theme (canvas can't read CSS vars). */
function chartChrome(): { axis: string; grid: string } {
  return isLightTheme()
    ? { axis: "oklch(42% 0.02 285)", grid: "oklch(20% 0.02 285 / 0.12)" }
    : { axis: "oklch(54% 0.018 265)", grid: "oklch(100% 0 0 / 0.06)" };
}

/** Replace the alpha of an `oklch(L C H)` string. */
function withAlpha(oklch: string, alpha: number): string {
  const inner = oklch.slice(oklch.indexOf("(") + 1, oklch.lastIndexOf(")")).trim();
  return `oklch(${inner} / ${alpha})`;
}

export function DualAxisChart({
  timesSec,
  up,
  down,
  upHue,
  downHue,
  format,
  height = 168,
  syncKey,
  onHover,
}: DualAxisChartProps) {
  const theme = useSettings((s) => s.theme);
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [width, setWidth] = useState(640);

  const onHoverRef = useRef(onHover);
  useEffect(() => {
    onHoverRef.current = onHover;
  }, [onHover]);

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

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const upColor = hueColor(upHue, 74, 0.15);
    const downColor = hueColor(downHue, 74, 0.15);
    const chrome = chartChrome();

    const data: uPlot.AlignedData = [
      Float64Array.from(timesSec),
      Float64Array.from(up.map((v) => (isNum(v) ? v : NaN))),
      Float64Array.from(down.map((v) => (isNum(v) ? v : NaN))),
    ];

    const areaFill = (color: string, top: number) => (u: uPlot) => {
      const grad = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
      grad.addColorStop(0, withAlpha(color, top));
      grad.addColorStop(1, withAlpha(color, 0));
      return grad;
    };

    const opts: uPlot.Options = {
      width,
      height,
      legend: { show: false },
      padding: [10, 6, 2, 6],
      cursor: {
        x: true,
        y: false,
        sync: { key: syncKey, setSeries: false },
        hover: { skip: [undefined, NaN] },
      },
      scales: {
        x: { time: false },
        y: { range: (_u, _min, max) => [0, max <= 0 ? 1 : max * 1.1] },
        y2: { range: (_u, _min, max) => [0, max <= 0 ? 1 : max * 1.1] },
      },
      axes: [
        {
          stroke: chrome.axis,
          grid: { show: false },
          ticks: { show: false },
          font: AXIS_FONT,
          size: 22,
          values: (_u, splits) =>
            splits.map((s) => {
              const t = Math.max(0, Math.round(s));
              return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
            }),
        },
        {
          scale: "y",
          stroke: upColor,
          grid: { stroke: chrome.grid, width: 1 },
          ticks: { show: false },
          font: AXIS_FONT,
          size: Y_AXIS_SIZE,
          values: (_u, splits) => splits.map((v) => format(v)),
        },
        {
          scale: "y2",
          side: 1,
          stroke: downColor,
          grid: { show: false },
          ticks: { show: false },
          font: AXIS_FONT,
          size: Y_AXIS_SIZE,
          values: (_u, splits) => splits.map((v) => format(v)),
        },
      ],
      series: [
        {},
        {
          label: "up",
          scale: "y",
          stroke: upColor,
          width: 1.8,
          fill: areaFill(upColor, 0.26),
          paths: uPlot.paths.spline ? uPlot.paths.spline() : undefined,
          spanGaps: true,
          points: { show: false },
        },
        {
          label: "down",
          scale: "y2",
          stroke: downColor,
          width: 1.8,
          fill: areaFill(downColor, 0.2),
          paths: uPlot.paths.spline ? uPlot.paths.spline() : undefined,
          spanGaps: true,
          points: { show: false },
        },
      ],
      hooks: {
        setCursor: [
          (u) => {
            onHoverRef.current(u.cursor.idx ?? null);
          },
        ],
      },
    };

    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;
    const over = plot.over;
    const onLeave = () => onHoverRef.current(null);
    over.addEventListener("mouseleave", onLeave);

    return () => {
      over.removeEventListener("mouseleave", onLeave);
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timesSec, up, down, upHue, downHue, syncKey, height, theme]);

  useEffect(() => {
    if (plotRef.current) plotRef.current.setSize({ width, height });
  }, [width, height]);

  const hasData = up.some(isNum) || down.some(isNum);
  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {!hasData && (
        <div className="absolute inset-0 grid place-items-center text-[11px] text-dim">无数据</div>
      )}
    </div>
  );
}
