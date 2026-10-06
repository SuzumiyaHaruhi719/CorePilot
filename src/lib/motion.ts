import type { Transition } from "motion/react";

/** Exponential ease-out — the house curve. Fast start, long settle, no overshoot. */
export const easeOut = [0.16, 1, 0.3, 1] as const;

/** State changes that move (indicators, thumbs, knobs). Critically damped: glides, never bounces. */
export const springSmooth: Transition = { type: "spring", bounce: 0, visualDuration: 0.26 };

/** Press / hover feedback. */
export const hoverPop: Transition = { type: "tween", duration: 0.15, ease: easeOut };

/** Floating layers (menus, popovers) — appear quick, from their anchor. */
export const popIn = {
  initial: { opacity: 0, scale: 0.97, y: -2 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.1 } },
  transition: { duration: 0.16, ease: easeOut },
} as const;
