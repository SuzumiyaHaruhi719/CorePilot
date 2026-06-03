import { useId } from "react";

interface DualSparklineProps {
  /** Primary series, drawn against the LEFT axis (e.g. upload). */
  up: number[];
  /** Secondary series, drawn against the RIGHT axis (e.g. download). */
  down: number[];
  upHue: number;
  downHue: number;
  height?: number;
}

/**
 * Two-series sparkline with independent (dual) vertical scales: `up` is scaled to
 * its own max (labelled on the LEFT) and `down` to its own max (labelled on the
 * RIGHT), so two series of very different magnitude — e.g. network upload vs
 * download — are both legible in one compact chart.
 *
 * The SVG uses `preserveAspectRatio="none"` (so it stretches to the container and
 * can't host text without distortion); the axis-max labels are HTML overlays
 * pinned to the top corners.
 */
export function DualSparkline({
  up,
  down,
  upHue,
  downHue,
  height = 84,
}: DualSparklineProps) {
  const upId = useId();
  const downId = useId();
  const upColor = `oklch(72% 0.15 ${upHue})`;
  const downColor = `oklch(72% 0.15 ${downHue})`;
  const upMax = Math.max(...up, 1);
  const downMax = Math.max(...down, 1);

  const toPts = (data: number[], max: number): string => {
    const n = data.length;
    return data
      .map((v, i) => {
        const x = n > 1 ? (i / (n - 1)) * 100 : 0;
        // Map into [12, 100] (top inset) so peak glow has room and labels don't overlap.
        const y = 100 - Math.min(Math.max(v, 0) / max, 1) * 88;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  };
  const upLine = toPts(up, upMax);
  const downLine = toPts(down, downMax);

  return (
    <div className="relative w-full" style={{ height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-hidden">
        <defs>
          <linearGradient id={upId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={upColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={upColor} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={downId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={downColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={downColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,100 ${downLine} 100,100`} fill={`url(#${downId})`} />
        <polygon points={`0,100 ${upLine} 100,100`} fill={`url(#${upId})`} />
        <polyline
          points={downLine}
          fill="none"
          stroke={downColor}
          strokeWidth="1.6"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{ filter: `drop-shadow(0 0 3px ${downColor})` }}
        />
        <polyline
          points={upLine}
          fill="none"
          stroke={upColor}
          strokeWidth="1.6"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{ filter: `drop-shadow(0 0 3px ${upColor})` }}
        />
      </svg>
    </div>
  );
}
