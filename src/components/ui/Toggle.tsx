import { motion } from "motion/react";
import { cn } from "../../lib/cn";

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Accessible name for the switch (screen readers); also used as the title. */
  label?: string;
  disabled?: boolean;
}

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
        "no-drag relative h-[24px] w-[44px] shrink-0 rounded-full border transition-colors duration-200",
        "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        checked ? "border-accent/50 bg-accent/25 glow-sm" : "border-line bg-surface3",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <motion.span
        initial={false}
        animate={{ x: checked ? 20 : 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 34 }}
        className={cn(
          "absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full",
          checked ? "bg-accent-bright" : "bg-dim",
        )}
      />
    </button>
  );
}
