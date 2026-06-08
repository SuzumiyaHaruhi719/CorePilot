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
        "no-drag relative h-[24px] w-[44px] shrink-0 rounded-full border transition-colors duration-300",
        "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        checked ? "border-accent/60 bg-accent/30 glow-sm" : "border-line bg-surface3",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <motion.span
        initial={false}
        animate={{ x: checked ? 20 : 0, scale: checked ? 1 : 0.9 }}
        transition={{ type: "spring", stiffness: 360, damping: 26, mass: 0.7 }}
        className={cn(
          "absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full shadow-[0_1px_3px_rgb(0_0_0/0.45)] transition-colors duration-300",
          checked ? "bg-accent-bright" : "bg-dim",
        )}
      />
    </button>
  );
}
