import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";

interface PanelProps {
  /** Short heading (Chinese source string; auto-translated). */
  title?: string;
  /** One line of context under the title. */
  desc?: ReactNode;
  /** Right-aligned controls in the header row. */
  actions?: ReactNode;
  /** Drop body padding (tables, charts that bleed to the edge). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * The one container. A flat surface with a hairline; never nest one Panel in
 * another — inside a panel, group with spacing and `border-t border-line` rules.
 */
export function Panel({ title, desc, actions, flush, className, bodyClassName, children }: PanelProps) {
  const t = useT();
  const hasHeader = title || actions;
  return (
    <section className={cn("glass rounded-xl", className)}>
      {hasHeader && (
        <header className="flex items-start justify-between gap-4 px-4 pb-2.5 pt-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold text-ink">{t(title)}</h2>}
            {desc && <p className="mt-0.5 text-[12px] text-muted">{typeof desc === "string" ? t(desc) : desc}</p>}
          </div>
          {actions && <div className="no-drag flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(!flush && (hasHeader ? "px-4 pb-4" : "p-4"), bodyClassName)}>{children}</div>
    </section>
  );
}
