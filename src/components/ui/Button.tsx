import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { hoverPop } from "../../lib/motion";
import { ClickRipple } from "./Ripple";

type Variant = "primary" | "ghost" | "danger" | "subtle";

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: Variant;
  disabled?: boolean;
  className?: string;
  title?: string;
  /** Accessible name — important for icon-only buttons. */
  ariaLabel?: string;
}

const VARIANTS: Record<Variant, string> = {
  primary: "grad-accent text-white glow-sm hover:brightness-110",
  ghost: "border border-line bg-surface2 text-ink hover:border-line-strong hover:bg-surface3",
  subtle: "text-muted hover:bg-surface3 hover:text-ink",
  danger: "border border-danger/40 bg-danger/15 text-danger hover:bg-danger/25",
};

export function Button({ children, onClick, variant = "ghost", disabled, className, title, ariaLabel }: ButtonProps) {
  return (
    <motion.button
      type="button"
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      whileHover={disabled ? undefined : { scale: 1.04, y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.97, y: 0 }}
      transition={hoverPop}
      className={cn(
        "no-drag relative inline-flex items-center justify-center gap-1.5 overflow-hidden rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-[background-color,border-color,color,filter,box-shadow] duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        VARIANTS[variant],
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
        className,
      )}
    >
      {children}
      {!disabled && <ClickRipple />}
    </motion.button>
  );
}
