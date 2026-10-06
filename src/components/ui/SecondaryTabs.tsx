import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { springSmooth } from "../../lib/motion";

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

/** Page-level sub-navigation: text tabs on a hairline, an accent rule glides under the active one. */
export function SecondaryTabs<T extends string>({
  tabs,
  active,
  onChange,
  layoutId = "secondary-tab",
}: SecondaryTabsProps<T>) {
  const t = useT();
  return (
    <div role="tablist" className="flex items-center gap-5 border-b border-line px-6">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={cn(
              "no-drag relative -mb-px cursor-pointer py-2.5 text-[13px] transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:rounded-sm",
              isActive ? "font-medium text-ink" : "text-muted hover:text-ink",
            )}
          >
            {t(tab.label)}
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-accent"
                transition={springSmooth}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
