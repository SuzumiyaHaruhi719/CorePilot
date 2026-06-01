import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

interface RippleItem {
  id: number;
  x: number;
  y: number;
  size: number;
}

/**
 * Glowing click ripple. Drop `<ClickRipple />` as the last child of any
 * `position: relative` clickable element — it self-clips to the element's
 * radius and listens to the parent's pointerdown. Works inside lists.
 */
export function ClickRipple() {
  const ref = useRef<HTMLSpanElement>(null);
  const [items, setItems] = useState<RippleItem[]>([]);

  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const handler = (e: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const id = performance.now();
      setItems((prev) => [
        ...prev,
        { id, x: e.clientX - rect.left - size / 2, y: e.clientY - rect.top - size / 2, size },
      ]);
      window.setTimeout(() => setItems((prev) => prev.filter((it) => it.id !== id)), 700);
    };
    parent.addEventListener("pointerdown", handler);
    return () => parent.removeEventListener("pointerdown", handler);
  }, []);

  return (
    <span ref={ref} className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
      <AnimatePresence>
        {items.map((r) => (
          <motion.span
            key={r.id}
            initial={{ opacity: 0.42, scale: 0 }}
            animate={{ opacity: 0, scale: 2.4 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            style={{
              left: r.x,
              top: r.y,
              width: r.size,
              height: r.size,
              background: "radial-gradient(circle, rgba(255,255,255,0.4), rgba(255,255,255,0) 70%)",
            }}
            className="absolute rounded-full"
          />
        ))}
      </AnimatePresence>
    </span>
  );
}
