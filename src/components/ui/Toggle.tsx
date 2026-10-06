import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { springSmooth } from "../../lib/motion";

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Accessible name for the switch (screen readers); also used as the title. */
  label?: string;
  disabled?: boolean;
}

/** Windows-11-style switch: outlined when off, solid accent with a light knob when on. */
export function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "group no-drag relative h-5 w-10 shrink-0 rounded-full transition-[background-color,box-shadow] duration-200 ease-out",
        "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        checked
          ? "bg-accent hover:bg-accent-bright"
          : "bg-transparent shadow-[inset_0_0_0_1px_var(--color-dim)] hover:bg-surface2 hover:shadow-[inset_0_0_0_1px_var(--color-muted)]",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <motion.span
        initial={false}
        animate={{ x: checked ? 20 : 0 }}
        transition={springSmooth}
        className={cn(
          "absolute left-1 top-1 h-3 w-3 rounded-full transition-colors duration-150",
          checked ? "bg-on-accent" : "bg-muted",
        )}
      />
    </button>
  );
}
