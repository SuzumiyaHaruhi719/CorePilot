import { useSpring } from "motion/react";
import { useEffect, useRef } from "react";
import { useSettings } from "../../store/settings";

interface AnimatedNumberProps {
  value: number;
  digits?: number;
  suffix?: string;
}

/**
 * Spring-animated number that writes to the DOM imperatively (no React
 * re-render per frame) — smooth *and* lightweight for live metrics. When
 * "关闭动画 / reduce-motion" is on it jumps to each value instantly (no spring),
 * so live telemetry doesn't keep visibly animating.
 */
export function AnimatedNumber({ value, digits = 0, suffix = "" }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const spring = useSpring(value, { stiffness: 140, damping: 22, mass: 0.6 });

  useEffect(() => {
    // reduce-motion → jump (set without animating); otherwise spring toward it.
    if (reduceMotion) spring.jump(value);
    else spring.set(value);
  }, [value, spring, reduceMotion]);

  useEffect(() => {
    const unsubscribe = spring.on("change", (latest) => {
      if (ref.current) ref.current.textContent = latest.toFixed(digits) + suffix;
    });
    return () => unsubscribe();
  }, [spring, digits, suffix]);

  return <span ref={ref}>{value.toFixed(digits) + suffix}</span>;
}
