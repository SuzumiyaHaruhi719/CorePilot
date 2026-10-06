import { AlertTriangle, ArrowDown, ArrowUp, SearchX } from "lucide-react";
import { cn } from "../../lib/cn";
import { useT, useTf } from "../../lib/i18n";
import { Button } from "./Button";

/** Shared table chrome (DESIGN.md → Lists & tables). */
export const TABLE = "glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl";
export const TABLE_HEAD = "grid h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[11.5px] font-medium text-dim";
export const TABLE_ROW = "grid items-center gap-2 border-b border-line/50 px-3 text-[12.5px] transition-colors duration-100 hover:bg-surface2/60";

interface SortHeadProps<K extends string> {
  k: K;
  label: string;
  sortKey: K;
  sortDir: "asc" | "desc";
  onSort: (k: K) => void;
  align?: "left" | "right";
}

/** Sortable column header: the active column reads in ink with an accent arrow. */
export function SortHead<K extends string>({ k, label, sortKey, sortDir, onSort, align = "right" }: SortHeadProps<K>) {
  const t = useT();
  const active = sortKey === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "no-drag flex min-w-0 cursor-pointer items-center gap-1 rounded-sm transition-colors duration-100 hover:text-ink",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
        align === "right" ? "justify-end" : "justify-start",
        active ? "text-ink" : "text-dim",
      )}
    >
      <span className="truncate">{t(label)}</span>
      {active && (sortDir === "asc" ? <ArrowUp size={11} className="shrink-0 text-accent" /> : <ArrowDown size={11} className="shrink-0 text-accent" />)}
    </button>
  );
}

/** A plain (non-sortable) header label. */
export function HeadLabel({ label, align = "right" }: { label: string; align?: "left" | "right" }) {
  const t = useT();
  return <span className={cn("truncate", align === "right" && "text-right")}>{t(label)}</span>;
}

interface TableBodyStateProps {
  loading?: boolean;
  error?: boolean;
  /** Friendly empty-state message. */
  emptyLabel: string;
  /** Optional second line under the empty message. */
  emptyHint?: string;
  /** Optional retry handler for the error state. */
  onRetry?: () => void;
}

/** The shared loading / error / empty body for every table. Render it only when
 *  there are no rows — it picks the right state so an in-flight first read never
 *  masquerades as "no matches". */
export function TableBodyState({ loading, error, emptyLabel, emptyHint, onRetry }: TableBodyStateProps) {
  const t = useT();
  const tf = useTf();
  if (loading) {
    return (
      <div aria-busy="true" aria-label={tf("正在读取", "Loading")} className="space-y-0">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex h-9 items-center gap-3 border-b border-line/50 px-3">
            <span className="skeleton h-4 w-4 shrink-0" />
            <span className="skeleton h-3 flex-1" style={{ maxWidth: `${46 - (i % 3) * 9}%` }} />
            <span className="skeleton ml-auto h-3 w-12 shrink-0" />
            <span className="skeleton h-3 w-14 shrink-0" />
          </div>
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-14 text-center" role="alert">
        <AlertTriangle size={20} className="text-warn" />
        <span className="mt-1 text-[13px] font-medium text-ink">{tf("读取失败", "Couldn't read the list")}</span>
        <span className="text-[12px] text-muted">{tf("后端没有返回数据，稍后会自动重试。", "The backend returned nothing; it retries automatically.")}</span>
        {onRetry && (
          <Button size="sm" className="mt-2" onClick={onRetry}>
            {t("重试")}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1 py-14 text-center">
      <SearchX size={20} className="text-dim" />
      <span className="mt-1 text-[13px] text-muted">{t(emptyLabel)}</span>
      {emptyHint && <span className="text-[12px] text-dim">{t(emptyHint)}</span>}
    </div>
  );
}
