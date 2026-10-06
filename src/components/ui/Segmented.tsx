import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { springSmooth } from "../../lib/motion";

interface Option<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  id: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  /** Allow the options to wrap to multiple rows instead of one fixed row. Use for
   *  many/long options (e.g. the OSD position picker) so they never overflow the
   *  width — especially in English where labels are longer. */
  wrap?: boolean;
}

export function Segmented<T extends string>({ id, value, options, onChange, wrap }: SegmentedProps<T>) {
  const t = useT();
  return (
    <div
      role="group"
      className={cn(
        "no-drag rounded-lg bg-surface2 p-0.5 shadow-[inset_0_0_0_1px_var(--color-line)]",
        wrap ? "flex flex-wrap gap-0.5" : "inline-flex",
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative h-7 cursor-pointer whitespace-nowrap rounded-md px-3 text-[12.5px] transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
              active ? "text-ink" : "text-muted hover:text-ink",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-md bg-surface3 shadow-[inset_0_0_0_1px_var(--color-line-strong),0_1px_2px_oklch(0%_0_0/0.2)]"
                transition={springSmooth}
              />
            )}
            <span className={cn("relative z-10", active && "font-medium")}>{t(option.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
