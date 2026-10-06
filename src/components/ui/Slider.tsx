import type { CSSProperties } from "react";
import { cn } from "../../lib/cn";

interface RangeInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  /** Accessible name (the visible label lives in the surrounding row). */
  label: string;
  onChange: (value: number) => void;
  /** Show min/max under the rail. */
  ticks?: boolean;
  className?: string;
}

/** The bare rail — for rows that already show their own title and value. */
export function RangeInput({ value, min, max, step = 1, unit, disabled, label, onChange, ticks = true, className }: RangeInputProps) {
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <div className={cn(disabled && "pointer-events-none opacity-40", className)}>
      <input
        type="range"
        aria-label={label}
        className="cp-slider no-drag"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--pct": `${pct}%` } as CSSProperties}
      />
      {ticks && (
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
      )}
    </div>
  );
}

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

/** Labelled slider: label + live value on one line, rail below. */
export function Slider({ label, value, min, max, step = 1, unit, disabled, onChange }: SliderProps) {
  return (
    <div className={cn("flex flex-col gap-1", disabled && "opacity-40")}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] text-muted">{label}</span>
        <span className="nums text-[15px] text-ink">
          {value}
          {unit ? <span className="ml-0.5 text-[11px] text-dim">{unit}</span> : null}
        </span>
      </div>
      <RangeInput label={label} value={value} min={min} max={max} step={step} unit={unit} disabled={disabled} onChange={onChange} className="opacity-100" />
    </div>
  );
}
