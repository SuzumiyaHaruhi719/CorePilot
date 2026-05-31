import { motion } from "motion/react";
import { cn } from "../../lib/cn";

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
}

export function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "no-drag relative h-[24px] w-[44px] rounded-full border transition-colors duration-200",
        checked ? "border-accent/50 bg-accent/25 glow-sm" : "border-line bg-surface3",
      )}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 520, damping: 32 }}
        className={cn(
          "absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full",
          checked ? "right-[3px] bg-accent-bright" : "left-[3px] bg-dim",
        )}
      />
    </button>
  );
}
