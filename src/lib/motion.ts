import type { Transition } from "motion/react";

/** Premium spring — smooth and slightly weighted, never snappy/plastic. */
export const springSmooth: Transition = { type: "spring", stiffness: 280, damping: 26, mass: 0.9 };
export const easeOut = [0.22, 1, 0.36, 1] as const;

/** Hover/press tween matching the reference monitor: cubic-bezier(.22,1,.36,1), ~.18s. */
export const hoverPop: Transition = { type: "tween", duration: 0.18, ease: easeOut };
