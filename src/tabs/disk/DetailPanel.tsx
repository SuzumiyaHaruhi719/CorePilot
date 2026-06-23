import { motion } from "motion/react";
import {
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Folder,
  FileText,
  Link2,
  ListTree,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useTf } from "../../lib/i18n";
import { api, DISK_FLAG, type ItemRow, type TreeNode, type TreeView } from "../../lib/ipc";
import type { Metric } from "./treemap/layout";
import { displayName } from "./treemap/names";

/**
 * Side detail panel (spec §4.6). Shows the selected item's resolved path, alloc
 * vs logical size, % of disk / % of focus, file count and flags; plus a mini
 * "largest items here" list pulled from `disk_top_items` on the current focus.
 * Action buttons: Reveal (Explorer) — the read-only v1 surface (Delete is the
 * gated Phase-7 deferral, not here).
 *
 * The selection is fed by the treemap's `onPick` (leaf) / `onHover`. When no item
 * is selected it falls back to summarising the focus root, so the panel is never
 * empty while a tree is shown.
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §4.6.
 */

interface DetailPanelProps {
  scanId: string;
  /** The currently shown LOD slice (its `nodes[0]` is the focus root). */
  view: TreeView;
  /** Selected node (leaf or container) or null → summarise the focus root. */
  selected: TreeNode | null;
  metric: Metric;
  /** Permission-denied / unreadable entries skipped during the scan (spec §6.2)
   *  — surfaced in a collapsible panel, never silently dropped. */
  skipped: number;
}

