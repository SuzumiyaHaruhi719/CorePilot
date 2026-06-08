import { AnimatePresence, motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface ContextMenuProps {
  state: MenuState | null;
  onClose: () => void;
}

const ITEM_HEIGHT = 33;
const MENU_WIDTH = 200;

export function ContextMenu({ state, onClose }: ContextMenuProps) {
  const t = useT();
  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer the click-to-close listener by a tick so the very click that opens
    // the menu (e.g. a left-click on a trigger button) doesn't immediately
    // close it. Right-click menus are unaffected (they fire `contextmenu`).
    const timer = window.setTimeout(() => window.addEventListener("click", close), 0);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [state, onClose]);

  return createPortal(
    <AnimatePresence>
      {state && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.13, ease: [0.22, 1, 0.36, 1] }}
          style={{
            // Clamp on BOTH axes so the menu never escapes a small viewport, and
            // cap height (scroll) when there are many items / a short window.
            left: Math.max(8, Math.min(state.x, window.innerWidth - MENU_WIDTH - 8)),
            top: Math.max(8, Math.min(state.y, window.innerHeight - state.items.length * ITEM_HEIGHT - 16)),
            maxHeight: window.innerHeight - 16,
            overflowY: "auto",
            // Real frosted glass: a translucent surface PLUS an always-on backdrop
            // blur (the base .glass only blurs in acrylic mode, so a portaled menu
            // showed the page through sharply). The blur frosts what's behind while
            // the tint keeps the text readable.
            background: "color-mix(in oklch, var(--color-elevated) 64%, transparent)",
          }}
          className="glass glow fixed z-[100] origin-top-left rounded-xl border border-line-strong p-1.5 backdrop-blur-2xl backdrop-saturate-150"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {state.items.map((item, i) => (
            <button
              key={i}
              disabled={item.disabled}
              onClick={() => {
                item.onClick();
                onClose();
              }}
              className={cn(
                "flex w-[180px] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                item.danger ? "text-danger hover:bg-danger/15" : "text-ink hover:bg-surface3",
              )}
            >
              {item.icon && <item.icon size={14} className="shrink-0" />}
              {t(item.label)}
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
