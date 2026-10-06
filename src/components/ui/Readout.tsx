import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { AnimatedNumber } from "./AnimatedNumber";

type ReadoutSize = "sm" | "md" | "lg" | "xl";

const VALUE_SIZE: Record<ReadoutSize, string> = {
  sm: "text-[15px]",
  md: "text-[20px]",
  lg: "text-[28px] font-light",
  xl: "text-[40px] font-light leading-none",
};

interface ReadoutProps {
  label: string;
  /** null/undefined renders "—" (never a fake 0). */
  value: number | string | null | undefined;
  unit?: string;
  /** Decimal places when `value` is a number. */
  digits?: number;
  size?: ReadoutSize;
  /** CSS color for the value (a data-series token, e.g. "var(--color-cyan)"). Default: ink. */
  color?: string;
  /** Secondary line under the value (e.g. "/ 450 W"). */
  sub?: ReactNode;
  className?: string;
}

/** Instrument readout: small label over a Bahnschrift value. The one way to show a live number. */
export function Readout({ label, value, unit, digits = 0, size = "md", color, sub, className }: ReadoutProps) {
  const t = useT();
  const missing = value == null || (typeof value === "number" && !Number.isFinite(value));
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-[12px] text-muted">{t(label)}</div>
      <div
        className={cn("nums mt-0.5 flex items-baseline gap-1 whitespace-nowrap text-ink", VALUE_SIZE[size])}
        style={color ? ({ color } as CSSProperties) : undefined}
      >
        {missing ? (
          <span className="text-dim">—</span>
        ) : typeof value === "number" ? (
          <AnimatedNumber value={value} digits={digits} />
        ) : (
          value
        )}
        {unit && !missing && <span className="text-[11px] font-normal text-dim">{unit}</span>}
      </div>
      {sub && <div className="nums mt-0.5 text-[11.5px] text-dim">{sub}</div>}
    </div>
  );
}

interface MeterProps {
  /** 0–100. */
  value: number | null | undefined;
  /** Fill color (CSS). Default: accent. */
  color?: string;
  className?: string;
}

/** Thin usage bar. Fill animates via transform (compositor-only). */
export function Meter({ value, color, className }: MeterProps) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-surface3", className)} role="meter" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div
        className="h-full origin-left rounded-full transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ transform: `scaleX(${v / 100})`, background: color ?? "var(--color-accent)" }}
      />
    </div>
  );
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface3 text-muted",
  accent: "bg-accent/14 text-accent",
  ok: "bg-ok/14 text-ok",
  warn: "bg-warn/14 text-warn",
  danger: "bg-danger/14 text-danger",
};

/** Small status label. Pair with text, never color alone. */
export function Badge({ tone = "neutral", dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-[11px] font-medium", TONE[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/**
 * Instrument cluster: readout cells in an auto-fit grid, divided by hairlines
 * (cells draw left/top rules; the grid is pulled -1px so the outer edge hides).
 * Put it directly inside a `Panel flush` (or any rounded, overflow-hidden box).
 */
export function Cluster({ min = 128, className, children }: { min?: number; className?: string; children: ReactNode }) {
  return (
    <div className={cn("overflow-hidden", className)}>
      <div className="-ml-px -mt-px grid" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}>
        {children}
      </div>
    </div>
  );
}

/** One cell of a `Cluster`: content + optional usage meter pinned to the bottom. */
export function ClusterCell({ children, meter, meterColor, className }: { children: ReactNode; meter?: number; meterColor?: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-between gap-3 border-l border-t border-line px-5 py-4", className)}>
      {children}
      {meter != null && <Meter value={meter} color={meterColor} />}
    </div>
  );
}
