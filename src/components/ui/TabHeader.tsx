import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

interface TabHeaderProps {
  /** @deprecated Ignored — the sidebar already shows the page icon. Remove at call sites. */
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

/** Page title row. Typography only: the title is the anchor, actions sit on its baseline. */
export function TabHeader({ title, subtitle, actions }: TabHeaderProps) {
  const t = useT();
  return (
    <header className="flex shrink-0 items-end justify-between gap-6 px-6 pb-4 pt-5">
      <div className="min-w-0">
        <h1 className="font-title text-[20px] font-semibold leading-tight text-ink">{t(title)}</h1>
        {subtitle && <p className="mt-1 max-w-[110ch] text-pretty text-[12.5px] text-muted">{t(subtitle)}</p>}
      </div>
      {actions && <div className="no-drag flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
