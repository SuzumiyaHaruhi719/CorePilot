import { useId } from "react";
import { hueColor, isLightTheme } from "../../lib/colors";

interface SparklineProps {
  data: number[];
  max: number;
  hue: number;
  /** Pixel height, or a CSS length like "100%" to fill a flex parent. */
  height?: number | string;
}

/** Lightweight SVG area sparkline (stretches to container width). */
export function Sparkline({ data, max, hue, height = 96 }: SparklineProps) {
  const id = useId();
  const n = data.length;
  const color = hueColor(hue, 72, 0.15);
  // The neon drop-shadow reads as a muddy smear on light surfaces — drop it there.
  const glow = isLightTheme() ? "none" : `drop-shadow(0 0 4px ${color})`;

  const points = data.map((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * 100 : 0;
    // Map into [6, 100] (top inset) so a peak line's glow has room inside the box
    // and isn't harshly clipped at the top edge once we clip overflow.
    const y = 100 - Math.min(Math.max(v, 0) / max, 1) * 94;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = points.join(" ");
  const area = `0,100 ${line} 100,100`;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ height }}
      className="w-full overflow-hidden"
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
        style={{ filter: glow }}
      />
    </svg>
  );
}
