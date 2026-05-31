import { useSpring } from "motion/react";
import { useEffect, useRef } from "react";

interface AnimatedNumberProps {
  value: number;
  digits?: number;
  suffix?: string;
}

/**
 * Spring-animated number that writes to the DOM imperatively (no React
 * re-render per frame) — smooth *and* lightweight for live metrics.
 */
export function AnimatedNumber({ value, digits = 0, suffix = "" }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const spring = useSpring(value, { stiffness: 140, damping: 22, mass: 0.6 });

  useEffect(() => {
    spring.set(value);
  }, [value, spring]);

  useEffect(() => {
    const unsubscribe = spring.on("change", (latest) => {
      if (ref.current) ref.current.textContent = latest.toFixed(digits) + suffix;
    });
    return () => unsubscribe();
  }, [spring, digits, suffix]);

  return <span ref={ref}>{value.toFixed(digits) + suffix}</span>;
}
