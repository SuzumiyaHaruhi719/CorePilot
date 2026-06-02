import { useEffect, useId, useRef, useState } from "react";

/**
 * GamePP-style time-series chart for a finished perf session: filled area +
 * smooth line, subtle grid, and avg / min / max reference lines with labels.
 *
 * Built as a plain SVG drawn in real pixel space (measured via ResizeObserver)
 * so axis labels and reference text stay crisp and never stretch — unlike the
 * live `Sparkline` which uses preserveAspectRatio="none". Null samples are
 * skipped: the line bridges across gaps instead of dropping to zero.
 */

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

interface RefLine {
  value: number;
  /** Short prefix shown before the formatted value, e.g. "平均". */
  label: string;
  /** Dim the line/label for secondary references (min/max vs. avg). */
  muted?: boolean;
}

interface TimeSeriesChartProps {
  /** y-values in sample order; null points are skipped. */
  values: Array<number | null>;
  /** Accent hue (oklch) used for line + area gradient. */
  hue: number;
  /** Format a y value for the reference labels. */
  format: (v: number) => string;
  /** Horizontal reference lines (avg / min / max). */
  refLines?: RefLine[];
  /** Pin the y-axis floor to 0 (FPS); frame-time auto-fits its own range. */
  zeroFloor?: boolean;
  height?: number;
}

const PAD = { top: 12, right: 52, bottom: 6, left: 8 } as const;
const GRID_ROWS = 4;

/** Catmull-Rom → cubic Bézier path for a smooth line through the points. */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export function TimeSeriesChart({
  values,
  hue,
  format,
  refLines = [],
  zeroFloor = false,
  height = 168,
}: TimeSeriesChartProps) {
  const id = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const color = `oklch(74% 0.15 ${hue})`;
  const nums = values.filter(isNum);
  const hasData = nums.length > 0;

  // y-domain: pad ~8% headroom; floor at 0 for FPS, fit-to-data for frame time.
  const dataMin = hasData ? Math.min(...nums) : 0;
  const dataMax = hasData ? Math.max(...nums) : 1;
  const refVals = refLines.map((r) => r.value).filter(isNum);
  const lo0 = Math.min(dataMin, ...refVals);
  const hi0 = Math.max(dataMax, ...refVals);
  const span0 = hi0 - lo0 || 1;
  const yMin = zeroFloor ? 0 : Math.max(0, lo0 - span0 * 0.08);
  const yMax = hi0 + span0 * 0.08 || 1;
  const ySpan = yMax - yMin || 1;

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = Math.max(1, height - PAD.top - PAD.bottom);
  const n = values.length;

  const xAt = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const yAt = (v: number) => PAD.top + (1 - (v - yMin) / ySpan) * innerH;

  // Build the smooth line over only the non-null points (bridges gaps).
  const pts = values
    .map((v, i) => (isNum(v) ? { x: xAt(i), y: yAt(v) } : null))
    .filter((p): p is { x: number; y: number } => p !== null);
  const linePath = smoothPath(pts);
  const areaPath =
    pts.length > 0
      ? `${linePath} L ${pts[pts.length - 1].x.toFixed(2)} ${(PAD.top + innerH).toFixed(2)} L ${pts[0].x.toFixed(2)} ${(PAD.top + innerH).toFixed(2)} Z`
      : "";

  const gridYs = Array.from({ length: GRID_ROWS + 1 }, (_, i) => PAD.top + (i / GRID_ROWS) * innerH);

  return (
    <div ref={wrapRef} className="w-full">
      <svg width={width} height={height} className="block overflow-visible">
        <defs>
          <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.34" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* horizontal grid */}
        {gridYs.map((y, i) => (
          <line
            key={i}
            x1={PAD.left}
            x2={width - PAD.right}
            y1={y}
            y2={y}
            stroke="oklch(100% 0 0 / 0.06)"
            strokeWidth={1}
          />
        ))}

        {hasData && (
          <>
            <path d={areaPath} fill={`url(#fill-${id})`} />
            <path
              d={linePath}
              fill="none"
              stroke={color}
              strokeWidth={1.8}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 4px ${color})` }}
            />
          </>
        )}

        {/* reference lines (avg / min / max) */}
        {hasData &&
          refLines.filter((r) => isNum(r.value)).map((r, i) => {
            const y = yAt(r.value);
            const stroke = r.muted ? "oklch(70% 0.02 265 / 0.5)" : color;
            return (
              <g key={i}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y}
                  y2={y}
                  stroke={stroke}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={r.muted ? 0.7 : 0.9}
                />
                <text
                  x={width - PAD.right + 6}
                  y={y + 3.5}
                  fontSize={10}
                  className="nums"
                  fill={r.muted ? "var(--color-dim)" : "var(--color-muted)"}
                >
                  {r.label ? `${r.label} ${format(r.value)}` : format(r.value)}
                </text>
              </g>
            );
          })}

        {!hasData && (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            fontSize={11}
            fill="var(--color-dim)"
          >
            无数据
          </text>
        )}
      </svg>
    </div>
  );
}
