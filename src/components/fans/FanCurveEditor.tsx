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
    <div ref={wrapRef} className="no-drag w-full select-none">
      <svg
        width={width}
        height={HEIGHT}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        style={{ touchAction: "none", display: "block" }}
      >
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

        {/* curve */}
        <polyline points={linePath} fill="none" stroke="var(--color-accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

        {/* live operating point */}
        {live && (
          <g className="text-cyan">
            <line x1={liveX} y1={PAD} x2={liveX} y2={HEIGHT - PAD} stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
            <circle cx={liveX} cy={liveY} r={5} fill="currentColor" opacity={0.9} />
          </g>
        )}

        {/* draggable points */}
        {sorted.map((p, i) => (
          <circle
            key={i}
            cx={xToPx(p.tempC)}
            cy={yToPx(p.duty)}
            r={dragging === i ? 8 : 6}
            fill="var(--color-accent-bright)"
            className="cursor-grab"
            stroke="white"
            strokeWidth={1.5}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              setDragging(i);
            }}
          />
        ))}
      </svg>
    </div>
  );
}
