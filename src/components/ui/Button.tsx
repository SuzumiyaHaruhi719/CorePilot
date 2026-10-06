import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { hoverPop } from "../../lib/motion";

type Variant = "primary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md";

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  /** primary = the one action per view · ghost = secondary · subtle = text-only · danger = destructive. */
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  className?: string;
  title?: string;
  /** Accessible name — important for icon-only buttons. */
  ariaLabel?: string;
}

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-bright",
  ghost: "bg-surface2 text-ink shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-surface3 hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
  subtle: "text-muted hover:bg-surface2 hover:text-ink",
  danger: "bg-danger/12 text-danger shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-danger)_35%,transparent)] hover:bg-danger/20",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-[12px]",
  md: "h-8 gap-1.5 px-3 text-[12.5px]",
};

export function Button({ children, onClick, variant = "ghost", size = "md", disabled, className, title, ariaLabel }: ButtonProps) {
  return (
    <motion.button
      type="button"
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={hoverPop}
      className={cn(
        "no-drag relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium",
        "transition-[background-color,color,box-shadow] duration-150 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        SIZES[size],
        // A disabled primary goes neutral: a 40%-opacity accent reads as a
        // muddy half-lit button rather than "not available yet".
        disabled && variant === "primary" ? "bg-surface3 text-dim" : VARIANTS[variant],
        disabled ? cn("cursor-not-allowed", variant !== "primary" && "opacity-40") : "cursor-pointer",
        className,
      )}
    >
      {children}
    </motion.button>
  );
}
