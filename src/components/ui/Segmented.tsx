import { motion } from "motion/react";
import { cn } from "../../lib/cn";

interface Option<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  id: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({ id, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div role="group" className="no-drag inline-flex rounded-lg border border-line bg-surface2 p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className="relative cursor-pointer rounded-[7px] px-3 py-1 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-[7px] border border-accent/40 bg-accent/20 glow-sm"
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
              />
            )}
            <span className={cn("relative z-10", active ? "text-ink" : "text-muted")}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
