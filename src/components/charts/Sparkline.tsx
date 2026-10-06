import { useId } from "react";

interface SparklineProps {
  data: number[];
  max: number;
  /** Series color (CSS, usually a token: "var(--color-cyan)"). */
  color: string;
  /** Pixel height, or a CSS length like "100%" to fill a flex parent. */
  height?: number | string;
  /** Faint quarter gridlines — for the large charts, not the minis. */
  grid?: boolean;
}

/** Lightweight SVG area sparkline (stretches to container width). */
export function Sparkline({ data, max, color, height = 96, grid }: SparklineProps) {
  const id = useId();
  const n = data.length;

  const points = data.map((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * 100 : 0;
    // Map into [4, 100] so a peak line isn't clipped by the top edge.
    const y = 100 - Math.min(Math.max(v, 0) / max, 1) * 96;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = points.join(" ");
  const area = `0,100 ${line} 100,100`;

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} className="block w-full overflow-hidden" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.24 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {grid &&
        [25, 50, 75].map((y) => (
          <line key={y} x1="0" x2="100" y1={y} y2={y} vectorEffect="non-scaling-stroke" style={{ stroke: "var(--color-line)", strokeWidth: 1 }} />
        ))}
      {n > 1 && (
        <>
          <polygon points={area} fill={`url(#${id})`} />
          <polyline
            points={line}
            fill="none"
            strokeWidth="1.5"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ stroke: color }}
          />
        </>
      )}
    </svg>
  );
}
