import { ChevronDown, CircleMinus, Copy, Cpu, Loader2, Plus, Search, SlidersHorizontal, Trash2, X, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { CoreGrid } from "../components/cores/CoreGrid";
import { LiveCoreMap } from "../components/cores/CoreMap";
import { GroupRail } from "../components/cores/GroupRail";
import { ProcessTable } from "../components/cores/ProcessTable";
import { Button } from "../components/ui/Button";
import { ColorPicker, type ColorAnchor } from "../components/ui/ColorPicker";
import { ContextMenu, type MenuState } from "../components/ui/ContextMenu";
import { Modal } from "../components/ui/Modal";
import { Panel } from "../components/ui/Panel";
import { Badge } from "../components/ui/Readout";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { useProcesses } from "../hooks/useProcesses";
import { groupColor } from "../lib/colors";
import { cn } from "../lib/cn";
import { useTf } from "../lib/i18n";
import { easeOut } from "../lib/motion";
import { maskFromIds, popcount } from "../lib/cpu";
import { maskToCpuList } from "../lib/format";
import { api, type CpuTopology, type ProcInfo } from "../lib/ipc";
import { getTopologyOnce } from "../lib/memoOnce";
import { groupForProcess, maskToBigInt, useGroups, type GroupRule } from "../store/groups";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";

/**
 * A stable, negative pseudo-pid for an offline (added-but-not-running) member,
 * derived from its exe name. Negative so it can never collide with a real
 * Windows pid (always ≥ 0); stable so row selection survives re-renders.
 */
function offlinePid(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  }
  return -(Math.abs(h) + 1);
}

function getErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function CoreAssignment() {
  const tf = useTf();
  const [topo, setTopo] = useState<CpuTopology | null>(null);
  const { processes, loading, error } = useProcesses();
  const ccdNoticeSeen = useSettings((s) => s.ccdNoticeSeen);
  const setSettings = useSettings((s) => s.update);
  const [ccdNoticeVisible, setCcdNoticeVisible] = useState(false);

  // CCD cluster notice: show once on first run, then auto-dismiss after a few
  // seconds and remember it (persisted) so it never reappears.
  useEffect(() => {
    if (!topo || ccdNoticeSeen) return;
    setCcdNoticeVisible(true);
    const t = setTimeout(() => {
      setCcdNoticeVisible(false);
      setSettings({ ccdNoticeSeen: true });
    }, 9000);
    return () => clearTimeout(t);
  }, [topo, ccdNoticeSeen, setSettings]);

  const groups = useGroups((s) => s.groups);
  const selectedId = useGroups((s) => s.selectedId);
  const addGroup = useGroups((s) => s.addGroup);
  const updateGroup = useGroups((s) => s.updateGroup);
  const removeGroup = useGroups((s) => s.removeGroup);
  const assignProcess = useGroups((s) => s.assignProcess);
  const removeProcess = useGroups((s) => s.removeProcess);
  const importGroups = useGroups((s) => s.importGroups);
  const seeded = useGroups((s) => s.seeded);
  const markSeeded = useGroups((s) => s.markSeeded);

  const optimizationEnabled = useUi((s) => s.optimizationEnabled);
  const toggleOptimization = useUi((s) => s.toggleOptimization);
  const optimizeOnStartup = useUi((s) => s.optimizeOnStartup);
  const setOptimizeOnStartup = useUi((s) => s.setOptimizeOnStartup);

  // Filter + sort live in the UI store: App.tsx remounts this tab from scratch
  // every time the user comes back to it, which used to clear the search box and
  // snap the table back to CPU-descending mid-triage.
  const search = useUi((s) => s.coreSearch);
  const setSearch = useUi((s) => s.setCoreSearch);
  const sortKey = useUi((s) => s.coreSortKey);
  const sortDir = useUi((s) => s.coreSortDir);
  const [selectedPids, setSelectedPids] = useState<Set<number>>(new Set());
  const [coreModalOpen, setCoreModalOpen] = useState(false);
  const [editMask, setEditMask] = useState<bigint>(0n);
  const [pendingKill, setPendingKill] = useState<ProcInfo | null>(null);
  const [pendingDelGroup, setPendingDelGroup] = useState<GroupRule | null>(null);
  const [status, setStatus] = useState("");
  // Action feedback fades after a few seconds instead of lingering.
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(""), 4000);
    return () => window.clearTimeout(id);
  }, [status]);
  // True while the optimization toggle's per-process apply/restore sweep runs.
  const [optBusy, setOptBusy] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [colorAnchor, setColorAnchor] = useState<ColorAnchor | null>(null);
  const addBtnRef = useRef<HTMLDivElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);

  // Memoized for the session: topology cannot change while the process lives,
  // but this tab is remounted on every visit, so it used to re-issue the IPC
  // (and flash an empty core grid) each time.
  useEffect(() => {
    getTopologyOnce().then(setTopo).catch(() => undefined);
  }, []);

  // Clear the multi-select (and close the color popover) when switching views.
  useEffect(() => {
    setSelectedPids(new Set());
    setColorAnchor(null);
  }, [selectedId]);

  const fullMask = useMemo(() => (topo ? maskFromIds(topo.logical.map((l) => l.id)) : 0n), [topo]);

  // Wait for the persisted groups store to finish its (async) hydration before
  // seeding. Otherwise the seeder races rehydration and overwrites saved groups
  // with the two defaults (this clobbered a custom group once).
  const [groupsHydrated, setGroupsHydrated] = useState(() => useGroups.persist.hasHydrated());
  useEffect(() => {
    if (groupsHydrated) return;
    return useGroups.persist.onFinishHydration(() => setGroupsHydrated(true));
  }, [groupsHydrated]);

  // Seed sensible default groups once on first run (only after hydration).
  useEffect(() => {
    if (!topo || !groupsHydrated) return;
    if (seeded || groups.length > 0) {
      if (!seeded) markSeeded();
      return;
    }
    const vcache = topo.ccds.find((c) => c.isVcache);
    const all = maskFromIds(topo.logical.map((l) => l.id));
    // Gaming group target, generalized across hardware:
    //  • X3D: the 3D V-Cache CCD (best gaming cores)
    //  • non-X3D multi-CCD: the first CCD (keep a game on one CCD → less
    //    cross-CCD latency) so 游戏 ≠ 全核
    //  • single cluster (most Intel / single-CCD Ryzen): all cores
    const gamingMask = vcache
      ? maskFromIds(vcache.logicalCpus)
      : topo.ccds.length > 1
        ? maskFromIds(topo.ccds[0].logicalCpus)
        : all;
    addGroup({
      name: "游戏",
      hue: 182,
      mask: gamingMask,
      priority: 0x8000,
      patterns: [],
      builtin: true,
    });
    addGroup({ name: "全核", hue: 274, mask: all, priority: 0x20, patterns: [], builtin: true });
    markSeeded();
  }, [topo, groupsHydrated, seeded, groups.length, addGroup, markSeeded]);

  const selectedGroup = groups.find((g) => g.id === selectedId) ?? null;

  const visible = useMemo(() => {
    // Never show non-adjustable system processes anywhere in core-assignment:
    // the 全部进程 view lists all adjustable processes, and a group view shows
    // its full membership (running members + greyed "not running" placeholders),
    // both filtered to entries whose affinity can be set.
    const base = selectedGroup ? groupRows(selectedGroup) : processes;
    const source = base.filter((p) => p.settable);
    const q = search.trim().toLowerCase();
    const filtered = q ? source.filter((p) => p.name.toLowerCase().includes(q)) : source;
    const sorted = [...filtered].sort((a, b) => {
      let r = 0;
      switch (sortKey) {
        case "name":
          r = a.name.localeCompare(b.name);
          break;
        case "group": {
          const ga = groupForProcess(groups, a.name)?.name ?? "";
          const gb = groupForProcess(groups, b.name)?.name ?? "";
          // Ungrouped (empty) always sorts to the bottom regardless of direction.
          if (!ga !== !gb) return ga ? -1 : 1;
          r = ga.localeCompare(gb);
          break;
        }
        case "threads":
          r = popcount(a.affinity) - popcount(b.affinity);
          break;
        case "cpu":
          r = a.cpu - b.cpu;
          break;
        case "gpu":
          r = a.gpu - b.gpu;
          break;
        case "mem":
          r = a.mem - b.mem;
          break;
        case "power":
          r = a.power - b.power;
          break;
      }
      return sortDir === "asc" ? r : -r;
    });
    return sorted;
  }, [processes, search, sortKey, sortDir, selectedGroup, fullMask, groups]);

  // ── Stable row callbacks ────────────────────────────────────────────────
  // ProcessTable's rows are `memo`ized; a callback prop that is re-created on
  // every render makes the comparator fail for EVERY row on EVERY 1.5 s poll,
  // which silently undoes the memo. The values these handlers need change on
  // every poll (`visible`) so they are read through a ref instead of a
  // dependency array. Invariant: nothing reads these refs during render —
  // only user-event handlers, which always run after the commit that wrote
  // them, so there is no torn-read window. `handleSort` needs no ref at all:
  // it is a zustand action, whose identity is stable for the app's lifetime.
  const visibleRef = useRef<ProcInfo[]>([]);
  visibleRef.current = visible;

  const handleSort = useUi((s) => s.setCoreSort);

  const toggleSelect = useCallback((pid: number) => {
    setSelectedPids((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    const rows = visibleRef.current;
    setSelectedPids((prev) => {
      const allOn = rows.length > 0 && rows.every((p) => prev.has(p.pid));
      return allOn ? new Set() : new Set(rows.map((p) => p.pid));
    });
  }, []);

  function openRowMenuImpl(e: ReactMouseEvent, proc: ProcInfo) {
    e.preventDefault();
    // Offline placeholder: not running, so only membership actions apply.
    if (proc.offline) {
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: "从分组移出",
            icon: CircleMinus,
            onClick: () => {
              removeProcess(proc.name);
              setStatus(tf(`已将 ${proc.name} 移出分组`, `Removed ${proc.name} from group`));
            },
          },
          { label: "复制名称", icon: Copy, onClick: () => void navigator.clipboard.writeText(proc.name) },
        ],
      });
      return;
    }
    const group = groups.find((g) => g.patterns.includes(proc.name.toLowerCase()));
    const items: MenuState["items"] = [];
    if (!selectedGroup) {
      // 全部进程: explicit per-group add choices (no silent default group).
      for (const g of groups) {
        items.push({
          label: tf(`添加到「${g.name}」`, `Add to “${g.name}”`),
          icon: Plus,
          onClick: () => {
            assignProcess(g.id, proc.name);
            if (optimizationEnabled) {
              void applyToProcess(g, proc)
                .then((r) =>
                  setStatus(
                    r.priorityFailed
                      ? tf(`已添加 ${proc.name} 到「${g.name}」（优先级未生效）`, `Added ${proc.name} to “${g.name}” (priority not changed)`)
                      : tf(`已添加 ${proc.name} 到「${g.name}」并应用`, `Added ${proc.name} to “${g.name}” and applied`),
                  ),
                )
                .catch((e: unknown) =>
                  setStatus(tf(`已添加到「${g.name}」，但立即应用失败：${getErrorMessage(e)}`, `Added to “${g.name}”, but apply failed: ${getErrorMessage(e)}`)),
                );
            } else {
              setStatus(tf(`已添加 ${proc.name} 到「${g.name}」`, `Added ${proc.name} to “${g.name}”`));
            }
          },
        });
      }
    }
    if (group) {
      items.push({
        label: "立即应用核心分配",
        icon: Zap,
        onClick: () => {
          void applyToProcess(group, proc)
            .then((r) =>
              setStatus(
                r.priorityFailed
                  ? tf(`已对 ${proc.name} 应用核心分配（优先级未生效）`, `Applied cores to ${proc.name} (priority not changed)`)
                  : tf(`已对 ${proc.name} 应用「${group.name}」`, `Applied “${group.name}” to ${proc.name}`),
              ),
            )
            .catch((e: unknown) =>
              setStatus(tf(`应用失败：${getErrorMessage(e)}`, `Apply failed: ${getErrorMessage(e)}`)),
            );
        },
      });
      items.push({
        label: "从分组移出",
        icon: CircleMinus,
        onClick: () => {
          removeProcess(proc.name);
          void api
            .setAffinity(proc.pid, fullMask)
            .then(() => setStatus(tf(`已将 ${proc.name} 移出分组`, `Removed ${proc.name} from group`)))
            .catch((e: unknown) =>
              setStatus(tf(`已移出分组，但恢复全核失败：${getErrorMessage(e)}`, `Removed from group, but restoring all cores failed: ${getErrorMessage(e)}`)),
            );
        },
      });
    }
    items.push({
      label: "结束进程",
      icon: X,
      danger: true,
      // Mirror Task Manager: confirm via Modal before the destructive end-task.
      onClick: () => setPendingKill(proc),
    });
    items.push({ label: "复制名称", icon: Copy, onClick: () => void navigator.clipboard.writeText(proc.name) });
    items.push({ label: "复制 PID", icon: Copy, onClick: () => void navigator.clipboard.writeText(String(proc.pid)) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  // The context-menu builder closes over half this component's state, so it can
  // never be a stable `useCallback`. Hand the rows a constant trampoline and
  // keep the real implementation in a ref instead — same "written in render,
  // only ever read from a user-event handler" invariant as the refs above.
  const openRowMenuRef = useRef(openRowMenuImpl);
  openRowMenuRef.current = openRowMenuImpl;
  const openRowMenu = useCallback(
    (e: ReactMouseEvent, proc: ProcInfo) => openRowMenuRef.current(e, proc),
    [],
  );

  // Mirror ProcessView.confirmKill: end the task once the user confirms.
  async function confirmKill() {
    if (!pendingKill) return;
    const target = pendingKill;
    setPendingKill(null);
    try {
      await api.endTask(target.pid);
      setStatus(tf(`已结束 ${target.name}`, `Ended ${target.name}`));
    } catch {
      setStatus(tf(`无法结束 ${target.name}（受保护）`, `Couldn't end ${target.name} (protected)`));
    }
  }

  async function applyToProcess(group: GroupRule, proc: ProcInfo): Promise<{ priorityFailed: boolean }> {
    const mask = group.mask === 0n ? fullMask : group.mask;
    await api.setAffinity(proc.pid, mask);
    if (group.priority !== 0x20) {
      try {
        await api.setPriority(proc.pid, group.priority);
      } catch {
        // Affinity took but the priority change didn't — report it instead of
        // claiming a full success.
        return { priorityFailed: true };
      }
    }
    return { priorityFailed: false };
  }

  /** Running processes that belong to a group (used for affinity/priority ops). */
  function membersOf(group: GroupRule): ProcInfo[] {
    const names = new Set(group.patterns);
    return processes.filter((p) => names.has(p.name.toLowerCase()));
  }

  /**
   * All rows to display for a group: every running member, plus a greyed
   * placeholder for each member that has been added but is not running right
   * now. This lets the group view show its full membership, not just whatever
   * happens to be alive — e.g. a game you added but haven't launched yet.
   */
  function groupRows(group: GroupRule): ProcInfo[] {
    const names = new Set(group.patterns);
    const running = new Map<string, ProcInfo[]>();
    for (const p of processes) {
      const n = p.name.toLowerCase();
      if (!names.has(n)) continue;
      const arr = running.get(n);
      if (arr) arr.push(p);
      else running.set(n, [p]);
    }
    const effectiveMask = group.mask === 0n ? fullMask : group.mask;
    const rows: ProcInfo[] = [];
    for (const pattern of group.patterns) {
      const live = running.get(pattern);
      if (live && live.length) {
        rows.push(...live);
      } else {
        rows.push({
          pid: offlinePid(pattern),
          name: pattern,
          cpu: 0,
          mem: 0,
          threads: 0,
          gpu: 0,
          power: 0,
          // Show the CPU set this member *will* get once it launches.
          affinity: effectiveMask,
          settable: true,
          offline: true,
        });
      }
    }
    return rows;
  }

  async function assignSelectedTo(groupId: string) {
    const target = groups.find((g) => g.id === groupId) ?? null;
    if (!target) return;
    const chosen = processes.filter((p) => selectedPids.has(p.pid));
    let failed = 0;
    let prioFailed = 0;
    for (const proc of chosen) {
      assignProcess(target.id, proc.name);
      if (optimizationEnabled) {
        try {
          const r = await applyToProcess(target, proc);
          if (r.priorityFailed) prioFailed += 1;
        } catch {
          failed += 1;
        }
      }
    }
    setSelectedPids(new Set());
    setStatus(
      tf(
        `已添加 ${chosen.length} 个进程到「${target.name}」` +
          (failed ? ` · ${failed} 个受保护进程应用失败` : "") +
          (prioFailed ? ` · ${prioFailed} 个优先级未生效` : ""),
        `Added ${chosen.length} processes to “${target.name}”` +
          (failed ? ` · ${failed} protected processes failed` : "") +
          (prioFailed ? ` · ${prioFailed} priority not changed` : ""),
      ),
    );
  }

  // Open a menu under the "添加到分组" button so the user picks the target group.
  function openAddMenu() {
    if (groups.length === 0) {
      setStatus("请先在左侧创建一个分组");
      return;
    }
    const r = addBtnRef.current?.getBoundingClientRect();
    setMenu({
      x: r ? Math.round(r.left) : 320,
      y: r ? Math.round(r.bottom + 6) : 120,
      items: groups.map((g) => ({
        label: tf(`添加到「${g.name}」`, `Add to “${g.name}”`),
        icon: Plus,
        onClick: () => void assignSelectedTo(g.id),
      })),
    });
  }

  /** Remove the selected member processes from the current group (group view). */
  async function removeSelected() {
    if (!selectedGroup) return;
    const chosen = groupRows(selectedGroup).filter((p) => selectedPids.has(p.pid));
    let failed = 0;
    for (const proc of chosen) {
      removeProcess(proc.name);
      // Offline members aren't running, so there's no affinity to restore.
      if (proc.offline) continue;
      try {
        await api.setAffinity(proc.pid, fullMask);
      } catch {
        failed += 1;
      }
    }
    setSelectedPids(new Set());
    setStatus(
      tf(
        `已从「${selectedGroup.name}」移出 ${chosen.length} 个进程` + (failed ? ` · ${failed} 个恢复全核失败` : ""),
        `Removed ${chosen.length} processes from “${selectedGroup.name}”` + (failed ? ` · ${failed} couldn't restore all cores` : ""),
      ),
    );
  }

  function openColorPicker() {
    const r = colorBtnRef.current?.getBoundingClientRect();
    setColorAnchor({ x: r ? Math.round(r.left) : 320, y: r ? Math.round(r.bottom + 6) : 120 });
  }

  function openCoreModal() {
    if (!selectedGroup) return;
    setEditMask(selectedGroup.mask);
    setCoreModalOpen(true);
  }

  async function saveCoreMask() {
    if (!selectedGroup) return;
    const group = selectedGroup;
    updateGroup(group.id, { mask: editMask });
    setCoreModalOpen(false);
    let failed = 0;
    if (optimizationEnabled) {
      for (const proc of membersOf(group)) {
        try {
          await api.setAffinity(proc.pid, editMask === 0n ? fullMask : editMask);
        } catch {
          failed += 1;
        }
      }
    }
    setStatus(
      tf(
        `已更新「${group.name}」的核心分配` + (failed ? ` · ${failed} 个进程应用失败` : ""),
        `Updated core assignment for “${group.name}”` + (failed ? ` · ${failed} processes failed to apply` : ""),
      ),
    );
  }

  async function handleToggleOptimization() {
    // Lock out re-entry: the sweep below awaits one IPC per process and can take
    // seconds — a second click mid-sweep would interleave an apply pass with a
    // restore pass, leaving affinities in an arbitrary mix of the two.
    if (optBusy) return;
    setOptBusy(true);
    const enabling = !optimizationEnabled;
    toggleOptimization();
    let failed = 0;
    let prioFailed = 0;
    for (const group of groups) {
      for (const proc of membersOf(group)) {
        try {
          if (enabling) {
            const r = await applyToProcess(group, proc);
            if (r.priorityFailed) prioFailed += 1;
          } else {
            await api.setAffinity(proc.pid, fullMask);
          }
        } catch {
          failed += 1;
        }
      }
    }
    const base = enabling ? "优化已启用 · 已重新应用所有分组规则" : "优化已停用 · 已恢复默认亲和性";
    const baseEn = enabling ? "Optimization on · all group rules re-applied" : "Optimization off · default affinity restored";
    const note = tf(
      (failed ? `（${failed} 个进程失败）` : "") + (prioFailed ? `（${prioFailed} 个优先级未生效）` : ""),
      (failed ? ` (${failed} failed)` : "") + (prioFailed ? ` (${prioFailed} priority not changed)` : ""),
    );
    setStatus(failed || prioFailed ? `${tf(base, baseEn)}${note}` : base);
    setOptBusy(false);
  }

  function exportGroups() {
    // `mask` is a bigint, which JSON.stringify can't emit — serialize it as a
    // decimal string so the exported file is plain, portable JSON.
    const json = JSON.stringify(
      groups,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    );
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "corepilot-groups.json";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("已导出分组方案");
  }

  function importGroupsFromFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data: unknown = JSON.parse(await file.text());
        if (Array.isArray(data)) {
          // Exported masks are decimal strings (older files may have numbers);
          // coerce each back to bigint to match GroupRule.mask.
          const normalized = (data as GroupRule[]).map((g) => ({
            ...g,
            mask: maskToBigInt((g as { mask: unknown }).mask),
          }));
          importGroups(normalized);
          setStatus("已导入分组方案");
        }
      } catch {
        setStatus("导入失败：文件无效");
      }
    };
    input.click();
  }

  return (
    <>
      <TabHeader
        title="进程核心分配"
        subtitle="将进程分组并绑定到指定 CPU 核心 / 线程 — CCD 感知调度"
        actions={
          <label className="flex cursor-pointer items-center gap-3">
            <span className="text-right">
              <span className="block text-[13px] font-medium text-ink">{tf("亲和性优化", "Affinity optimization")}</span>
              <span className={cn("block text-[11.5px]", optimizationEnabled ? "text-ok" : "text-dim")}>
                {optBusy
                  ? tf("应用中…", "Applying…")
                  : optimizationEnabled
                    ? tf("运行中 · 按分组绑定核心", "On · pinning cores by group")
                    : tf("已停用", "Off")}
              </span>
            </span>
            {optBusy && <Loader2 size={15} className="animate-spin text-muted" />}
            <Toggle
              checked={optimizationEnabled}
              disabled={optBusy}
              onChange={() => void handleToggleOptimization()}
              label={tf("亲和性优化总开关", "Affinity optimization master switch")}
            />
          </label>
        }
      />
      <AnimatePresence>
        {topo && ccdNoticeVisible && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: easeOut }}
            className="overflow-hidden"
          >
            <div
              className={cn(
                "mx-6 mb-3 flex items-center gap-2.5 rounded-lg px-3.5 py-2 text-[12.5px] ring-1 ring-inset",
                topo.ccds.length > 1 ? "bg-surface2/60 text-muted ring-line" : "bg-warn/10 text-warn ring-warn/25",
              )}
            >
              <Cpu size={14} className="shrink-0" />
              <span className="min-w-0">
                {topo.ccds.length > 1
                  ? tf(
                      `检测到 ${topo.ccds.length} 个核心簇（CCD）· 支持按 CCD 分配核心`,
                      `${topo.ccds.length} core clusters (CCDs) detected · CCD-aware core assignment supported`,
                    )
                  : tf(
                      "单核心簇 CPU（如 9800X3D / 多数 Intel）：所有核心等价，按 CCD 分配收益有限，但仍可将进程固定到指定核心。",
                      "Single-cluster CPU (e.g. 9800X3D / most Intel): all cores are equivalent, so CCD grouping has limited benefit — you can still pin processes to specific cores.",
                    )}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex min-h-0 flex-1">
        <GroupRail
          processes={processes}
          fullMask={fullMask}
          optimizeOnStartup={optimizeOnStartup}
          onToggleOptimizeOnStartup={() => setOptimizeOnStartup(!optimizeOnStartup)}
          onExport={exportGroups}
          onImport={importGroupsFromFile}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-5 pb-6">
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            {selectedGroup ? (
              <>
                <button
                  ref={colorBtnRef}
                  type="button"
                  onClick={openColorPicker}
                  title={tf("自定义分组颜色", "Group color")}
                  aria-label={tf("自定义分组颜色", "Group color")}
                  className="no-drag grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md transition-colors hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <span className="h-3.5 w-3.5 rounded-full" style={{ background: groupColor(selectedGroup.hue) } as CSSProperties} />
                </button>
                <input
                  value={selectedGroup.name}
                  onChange={(e) => updateGroup(selectedGroup.id, { name: e.target.value })}
                  aria-label={tf("分组名称", "Group name")}
                  title={tf("点击重命名", "Click to rename")}
                  className="no-drag h-8 min-w-16 max-w-64 rounded-md bg-transparent px-2 [field-sizing:content] text-[15px] font-semibold text-ink outline-none transition-[background-color,box-shadow] duration-150 hover:bg-surface2 focus:bg-surface2 focus:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                />
                {selectedGroup.builtin && <Badge>{tf("内置", "Built-in")}</Badge>}
                <span className="nums text-[12px] text-dim">{tf(`${visible.length} 个进程`, `${visible.length} processes`)}</span>
              </>
            ) : (
              <span className="flex items-baseline gap-2 px-1">
                <span className="text-[15px] font-semibold text-ink">{tf("全部进程", "All processes")}</span>
                <span className="nums text-[12px] text-dim">{tf(`${visible.length} 个可调整`, `${visible.length} adjustable`)}</span>
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              <label className="field no-drag flex w-52 items-center gap-2">
                <Search size={14} className="shrink-0 text-dim" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索进程…"
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none"
                />
                {search && (
                  <button type="button" onClick={() => setSearch("")} aria-label={tf("清除搜索", "Clear search")} className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded text-dim hover:bg-surface3 hover:text-ink">
                    <X size={12} />
                  </button>
                )}
              </label>
              {selectedGroup ? (
                <>
                  <Button variant="danger" onClick={removeSelected} disabled={selectedPids.size === 0}>
                    <CircleMinus size={14} /> {tf("移出分组", "Remove from group")}
                    {selectedPids.size > 0 ? ` (${selectedPids.size})` : ""}
                  </Button>
                  {!selectedGroup.builtin && (
                    <Button
                      variant="subtle"
                      ariaLabel={tf("删除分组", "Delete group")}
                      title={tf("删除分组", "Delete group")}
                      onClick={() => setPendingDelGroup(selectedGroup)}
                      className="w-8 px-0 hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </>
              ) : (
                <div ref={addBtnRef}>
                  <Button variant="primary" onClick={openAddMenu} disabled={selectedPids.size === 0 || groups.length === 0}>
                    <Plus size={14} /> {tf("添加到分组", "Add to group")}
                    {selectedPids.size > 0 ? ` (${selectedPids.size})` : ""}
                    <ChevronDown size={13} className="-mr-0.5 opacity-80" />
                  </Button>
                </div>
              )}
            </div>
          </div>

          {topo && (
            <Panel
              title={selectedGroup ? "核心映射" : "CPU 拓扑"}
              desc={
                selectedGroup
                  ? selectedGroup.mask === 0n
                    ? tf("全部核心 · 格内填充为实时负载", "All cores · fill shows live load")
                    : tf(`CPU ${maskToCpuList(selectedGroup.mask)} · 格内填充为实时负载`, `CPU ${maskToCpuList(selectedGroup.mask)} · fill shows live load`)
                  : tf("每列一个物理核心，下方为其 SMT 线程 · 填充为实时负载", "One column per physical core, SMT thread beneath · fill shows live load")
              }
              actions={
                selectedGroup && (
                  <Button size="sm" onClick={openCoreModal}>
                    <SlidersHorizontal size={13} /> {tf("选择核心", "Select cores")}
                  </Button>
                )
              }
            >
              <LiveCoreMap
                topo={topo}
                mask={selectedGroup ? selectedGroup.mask : null}
                color={selectedGroup ? groupColor(selectedGroup.hue) : undefined}
              />
            </Panel>
          )}

          <AnimatePresence>
            {status && (
              <motion.div
                key={status}
                role="status"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: easeOut }}
                className="overflow-hidden text-[12px] text-muted"
              >
                {status}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Keyed on the selected group so the list crossfades only when
              switching groups (not on the ~1.5s data poll, which keeps the key). */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={selectedId ?? "__all__"}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: easeOut } }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <ProcessTable
                processes={visible}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                selected={selectedPids}
                onToggle={toggleSelect}
                onToggleAll={toggleAll}
                onRowContextMenu={openRowMenu}
                topo={topo}
                showGroup={!selectedGroup}
                loading={loading && !selectedGroup}
                error={error && !selectedGroup}
                emptyLabel={selectedGroup && !search ? tf("这个分组还没有进程", "This group has no processes yet") : undefined}
                emptyHint={
                  selectedGroup && !search
                    ? tf("在「全部进程」里勾选进程，再点「添加到分组」。", "Tick processes under “All processes”, then “Add to group”.")
                    : undefined
                }
              />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {topo && (
        <Modal
          open={coreModalOpen}
          onClose={() => setCoreModalOpen(false)}
          title={tf(`选择核心 — ${selectedGroup?.name ?? ""}`, `Select cores — ${selectedGroup?.name ?? ""}`)}
          footer={
            <>
              <Button onClick={() => setCoreModalOpen(false)}>取消</Button>
              <Button variant="primary" onClick={saveCoreMask}>
                确定
              </Button>
            </>
          }
        >
          <CoreGrid topo={topo} mask={editMask} onChange={setEditMask} />
        </Modal>
      )}
      <Modal
        open={!!pendingKill}
        onClose={() => setPendingKill(null)}
        title="结束进程"
        footer={
          <>
            <Button onClick={() => setPendingKill(null)}>取消</Button>
            <Button variant="danger" onClick={confirmKill}>
              结束进程
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          {tf("确定要结束", "End")} <span className="font-semibold text-ink">{pendingKill?.name}</span>{" "}
          (PID {pendingKill?.pid}){tf("吗？未保存的数据将丢失。", "? Unsaved data will be lost.")}
        </p>
      </Modal>
      <Modal
        open={!!pendingDelGroup}
        onClose={() => setPendingDelGroup(null)}
        title="删除分组"
        footer={
          <>
            <Button onClick={() => setPendingDelGroup(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelGroup) removeGroup(pendingDelGroup.id);
                setPendingDelGroup(null);
              }}
            >
              删除分组
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          {tf(
            `确定删除分组「${pendingDelGroup?.name ?? ""}」（${pendingDelGroup?.patterns.length ?? 0} 个进程规则）吗？此操作不影响正在运行的进程，仅移除分组规则。`,
            `Delete the group “${pendingDelGroup?.name ?? ""}” (${pendingDelGroup?.patterns.length ?? 0} process rules)? Running processes are unaffected — only the group rules are removed.`,
          )}
        </p>
      </Modal>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <ColorPicker
        anchor={colorAnchor}
        hue={selectedGroup?.hue ?? 280}
        onChange={(hue) => selectedGroup && updateGroup(selectedGroup.id, { hue })}
        onClose={() => setColorAnchor(null)}
      />
    </>
  );
}
