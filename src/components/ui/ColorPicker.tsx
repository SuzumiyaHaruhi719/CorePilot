import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { GROUP_PALETTE, groupColor, hueDistance } from "../../lib/colors";

export interface ColorAnchor {
  x: number;
  y: number;
}

interface ColorPickerProps {
  /** Screen position to anchor the popover to (null = closed). */
  anchor: ColorAnchor | null;
  hue: number;
  onChange: (hue: number) => void;
  onClose: () => void;
}

const POP_WIDTH = 232;

// Rainbow track sampled at the group dots' fixed lightness/chroma, so the
// slider previews exactly the colors a group can take.
const HUE_TRACK = `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => groupColor(i * 30)).join(", ")})`;

export function ColorPicker({ anchor, hue, onChange, onClose }: ColorPickerProps) {
  useEffect(() => {
    if (!anchor) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer the click-to-close listener a tick so the click that opened the
    // popover doesn't immediately dismiss it (mirrors ContextMenu).
    const timer = window.setTimeout(() => window.addEventListener("click", close), 0);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <AnimatePresence>
      {anchor && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.13, ease: [0.22, 1, 0.36, 1] }}
          style={{
            left: Math.min(anchor.x, window.innerWidth - POP_WIDTH - 8),
            top: Math.min(anchor.y, window.innerHeight - 168),
            width: POP_WIDTH,
          }}
          className="glass glow fixed z-[100] origin-top-left rounded-xl border border-line-strong p-3"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-muted">分组颜色</span>
            <span className="flex items-center gap-1.5">
              <span
                className="h-3.5 w-3.5 rounded-full glow-sm"
                style={{ background: groupColor(hue) }}
              />
              <span className="nums text-[11px] text-dim">{Math.round(hue)}°</span>
            </span>
          </div>

          <div className="grid grid-cols-6 gap-1.5">
            {GROUP_PALETTE.map((h) => {
              const active = hueDistance(hue, h) < 6;
              return (
                <motion.button
                  key={h}
                  whileHover={{ scale: 1.15 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => onChange(h)}
                  className={cn(
                    "h-7 w-7 rounded-full border-2 transition-colors",
                    active ? "border-ink glow-sm" : "border-transparent hover:border-line-strong",
                  )}
                  style={{ background: groupColor(h) }}
                />
              );
            })}
          </div>

          <input
            type="range"
            min={0}
            max={359}
            value={Math.round(hue)}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-label="色相"
            className="cp-hue no-drag mt-3 w-full"
            style={{ background: HUE_TRACK }}
          />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
