import { useId } from "react";

interface DualSparklineProps {
  /** Primary series (e.g. upload), scaled to its own max. */
  up: number[];
  /** Secondary series (e.g. download), scaled to its own max. */
  down: number[];
  upColor: string;
  downColor: string;
  height?: number | string;
  grid?: boolean;
}

/**
 * Two-series sparkline with independent vertical scales, so two series of very
 * different magnitude — network upload vs download — both stay legible.
 */
export function DualSparkline({ up, down, upColor, downColor, height = 84, grid }: DualSparklineProps) {
  const upId = useId();
  const downId = useId();
  const upMax = Math.max(...up, 1);
  const downMax = Math.max(...down, 1);

  const toPts = (data: number[], max: number): string => {
    const n = data.length;
    return data
      .map((v, i) => {
        const x = n > 1 ? (i / (n - 1)) * 100 : 0;
        const y = 100 - Math.min(Math.max(v, 0) / max, 1) * 92;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  };
  const upLine = toPts(up, upMax);
  const downLine = toPts(down, downMax);
  const stroke = (c: string) => ({ stroke: c });

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} className="block w-full overflow-hidden" aria-hidden>
      <defs>
        <linearGradient id={upId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: upColor, stopOpacity: 0.18 }} />
          <stop offset="100%" style={{ stopColor: upColor, stopOpacity: 0 }} />
        </linearGradient>
        <linearGradient id={downId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: downColor, stopOpacity: 0.18 }} />
          <stop offset="100%" style={{ stopColor: downColor, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {grid &&
        [25, 50, 75].map((y) => (
          <line key={y} x1="0" x2="100" y1={y} y2={y} vectorEffect="non-scaling-stroke" style={{ stroke: "var(--color-line)", strokeWidth: 1 }} />
        ))}
      <polygon points={`0,100 ${downLine} 100,100`} fill={`url(#${downId})`} />
      <polygon points={`0,100 ${upLine} 100,100`} fill={`url(#${upId})`} />
      <polyline points={downLine} fill="none" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={stroke(downColor)} />
      <polyline points={upLine} fill="none" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={stroke(upColor)} />
    </svg>
  );
}
