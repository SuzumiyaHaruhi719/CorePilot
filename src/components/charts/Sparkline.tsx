import { useId } from "react";

interface SparklineProps {
  data: number[];
  max: number;
  hue: number;
  height?: number;
}

/** Lightweight SVG area sparkline (stretches to container width). */
export function Sparkline({ data, max, hue, height = 96 }: SparklineProps) {
  const id = useId();
  const n = data.length;
  const color = `oklch(72% 0.15 ${hue})`;

  const points = data.map((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * 100 : 0;
    const y = 100 - Math.min(Math.max(v, 0) / max, 1) * 100;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = points.join(" ");
  const area = `0,100 ${line} 100,100`;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ height }}
      className="w-full overflow-visible"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.42" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  );
}
