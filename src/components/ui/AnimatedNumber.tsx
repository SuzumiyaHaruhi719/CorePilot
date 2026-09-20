import { useSpring } from "motion/react";
import { useEffect, useRef } from "react";
import { useSettings } from "../../store/settings";
import { useUiActive } from "../../hooks/useUiActive";

interface AnimatedNumberProps {
  value: number;
  digits?: number;
  suffix?: string;
}

/**
 * Spring-animated number that writes to the DOM imperatively (no React
 * re-render per frame) ¡ª smooth *and* lightweight for live metrics. When
 * reduce-motion or the UI is inactive, it jumps to each value instantly so
 * hidden telemetry doesn't keep visibly animating.
 */
export function AnimatedNumber({ value, digits = 0, suffix = "" }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const initialText = useRef(value.toFixed(digits) + suffix);
  const lastText = useRef(initialText.current);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const active = useUiActive((s) => s.active);
  const spring = useSpring(value, {
    stiffness: 140,
    damping: 22,
    mass: 0.6,
    restDelta: digits > 0 ? 0.05 : 0.5,
    restSpeed: 0.5,
  });

  const writeText = (text: string) => {
    if (ref.current && lastText.current !== text) {
      ref.current.textContent = text;
      lastText.current = text;
    }
  };

  useEffect(() => {
    // Hidden/inactive views must stop producing spring frames; jumping also
    // prevents stale values when the window becomes visible again.
    if (reduceMotion || !active) {
      spring.jump(value);
      writeText(value.toFixed(digits) + suffix);
    } else {
      spring.set(value);
    }
  }, [value, spring, reduceMotion, active, digits, suffix]);

  useEffect(() => {
    const unsubscribeChange = spring.on("change", (latest) => {
      writeText(latest.toFixed(digits) + suffix);
    });
    const unsubscribeComplete = spring.on("animationComplete", () => {
      // The spring can settle between displayed resolutions; always finish
      // with the exact target instead of leaving a rounded tail behind.
      writeText(value.toFixed(digits) + suffix);
    });
    return () => {
      unsubscribeChange();
      unsubscribeComplete();
    };
  }, [spring, digits, suffix, value]);

  // Keep this child stable: changing it on every parent telemetry tick makes
  // React briefly overwrite the imperative spring text before Motion restores it.
  return <span ref={ref}>{initialText.current}</span>;
}
