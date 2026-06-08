import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";

interface SecondaryTab<T extends string> {
  id: T;
  label: string;
}

interface SecondaryTabsProps<T extends string> {
  tabs: SecondaryTab<T>[];
  active: T;
  onChange: (id: T) => void;
  layoutId?: string;
}

export function SecondaryTabs<T extends string>({
  tabs,
  active,
  onChange,
  layoutId = "secondary-tab",
}: SecondaryTabsProps<T>) {
  const t = useT();
  return (
    <div className="flex items-center gap-1 border-b border-line px-4">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className="no-drag relative px-3 py-2.5 text-[12.5px] font-medium"
          >
            <span className={cn("relative z-10 transition-colors", isActive ? "text-ink" : "text-muted hover:text-ink")}>
              {t(tab.label)}
            </span>
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent glow-sm"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
