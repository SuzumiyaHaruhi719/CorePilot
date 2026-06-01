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