export function DetailPanel({ scanId, view, selected, metric, skipped }: DetailPanelProps) {
  const tf = useTf();
  const root = view.nodes[0];
  const focus = selected ?? root;

  const sizeOf = (n: { allocSize: number; logicalSize: number }) =>
    metric === "alloc" ? n.allocSize : n.logicalSize;
  const rootSize = sizeOf(root);
  const focusSize = sizeOf(focus);
  const pctOfRoot = rootSize > 0 ? (focusSize / rootSize) * 100 : 0;

  const isDir = (focus.flags & DISK_FLAG.isDir) !== 0;
  const reparse = (focus.flags & DISK_FLAG.reparse) !== 0;
  const denied = (focus.flags & DISK_FLAG.denied) !== 0;
  const hidden = (focus.flags & DISK_FLAG.hidden) !== 0;

  // "Largest items here" — top-N children of the CURRENT FOCUS (not the selection),
  // re-pulled when the focus path or generation advances. Mirrors the SpaceSniffer
  // "what's eating my space" answer at this level.
  const [topItems, setTopItems] = useState<ItemRow[]>([]);
  const [skippedOpen, setSkippedOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .diskTopItems(scanId, view.focusPath || null, 12)
      .then((rows) => {
        if (alive) setTopItems(rows);
      })
      .catch(() => {
        if (alive) setTopItems([]);
      });
    return () => {
      alive = false;
    };
  }, [scanId, view.focusPath, view.generation]);

  const reveal = () => {
    if (focus.path) void api.revealInExplorer(focus.path).catch(() => undefined);
  };

  const maxItem = topItems.length > 0 ? Math.max(...topItems.map((r) => sizeOf(r))) : 0;

  return (
    <div className="flex h-full min-h-0 w-[300px] shrink-0 flex-col border-l border-line bg-surface2/40">
      {/* Selected / focus item header */}
      <div className="border-b border-line px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-base/40",
              isDir ? "text-accent" : "text-cyan",
            )}
          >
            {reparse ? (
              <Link2 size={17} />
            ) : isDir ? (
              <Folder size={17} />
            ) : (
              <FileText size={17} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold text-ink" title={focus.name}>
              {displayName(focus, tf)}
            </div>
            {focus.path && (
              <div className="truncate text-[10.5px] text-dim" title={focus.path}>
                {focus.path}
              </div>
            )}
            {!selected && (
              <div className="mt-0.5 text-[10.5px] text-dim">
                {tf("当前层级汇总", "Current level summary")}
              </div>
            )}
          </div>
        </div>

        {/* Stat rows */}
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11.5px]">
          <Stat label={tf("占用(分配)", "Allocated")} value={formatBytes(focus.allocSize)} />
          <Stat label={tf("逻辑大小", "Logical")} value={formatBytes(focus.logicalSize)} />
          <Stat label={tf("占磁盘", "% of disk")} value={`${pctOfRoot.toFixed(1)}%`} />
          <Stat
            label={isDir ? tf("文件数", "Files") : tf("类型", "Type")}
            value={
              isDir
                ? focus.fileCount.toLocaleString()
                : reparse
                  ? tf("链接", "Link")
                  : tf("文件", "File")
            }
          />
        </dl>

        {(denied || hidden) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {denied && (
              <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn">
                {tf("无访问权限", "Access denied")}
              </span>
            )}
            {hidden && (
              <span className="rounded border border-line bg-base/40 px-1.5 py-0.5 text-[10px] text-dim">
                {tf("隐藏", "Hidden")}
              </span>
            )}
          </div>
        )}

        {/* Read-only actions (spec §6.1 — v1 ships Reveal only; Delete is Phase 7). */}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={!focus.path}
            onClick={reveal}
            className={cn(
              "no-drag inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[11.5px] text-ink transition-colors",
              focus.path
                ? "cursor-pointer hover:border-line-strong hover:bg-surface3"
                : "cursor-not-allowed opacity-40",
            )}
            title={tf("在资源管理器中显示", "Reveal in Explorer")}
          >
            <ExternalLink size={13} />
            {tf("打开位置", "Reveal")}
          </button>
        </div>
      </div>

      {/* "Largest items here" list (top-N of the focus, from disk_top_items). */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5 px-4 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-dim">
          <ListTree size={13} />
          {tf("此处最大项目", "Largest items here")}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {topItems.length === 0 ? (
            <div className="grid place-items-center py-8 text-[11.5px] text-dim">
              <FolderOpen size={18} className="mb-1.5 opacity-60" />
              {tf("暂无数据", "No data")}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {topItems.map((row, i) => {
                const s = sizeOf(row);
                const pct = maxItem > 0 ? (s / maxItem) * 100 : 0;
                const rowDir = (row.flags & DISK_FLAG.isDir) !== 0;
                return (
                  <li key={`${row.path}-${i}`}>
                    <button
                      type="button"
                      onClick={() => void api.revealInExplorer(row.path).catch(() => undefined)}
                      title={row.path}
                      className="no-drag relative w-full overflow-hidden rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface3"
                    >
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ type: "spring", stiffness: 170, damping: 28 }}
                        className="absolute inset-y-0 left-0 -z-0 rounded-md bg-accent/10"
                      />
                      <div className="relative z-10 flex items-center gap-2">
                        {rowDir ? (
                          <Folder size={13} className="shrink-0 text-accent" />
                        ) : (
                          <FileText size={13} className="shrink-0 text-dim" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                          {displayName(row, tf)}
                        </span>
                        <span className="nums shrink-0 text-[11px] text-muted">{formatBytes(s)}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Skipped-items panel (spec §6.2) — permission-denied / unreadable entries
          are counted, never silently dropped; surfaced in a collapsible footer. */}
      {skipped > 0 && (
        <div className="shrink-0 border-t border-line">
          <button
            type="button"
            onClick={() => setSkippedOpen((o) => !o)}
            className="no-drag flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-[11.5px] text-muted transition-colors hover:bg-surface3"
          >
            <ShieldAlert size={13} className="shrink-0 text-warn" />
            <span className="flex-1">
              {tf("已跳过", "Skipped")}{" "}
              <span className="nums text-ink">{skipped.toLocaleString()}</span>{" "}
              {tf("项", "items")}
            </span>
            <ChevronRight
              size={13}
              className={cn("shrink-0 transition-transform", skippedOpen && "rotate-90")}
            />
          </button>
          {skippedOpen && (
            <div className="px-4 pb-3 text-[11px] leading-relaxed text-dim">
              {tf(
                "这些条目因权限不足、文件被占用或共享冲突而无法读取,已从统计中跳过(扫描不会因此中断)。它们的大小未计入树图。",
                "These entries could not be read (access denied, in-use, or a sharing conflict) and were skipped — the scan continued regardless. Their size is not counted in the treemap.",
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-dim">{label}</dt>
      <dd className="nums truncate text-[12.5px] font-semibold text-ink">{value}</dd>
    </div>
  );
}
