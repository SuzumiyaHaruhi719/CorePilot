import type { CSSProperties } from "react";
import { cn } from "../../lib/cn";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function Slider({ label, value, min, max, step = 1, unit, disabled, onChange }: SliderProps) {
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <div className={cn("flex flex-col gap-1.5", disabled && "pointer-events-none opacity-40")}>
      <div className="flex items-baseline justify-between">
        <span className="text-[12.5px] text-muted">{label}</span>
        <span className="nums text-[13px] font-semibold text-ink">
          {value}
          {unit ? <span className="ml-0.5 text-[11px] font-normal text-dim">{unit}</span> : null}
        </span>
      </div>
      <input
        type="range"
        className="cp-slider no-drag"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--pct": `${pct}%` } as CSSProperties}
      />
      <div className="nums flex justify-between text-[10.5px] text-dim">
        <span>
          {min}
          {unit}
        </span>
        <span>
          {max}
          {unit}
        </span>
      </div>
    </div>
  );
}
