import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { FanCurvePoint } from "../../lib/ipc";

interface FanCurveEditorProps {
  points: FanCurvePoint[];
  onChange: (points: FanCurvePoint[]) => void;
  /** Live operating point (current temp °C → resulting duty %), drawn as a marker. */
  live?: { tempC: number; duty: number } | null;
  /** Minimum duty floor (drawn as a shaded band; points can't go below it). */
  minDuty?: number;
}

const HEIGHT = 200;
const PAD = 26;
const TEMP_MAX = 100;

/** A draggable temperature→duty fan-curve editor (FanXpert-style). X axis is
 *  temperature (0–100 °C), Y axis is duty (0–100%). Drag points to reshape. */
export function FanCurveEditor({ points, onChange, live, minDuty = 0 }: FanCurveEditorProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(420);
  const [dragging, setDragging] = useState<number | null>(null);

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

  const innerW = Math.max(1, width - PAD * 2);
  const innerH = HEIGHT - PAD * 2;

  const xToPx = (temp: number) => PAD + (temp / TEMP_MAX) * innerW;
  const yToPx = (duty: number) => PAD + (1 - duty / 100) * innerH;
  const pxToTemp = (px: number) => Math.max(0, Math.min(TEMP_MAX, ((px - PAD) / innerW) * TEMP_MAX));
  const pxToDuty = (py: number) => Math.max(0, Math.min(100, (1 - (py - PAD) / innerH) * 100));

  const sorted = [...points].sort((a, b) => a.tempC - b.tempC);
  const linePath = sorted.map((p) => `${xToPx(p.tempC)},${yToPx(p.duty)}`).join(" ");
  // Closed area under the curve for a soft telemetry fill.
  const areaPath =
    sorted.length > 0
      ? `${xToPx(sorted[0].tempC)},${HEIGHT - PAD} ${linePath} ${xToPx(sorted[sorted.length - 1].tempC)},${HEIGHT - PAD}`
      : "";

  function moveTo(clientX: number, clientY: number) {
    if (dragging === null) return;
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const i = dragging;
    let temp = Math.round(pxToTemp(clientX - rect.left));
    let duty = Math.round(pxToDuty(clientY - rect.top));

    // Keep temperature ordering: stay strictly between neighbours (1° gap).
    const lo = i > 0 ? sorted[i - 1].tempC + 1 : 0;
    const hi = i < sorted.length - 1 ? sorted[i + 1].tempC - 1 : TEMP_MAX;
    temp = Math.max(lo, Math.min(hi, temp));
    duty = Math.max(Math.round(minDuty), Math.min(100, duty));

    const next = sorted.map((p, idx) => (idx === i ? { tempC: temp, duty } : p));
    onChange(next);
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (dragging === null) return;
    moveTo(e.clientX, e.clientY);
  }

  function endDrag(e: ReactPointerEvent<SVGSVGElement>) {
    if (dragging !== null) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      setDragging(null);
    }
  }

  const floorY = yToPx(minDuty);
  const liveX = live ? xToPx(Math.max(0, Math.min(TEMP_MAX, live.tempC))) : 0;
  const liveY = live ? yToPx(Math.max(0, Math.min(100, live.duty))) : 0;

  return (
    <div
      ref={wrapRef}
      className="hud-frame no-drag w-full select-none overflow-hidden rounded-xl border border-line bg-surface2/30"
    >
      <svg
        width={width}
        height={HEIGHT}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        style={{ touchAction: "none", display: "block" }}
      >
        <defs>
          <linearGradient id="fan-curve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* grid */}
        {[0, 25, 50, 75, 100].map((t) => (
          <g key={`v${t}`} className="text-line">
            <line x1={xToPx(t)} y1={PAD} x2={xToPx(t)} y2={HEIGHT - PAD} stroke="currentColor" strokeWidth={1} opacity={0.5} />
            <text x={xToPx(t)} y={HEIGHT - 8} textAnchor="middle" fill="currentColor" className="text-dim text-[9px]">{t}°</text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((d) => (
          <g key={`h${d}`} className="text-line">
            <line x1={PAD} y1={yToPx(d)} x2={width - PAD} y2={yToPx(d)} stroke="currentColor" strokeWidth={1} opacity={0.5} />
            <text x={8} y={yToPx(d) + 3} textAnchor="start" fill="currentColor" className="text-dim text-[9px]">{d}</text>
          </g>
        ))}

        {/* min-duty floor band */}
        {minDuty > 0 && (
          <rect x={PAD} y={floorY} width={innerW} height={HEIGHT - PAD - floorY} fill="currentColor" className="text-dim" opacity={0.08} />
        )}

        {/* area fill under the curve */}
        {areaPath && <polygon points={areaPath} fill="url(#fan-curve-fill)" />}

        {/* curve */}
        <polyline
          points={linePath}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 5px color-mix(in oklch, var(--color-accent) 50%, transparent))" }}
        />

        {/* live operating point */}
        {live && (
          <g className="text-cyan">
            <line x1={liveX} y1={PAD} x2={liveX} y2={HEIGHT - PAD} stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
            <circle cx={liveX} cy={liveY} r={9} fill="currentColor" opacity={0.18} />
            <circle
              cx={liveX}
              cy={liveY}
              r={5}
              fill="currentColor"
              stroke="var(--color-base)"
              strokeWidth={1.5}
              style={{ filter: "drop-shadow(0 0 6px color-mix(in oklch, var(--color-cyan) 70%, transparent))" }}
            />
          </g>
        )}

        {/* draggable points */}
        {sorted.map((p, i) => {
          const isActive = dragging === i;
          return (
            <g key={i}>
              {isActive && (
                <circle cx={xToPx(p.tempC)} cy={yToPx(p.duty)} r={12} fill="var(--color-accent-bright)" opacity={0.18} />
              )}
              <circle
                cx={xToPx(p.tempC)}
                cy={yToPx(p.duty)}
                r={isActive ? 8 : 6}
                fill="var(--color-accent-bright)"
                className={isActive ? "cursor-grabbing" : "cursor-grab"}
                stroke="var(--color-base)"
                strokeWidth={2}
                style={{ filter: "drop-shadow(0 0 4px color-mix(in oklch, var(--color-accent-bright) 60%, transparent))", transition: "r 120ms ease-out" }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  setDragging(i);
                }}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
