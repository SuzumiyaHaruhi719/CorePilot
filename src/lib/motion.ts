import type { Transition, Variants } from "motion/react";

/** Premium springs — smooth and slightly weighted, never snappy/plastic. */
export const springSmooth: Transition = { type: "spring", stiffness: 280, damping: 26, mass: 0.9 };
export const springSoft: Transition = { type: "spring", stiffness: 180, damping: 22, mass: 0.9 };
export const springSnappy: Transition = { type: "spring", stiffness: 420, damping: 30 };
export const easeOut = [0.22, 1, 0.36, 1] as const;

/** Staggered list/grid entrance. */
export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.03 } },
};

export const staggerChild: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.42, ease: easeOut } },
};
