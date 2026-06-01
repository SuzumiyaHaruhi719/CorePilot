import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { springSmooth } from "../../lib/motion";
import { ClickRipple } from "./Ripple";

type Variant = "primary" | "ghost" | "danger" | "subtle";

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: Variant;
  disabled?: boolean;
  className?: string;
  title?: string;
}

const VARIANTS: Record<Variant, string> = {
  primary: "grad-accent text-white glow-sm hover:brightness-110",
  ghost: "border border-line bg-surface2 text-ink hover:border-line-strong hover:bg-surface3",
  subtle: "text-muted hover:bg-surface3 hover:text-ink",
  danger: "border border-danger/40 bg-danger/15 text-danger hover:bg-danger/25",
};

export function Button({ children, onClick, variant = "ghost", disabled, className, title }: ButtonProps) {
  return (
    <motion.button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      whileHover={disabled ? undefined : { y: -2 }}
      whileTap={disabled ? undefined : { scale: 0.96, y: 0 }}
      transition={springSmooth}
      className={cn(
        "no-drag relative inline-flex items-center justify-center gap-1.5 overflow-hidden rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-[background-color,border-color,color,filter,box-shadow] duration-200",
        VARIANTS[variant],
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      {children}
      {!disabled && <ClickRipple />}
    </motion.button>
  );
}
