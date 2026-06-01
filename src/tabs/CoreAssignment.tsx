import { CircleMinus, Copy, Cpu, ListTree, Plus, Search, SlidersHorizontal, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CoreGrid } from "../components/cores/CoreGrid";
import { GroupRail } from "../components/cores/GroupRail";
import { ProcessTable, type SortKey } from "../components/cores/ProcessTable";
import { Button } from "../components/ui/Button";
import { ContextMenu, type MenuState } from "../components/ui/ContextMenu";
import { Modal } from "../components/ui/Modal";
import { TabHeader } from "../components/ui/TabHeader";
import { useProcesses } from "../hooks/useProcesses";
import { maskFromIds, popcount } from "../lib/cpu";
import { maskToCpuList } from "../lib/format";
import { api, type CpuTopology, type ProcInfo } from "../lib/ipc";
import { useGroups, type GroupRule } from "../store/groups";
import { useUi } from "../store/ui";

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
  const [editMask, setEditMask] = useState(0);
  const [status, setStatus] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<string>("");

  useEffect(() => {
    api.getTopology().then(setTopo).catch(() => undefined);
  }, []);

  // Clear the multi-select when switching between 全部进程 and a group view.
  useEffect(() => {
    setSelectedPids(new Set());
  }, [selectedId]);

  // Keep the "add to group" target valid / defaulted to the first group.
  useEffect(() => {
    if (groups.length === 0) setTargetGroupId("");
    else if (!groups.some((g) => g.id === targetGroupId)) setTargetGroupId(groups[0].id);
  }, [groups, targetGroupId]);

  const fullMask = useMemo(() => (topo ? maskFromIds(topo.logical.map((l) => l.id)) : 0), [topo]);

  // Seed sensible default groups once on first run.
  useEffect(() => {
    if (!topo) return;
    if (seeded || groups.length > 0) {
      if (!seeded) markSeeded();
      return;
    }
    const vcache = topo.ccds.find((c) => c.isVcache);
    const all = maskFromIds(topo.logical.map((l) => l.id));
    addGroup({
      name: "游戏",
      hue: 182,
      mask: vcache ? maskFromIds(vcache.logicalCpus) : all,
      priority: 0x8000,
      patterns: [],
      builtin: true,
    });
    addGroup({ name: "全核", hue: 274, mask: all, priority: 0x20, patterns: [], builtin: true });
    markSeeded();
  }, [topo, seeded, groups.length, addGroup, markSeeded]);

  const selectedGroup = groups.find((g) => g.id === selectedId) ?? null;

  const visible = useMemo(() => {
    // Never show non-adjustable system processes anywhere in core-assignment:
    // the 全部进程 view lists all adjustable processes, and a group view shows
    // only its members — both filtered to processes whose affinity can be set.
    const base = selectedGroup ? membersOf(selectedGroup) : processes;
    const source = base.filter((p) => p.settable);
    const q = search.trim().toLowerCase();
    const filtered = q ? source.filter((p) => p.name.toLowerCase().includes(q)) : source;
    const sorted = [...filtered].sort((a, b) => {
      let r = 0;
      switch (sortKey) {
        case "name":
          r = a.name.localeCompare(b.name);
          break;
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
  }, [processes, search, sortKey, sortDir, selectedGroup]);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
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
    const group = groups.find((g) => g.patterns.includes(proc.name.toLowerCase()));
    const items: MenuState["items"] = [];
    const addTarget = selectedGroup ?? groups.find((g) => g.id === targetGroupId) ?? null;
    if (addTarget) {
      items.push({
        label: `添加到「${addTarget.name}」`,
        icon: Plus,
        onClick: () => {
          assignProcess(addTarget.id, proc.name);
          if (optimizationEnabled) void applyToProcess(addTarget, proc).catch(() => undefined);
          setStatus(`已添加 ${proc.name} 到「${addTarget.name}」`);
        },
      });
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
    const mask = group.mask === 0 ? fullMask : group.mask;
    await api.setAffinity(proc.pid, mask);
    if (group.priority !== 0x20) {
      try {
        await api.setPriority(proc.pid, group.priority);
      } catch {
        /* priority is best-effort */
      }
    }
  }

  function membersOf(group: GroupRule): ProcInfo[] {
    const names = new Set(group.patterns);
    return processes.filter((p) => names.has(p.name.toLowerCase()));
  }

  async function assignSelected() {
    const target = groups.find((g) => g.id === targetGroupId) ?? null;
    if (!target) {
      setStatus("请先创建一个分组");
      return;
    }
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

  /** Remove the selected member processes from the current group (group view). */
  async function removeSelected() {
    if (!selectedGroup) return;
    const chosen = membersOf(selectedGroup).filter((p) => selectedPids.has(p.pid));
    for (const proc of chosen) {
      removeProcess(proc.name);
      try {
        await api.setAffinity(proc.pid, fullMask);
      } catch {
        /* protected */
      }
    }
    setSelectedPids(new Set());
    setStatus(`已从「${selectedGroup.name}」移出 ${chosen.length} 个进程`);
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
          await api.setAffinity(proc.pid, editMask === 0 ? fullMask : editMask);
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
    const blob = new Blob([JSON.stringify(groups, null, 2)], { type: "application/json" });
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
          importGroups(data as GroupRule[]);
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
                <input
                  value={selectedGroup.name}
                  onChange={(e) => updateGroup(selectedGroup.id, { name: e.target.value })}
                  className="no-drag w-40 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-[13px] font-medium text-ink outline-none transition-colors focus:border-accent/50"
                />
                <Button onClick={openCoreModal}>
                  <SlidersHorizontal size={14} /> 选择核心
                </Button>
                <span className="nums text-[11.5px] text-dim">
                  {selectedGroup.mask === 0 ? "全部核心" : `CPU ${maskToCpuList(selectedGroup.mask)}`}
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
                <>
                  <select
                    value={targetGroupId}
                    onChange={(e) => setTargetGroupId(e.target.value)}
                    className="no-drag rounded-lg border border-line bg-surface2 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent/50"
                    title="添加到哪个分组"
                  >
                    {groups.length === 0 && <option value="">无分组</option>}
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="primary"
                    onClick={assignSelected}
                    disabled={selectedPids.size === 0 || groups.length === 0}
                  >
                    <Plus size={14} /> 添加到分组{selectedPids.size > 0 ? ` (${selectedPids.size})` : ""}
                  </Button>
                </>
              )}
            </div>
          </div>

          {status && <div className="text-[11.5px] text-accent">{status}</div>}

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
          />
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
    </>
  );
}
