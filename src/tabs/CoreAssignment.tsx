import { CircleMinus, Copy, Cpu, ListTree, Plus, Search, SlidersHorizontal, X, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CoreGrid } from "../components/cores/CoreGrid";
import { GroupRail } from "../components/cores/GroupRail";
import { ProcessTable, type SortKey } from "../components/cores/ProcessTable";
import { Button } from "../components/ui/Button";
import { ColorPicker, type ColorAnchor } from "../components/ui/ColorPicker";
import { ContextMenu, type MenuState } from "../components/ui/ContextMenu";
import { Modal } from "../components/ui/Modal";
import { TabHeader } from "../components/ui/TabHeader";
import { useProcesses } from "../hooks/useProcesses";
import { groupColor } from "../lib/colors";
import { maskFromIds, popcount } from "../lib/cpu";
import { maskToCpuList } from "../lib/format";
import { api, type CpuTopology, type ProcInfo } from "../lib/ipc";
import { groupForProcess, maskToBigInt, useGroups, type GroupRule } from "../store/groups";
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

export function CoreAssignment() {
  const [topo, setTopo] = useState<CpuTopology | null>(null);
  const { processes } = useProcesses();

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

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedPids, setSelectedPids] = useState<Set<number>>(new Set());
  const [coreModalOpen, setCoreModalOpen] = useState(false);
  const [editMask, setEditMask] = useState<bigint>(0n);
  const [status, setStatus] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [colorAnchor, setColorAnchor] = useState<ColorAnchor | null>(null);
  const addBtnRef = useRef<HTMLDivElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    api.getTopology().then(setTopo).catch(() => undefined);
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

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "group" ? "asc" : "desc");
    }
  }

  function toggleSelect(pid: number) {
    setSelectedPids((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }

  function toggleAll() {
    setSelectedPids((prev) => {
      const allOn = visible.length > 0 && visible.every((p) => prev.has(p.pid));
      return allOn ? new Set() : new Set(visible.map((p) => p.pid));
    });
  }

  function openRowMenu(e: ReactMouseEvent, proc: ProcInfo) {
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
              setStatus(`已将 ${proc.name} 移出分组`);
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
          label: `添加到「${g.name}」`,
          icon: Plus,
          onClick: () => {
            assignProcess(g.id, proc.name);
            if (optimizationEnabled) void applyToProcess(g, proc).catch(() => undefined);
            setStatus(`已添加 ${proc.name} 到「${g.name}」`);
          },
        });
      }
    }
    if (group) {
      items.push({
        label: "立即应用核心分配",
        icon: Zap,
        onClick: () => {
          void applyToProcess(group, proc).catch(() => undefined);
          setStatus(`已对 ${proc.name} 应用「${group.name}」`);
        },
      });
      items.push({
        label: "从分组移出",
        icon: CircleMinus,
        onClick: () => {
          removeProcess(proc.name);
          void api.setAffinity(proc.pid, fullMask).catch(() => undefined);
          setStatus(`已将 ${proc.name} 移出分组`);
        },
      });
    }
    items.push({
      label: "结束进程",
      icon: X,
      danger: true,
      onClick: () => {
        void api
          .endTask(proc.pid)
          .then(() => setStatus(`已结束 ${proc.name}`))
          .catch(() => setStatus(`无法结束 ${proc.name}（受保护）`));
      },
    });
    items.push({ label: "复制名称", icon: Copy, onClick: () => void navigator.clipboard.writeText(proc.name) });
    items.push({ label: "复制 PID", icon: Copy, onClick: () => void navigator.clipboard.writeText(String(proc.pid)) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  async function applyToProcess(group: GroupRule, proc: ProcInfo) {
    const mask = group.mask === 0n ? fullMask : group.mask;
    await api.setAffinity(proc.pid, mask);
    if (group.priority !== 0x20) {
      try {
        await api.setPriority(proc.pid, group.priority);
      } catch {
        /* priority is best-effort */
      }
    }
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
    for (const proc of chosen) {
      assignProcess(target.id, proc.name);
      if (optimizationEnabled) {
        try {
          await applyToProcess(target, proc);
        } catch {
          failed += 1;
        }
      }
    }
    setSelectedPids(new Set());
    setStatus(
      `已添加 ${chosen.length} 个进程到「${target.name}」` +
        (failed ? ` · ${failed} 个受保护进程应用失败` : ""),
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
        label: `添加到「${g.name}」`,
        icon: Plus,
        onClick: () => void assignSelectedTo(g.id),
      })),
    });
  }

  /** Remove the selected member processes from the current group (group view). */
  async function removeSelected() {
    if (!selectedGroup) return;
    const chosen = groupRows(selectedGroup).filter((p) => selectedPids.has(p.pid));
    for (const proc of chosen) {
      removeProcess(proc.name);
      // Offline members aren't running, so there's no affinity to restore.
      if (proc.offline) continue;
      try {
        await api.setAffinity(proc.pid, fullMask);
      } catch {
        /* protected */
      }
    }
    setSelectedPids(new Set());
    setStatus(`已从「${selectedGroup.name}」移出 ${chosen.length} 个进程`);
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
    updateGroup(selectedGroup.id, { mask: editMask });
    setCoreModalOpen(false);
    if (optimizationEnabled) {
      for (const proc of membersOf(selectedGroup)) {
        try {
          await api.setAffinity(proc.pid, editMask === 0n ? fullMask : editMask);
        } catch {
          /* protected */
        }
      }
    }
    setStatus(`已更新「${selectedGroup.name}」的核心分配`);
  }

  async function handleToggleOptimization() {
    const enabling = !optimizationEnabled;
    toggleOptimization();
    for (const group of groups) {
      for (const proc of membersOf(group)) {
        try {
          if (enabling) await applyToProcess(group, proc);
          else await api.setAffinity(proc.pid, fullMask);
        } catch {
          /* protected */
        }
      }
    }
    setStatus(enabling ? "优化已启用 · 已重新应用所有分组规则" : "优化已停用 · 已恢复默认亲和性");
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
        icon={Cpu}
        title="进程核心分配"
        subtitle="将进程分组并绑定到指定 CPU 核心 / 线程 — CCD 感知调度"
      />
      <div className="flex min-h-0 flex-1">
        <GroupRail
          processes={processes}
          fullMask={fullMask}
          optimizationEnabled={optimizationEnabled}
          onToggleOptimization={handleToggleOptimization}
          onExport={exportGroups}
          onImport={importGroupsFromFile}
        />

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {selectedGroup ? (
              <>
                <button
                  ref={colorBtnRef}
                  onClick={openColorPicker}
                  title="自定义分组颜色"
                  className="no-drag grid h-[34px] w-[34px] shrink-0 cursor-pointer place-items-center rounded-lg border border-line bg-surface2 transition-colors hover:border-line-strong"
                >
                  <span
                    className="h-4 w-4 rounded-full glow-sm"
                    style={{ background: groupColor(selectedGroup.hue) }}
                  />
                </button>
                <input
                  value={selectedGroup.name}
                  onChange={(e) => updateGroup(selectedGroup.id, { name: e.target.value })}
                  className="no-drag w-40 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-[13px] font-medium text-ink outline-none transition-colors focus:border-accent/50"
                />
                <Button onClick={openCoreModal}>
                  <SlidersHorizontal size={14} /> 选择核心
                </Button>
                <span className="nums rounded-md border border-line bg-surface2/60 px-2 py-1 text-[11px] text-muted">
                  {selectedGroup.mask === 0n ? "全部核心" : `CPU ${maskToCpuList(selectedGroup.mask)}`}
                </span>
                <span className="text-[11.5px] text-dim">· {visible.length} 个进程</span>
                {!selectedGroup.builtin && (
                  <Button variant="danger" onClick={() => removeGroup(selectedGroup.id)}>
                    删除分组
                  </Button>
                )}
              </>
            ) : (
              <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <ListTree size={15} className="text-accent" /> 全部进程
                <span className="text-[11.5px] font-normal text-dim">{visible.length} 个进程</span>
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              <div className="no-drag relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索进程…"
                  className="w-48 rounded-lg border border-line bg-surface2 py-1.5 pl-8 pr-3 text-[12.5px] text-ink outline-none transition-colors focus:border-accent/50"
                />
              </div>
              {selectedGroup ? (
                <Button variant="danger" onClick={removeSelected} disabled={selectedPids.size === 0}>
                  <CircleMinus size={14} /> 移出分组{selectedPids.size > 0 ? ` (${selectedPids.size})` : ""}
                </Button>
              ) : (
                <div ref={addBtnRef}>
                  <Button
                    variant="primary"
                    onClick={openAddMenu}
                    disabled={selectedPids.size === 0 || groups.length === 0}
                  >
                    <Plus size={14} /> 添加到分组{selectedPids.size > 0 ? ` (${selectedPids.size})` : ""} ▾
                  </Button>
                </div>
              )}
            </div>
          </div>

          <AnimatePresence>
            {status && (
              <motion.div
                key={status}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="flex items-center gap-2 text-[11.5px] text-accent"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent glow-sm" />
                {status}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Keyed on the selected group so the list animates only when switching
              groups (not on the ~1.5s data poll, which keeps the same key).
              mode="wait" matches the main tab switch: old list eases out, then the
              new one eases in — a moderate, comfortable pace rather than snappy. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={selectedId ?? "__all__"}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: [0.33, 1, 0.68, 1] }}
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
              />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {topo && (
        <Modal
          open={coreModalOpen}
          onClose={() => setCoreModalOpen(false)}
          title={`选择核心 — ${selectedGroup?.name ?? ""}`}
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
