import { ArrowDown, ArrowUp } from "lucide-react";
import { memo, useMemo, type MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { groupColor } from "../../lib/colors";
import { classifyCcd } from "../../lib/cpu";
import { translate } from "../../lib/i18n";
import { formatBytes } from "../../lib/format";
import type { CpuTopology, ProcInfo } from "../../lib/ipc";
import { useGroups, type GroupRule } from "../../store/groups";
import { useSettings } from "../../store/settings";
import { TableBodyState } from "../taskmgr/TmProcessTable";

export type SortKey = "name" | "group" | "threads" | "cpu" | "gpu" | "gpuMem" | "mem" | "power";

type Tf = (zh: string, en: string) => string;

interface ProcessTableProps {
  processes: ProcInfo[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  selected: Set<number>;
  onToggle: (pid: number) => void;
  onToggleAll: () => void;
  onRowContextMenu?: (e: MouseEvent, proc: ProcInfo) => void;
  topo: CpuTopology | null;
  /** Show a sortable "分组" column (used in the 全部进程 view). */
  showGroup?: boolean;
  /** First process read in flight — show a skeleton instead of an empty state. */
  loading?: boolean;
  /** First process read failed — show a retry/error state. */
  error?: boolean;
}

// The 分组 column is only present in the 全部进程 view; both literal templates
// appear in full so Tailwind's scanner picks them up.
const COLS_WITH_GROUP = "grid-cols-[28px_minmax(0,1fr)_124px_76px_88px_50px_92px_56px]";
const COLS_NO_GROUP = "grid-cols-[28px_minmax(0,1fr)_76px_88px_50px_92px_56px]";

// Skip layout/paint for rows scrolled out of view. `auto` lets the browser
// remember each row's real height after its first paint, so the scrollbar and
// scroll offsets stay exactly where they are today — this is a paint-cost cut,
// NOT virtualization: every row stays in the DOM, so Ctrl-F, scroll position
// and keyboard focus behave identically.
const ROW_CV = "[content-visibility:auto] [contain-intrinsic-size:auto_30px]";

/** Hardware threads + cluster a process spans (from its affinity mask). */
function HwThreads({ mask, topo, tf }: { mask: bigint; topo: CpuTopology | null; tf: Tf }) {
  const c = classifyCcd(mask, topo);
  if (c.count === 0) return <span className="nums text-right text-dim">—</span>;
  const dot =
    c.kind === "vcache" || c.kind === "pcore"
      ? "bg-vcache"
      : c.kind === "freq" || c.kind === "ecore"
        ? "bg-freq"
        : c.kind === "mixed" || c.kind === "standard"
          ? "bg-accent"
          : "bg-dim/60";
  const label =
    c.kind === "vcache"
      ? "V-Cache CCD"
      : c.kind === "freq"
        ? "频率 CCD"
        : c.kind === "pcore"
          ? "性能核"
          : c.kind === "ecore"
            ? "能效核"
            : c.kind === "standard"
              ? `CCD ${c.ccdId}`
              : c.kind === "mixed"
                ? "跨 CCD"
                : "全部核心";
  return (
    <span className="flex items-center justify-end gap-1.5" title={tf(`${c.count} 硬件线程 · ${label}`, `${c.count} hardware threads · ${translate(label, "en")}`)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="nums text-muted">{c.count}</span>
    </span>
  );
}

interface HeadProps {
  k: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}

function Head({ k, label, sortKey, sortDir, onSort, align = "right" }: HeadProps) {
  const active = sortKey === k;
  return (
    <button
      onClick={() => onSort(k)}
      className={cn(
        "hud-label no-drag flex cursor-pointer items-center gap-1 rounded-sm text-[9.5px] transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
        align === "right" ? "justify-end" : "justify-start",
        active ? "text-accent" : "text-muted",
      )}
    >
      {label}
      {active && (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
}

interface RowProps {
  p: ProcInfo;
  group: GroupRule | undefined;
  isSelected: boolean;
  cols: string;
  showGroup: boolean;
  topo: CpuTopology | null;
  tf: Tf;
  onToggle: (pid: number) => void;
  onRowContextMenu?: (e: MouseEvent, proc: ProcInfo) => void;
}

/**
 * A row re-renders only when something it actually draws moved.
 *
 * The comparator is field-wise rather than `prev.p === next.p` on purpose: the
 * shared process poller hands back the previous row object for unchanged
 * processes, but the group view builds its "not running" placeholder rows fresh
 * on every render (`groupRows` in CoreAssignment), so those would never be
 * reference-equal and would re-render 350 rows' worth of DOM diffing at 1.5 Hz
 * for nothing.
 */
function rowPropsEqual(a: RowProps, b: RowProps): boolean {
  if (
    a.group !== b.group ||
    a.isSelected !== b.isSelected ||
    a.cols !== b.cols ||
    a.showGroup !== b.showGroup ||
    a.topo !== b.topo ||
    a.tf !== b.tf ||
    a.onToggle !== b.onToggle ||
    a.onRowContextMenu !== b.onRowContextMenu
  ) {
    return false;
  }
  const x = a.p;
  const y = b.p;
  // Exactly the fields this row paints. `name` is in the list because Windows
  // recycles PIDs: same pid + same (zeroed) metrics can be a DIFFERENT process.
  return (
    x.pid === y.pid &&
    x.name === y.name &&
    x.cpu === y.cpu &&
    x.gpu === y.gpu &&
    x.mem === y.mem &&
    x.power === y.power &&
    x.affinity === y.affinity &&
    x.offline === y.offline
  );
}

const Row = memo(function Row({
  p,
  group,
  isSelected,
  cols,
  showGroup,
  topo,
  tf,
  onToggle,
  onRowContextMenu,
}: RowProps) {
  const offline = p.offline === true;
  return (
    <div
      onClick={() => onToggle(p.pid)}
      onContextMenu={(e) => onRowContextMenu?.(e, p)}
      className={cn(
        "grid cursor-pointer items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] transition-colors",
        ROW_CV,
        cols,
        isSelected
          ? "bg-accent/10 shadow-[inset_2px_0_0_0_var(--color-accent)]"
          : "hover:bg-surface2/50",
        offline && "opacity-65",
      )}
    >
      <span
        className={cn(
          "grid h-4 w-4 place-items-center rounded border transition-colors",
          isSelected ? "border-accent bg-accent" : "border-line-strong",
        )}
      >
        {/* bg-on-accent, not bg-white: this square sits ON the accent fill, and
            on the bright-accent themes (cyberpunk's neon yellow especially) a
            white square on it was invisible — selected read as unselected. */}
        {isSelected && <span className="h-2 w-2 rounded-[2px] bg-on-accent" />}
      </span>

      <div className="flex min-w-0 items-center gap-2">
        {group ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: groupColor(group.hue) }}
            title={group.name}
          />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-dim/40" />
        )}
        <span className={cn("truncate", offline ? "text-muted" : "text-ink")} title={p.name}>
          {p.name}
        </span>
        {offline && (
          <span className="shrink-0 rounded-full border border-line-strong/60 px-1.5 py-px text-[10px] font-medium text-dim">
            未运行
          </span>
        )}
      </div>

      {showGroup &&
        (group ? (
          <span
            className="max-w-full justify-self-start truncate rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{
              background: `color-mix(in oklch, ${groupColor(group.hue)} 16%, transparent)`,
              color: groupColor(group.hue),
            }}
            title={group.name}
          >
            {group.name}
          </span>
        ) : (
          <span className="justify-self-start text-[11.5px] text-dim">—</span>
        ))}

      <HwThreads mask={p.affinity} topo={topo} tf={tf} />

      {offline ? (
        <span className="nums text-right text-dim">—</span>
      ) : (
        <div className="flex items-center justify-end gap-1.5">
          <span className="relative h-1 w-8 overflow-hidden rounded-full bg-surface3">
            <span
              className={cn(
                "absolute inset-y-0 left-0 rounded-full transition-colors",
                p.cpu >= 60 ? "bg-warn" : "bg-accent",
              )}
              style={{ width: `${Math.min(p.cpu, 100)}%` }}
            />
          </span>
          <span className="nums w-[38px] text-right text-ink">{p.cpu.toFixed(1)}</span>
        </div>
      )}

      <span className="nums text-right text-dim">{p.gpu > 0.05 ? p.gpu.toFixed(1) : "—"}</span>
      <span className="nums text-right text-muted">{offline ? "—" : formatBytes(p.mem, 0)}</span>
      <span className="nums text-right text-dim">{p.power > 0.05 ? p.power.toFixed(0) : "—"}</span>
    </div>
  );
}, rowPropsEqual);

export function ProcessTable({
  processes,
  sortKey,
  sortDir,
  onSort,
  selected,
  onToggle,
  onToggleAll,
  onRowContextMenu,
  topo,
  showGroup = false,
  loading,
  error,
}: ProcessTableProps) {
  // One language subscription for the whole table instead of one `useTf()` per
  // row (every row previously subscribed to the settings store just to format a
  // tooltip). Built through `useMemo` rather than `useTf()` because `useTf`
  // returns a FRESH closure on every render — handed to a memoized row that
  // would make the comparator fail every tick and defeat the memo entirely.
  const lang = useSettings((s) => s.language);
  const tf = useMemo<Tf>(() => (zh, en) => (lang === "en" ? en : zh), [lang]);
  const groups = useGroups((s) => s.groups);
  const allOn = processes.length > 0 && processes.every((p) => selected.has(p.pid));
  const COLS = showGroup ? COLS_WITH_GROUP : COLS_NO_GROUP;

  // Pattern → group, rebuilt only when the groups themselves change.
  // `groupForProcess` is a linear scan over every group's pattern array; calling
  // it once per row turned the group lookup into O(rows × groups × patterns) on
  // every 1.5 s poll. First writer wins, matching `groupForProcess`'s
  // "first group whose patterns contain the name" semantics exactly.
  const groupByName = useMemo(() => {
    const m = new Map<string, GroupRule>();
    for (const g of groups) {
      for (const pat of g.patterns) {
        const key = pat.toLowerCase();
        if (!m.has(key)) m.set(key, g);
      }
    }
    return m;
  }, [groups]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/40">
      <div
        className={cn(
          "grid items-center gap-2 border-b border-line bg-surface2/60 px-3 py-2.5",
          COLS,
        )}
      >
        <button
          onClick={onToggleAll}
          title="全选 / 取消全选"
          className={cn(
            "grid h-4 w-4 cursor-pointer place-items-center rounded border transition-colors",
            allOn ? "border-accent bg-accent" : "border-line-strong hover:border-accent/60",
          )}
        >
          {/* On the accent fill — see the row checkbox above. */}
          {allOn && <span className="h-2 w-2 rounded-[2px] bg-on-accent" />}
        </button>
        <Head k="name" label="进程名" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        {showGroup && (
          <Head k="group" label="分组" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        )}
        <Head k="threads" label="硬件线程" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="cpu" label="CPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="gpu" label="GPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="mem" label="内存" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="power" label="电源" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {processes.map((p) => (
          <Row
            key={p.pid}
            p={p}
            group={groupByName.get(p.name.toLowerCase())}
            isSelected={selected.has(p.pid)}
            cols={COLS}
            showGroup={showGroup}
            topo={topo}
            tf={tf}
            onToggle={onToggle}
            onRowContextMenu={onRowContextMenu}
          />
        ))}
        {processes.length === 0 && (
          <TableBodyState
            loading={loading}
            error={error}
            emptyTag="NO PROCESSES"
            emptyLabel="没有匹配的进程"
          />
        )}
      </div>
    </div>
  );
}
