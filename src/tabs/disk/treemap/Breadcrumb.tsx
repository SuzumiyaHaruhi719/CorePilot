import { ChevronRight, HardDrive } from "lucide-react";
import { Fragment } from "react";
import { cn } from "../../../lib/cn";
import { useTf } from "../../../lib/i18n";

/**
 * Drill-down breadcrumb bar (spec §3.4 / §4.2). Each segment is the display name
 * of one focus level on the drill stack (`Root › Users › Thomas › … current`).
 * Clicking a segment ascends to it (pops the stack to that depth); the trailing
 * segment is the current focus and is not clickable. The leading icon segment is
 * the disk root.
 *
 * Purely presentational: it renders the `segments` it's handed and calls
 * `onNavigate(depth)` (0 = root) — the owning workspace re-pulls `disk_tree` for
 * the focus path at that depth. No layout/relayout here.
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §3.4.
 */

export interface CrumbSegment {
  /** Display label (the disk root shows the friendly letter; deeper levels the
   *  folder name). */
  label: string;
}

interface BreadcrumbProps {
  segments: CrumbSegment[];
  /** Ascend to a level: `depth` is the segment index (0 = the disk root). */
  onNavigate: (depth: number) => void;
}

export function Breadcrumb({ segments, onNavigate }: BreadcrumbProps) {
  const tf = useTf();
  const last = segments.length - 1;
  return (
    <nav
      aria-label={tf("路径", "Breadcrumb")}
      className="no-drag flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[12px]"
    >
      {segments.map((seg, i) => {
        const isLast = i === last;
        return (
          <Fragment key={i}>
            {i > 0 && <ChevronRight size={13} className="shrink-0 text-dim" />}
            <button
              type="button"
              disabled={isLast}
              onClick={() => onNavigate(i)}
              title={seg.label}
              className={cn(
                "flex max-w-[180px] shrink-0 items-center gap-1.5 truncate rounded-md px-2 py-1 transition-colors",
                isLast
                  ? "cursor-default font-semibold text-ink"
                  : "cursor-pointer text-muted hover:bg-surface3 hover:text-ink",
              )}
            >
              {i === 0 && <HardDrive size={13} className="shrink-0 text-accent" />}
              <span className="truncate">{seg.label}</span>
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
