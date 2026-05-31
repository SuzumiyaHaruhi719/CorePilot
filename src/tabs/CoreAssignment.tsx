import { Cpu, Plus, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CoreGrid } from "../components/cores/CoreGrid";
import { GroupRail } from "../components/cores/GroupRail";
import { ProcessTable, type SortKey } from "../components/cores/ProcessTable";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { TabHeader } from "../components/ui/TabHeader";
import { useProcesses } from "../hooks/useProcesses";
import { maskFromIds } from "../lib/cpu";
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

  useEffect(() => {
    api.getTopology().then(setTopo).catch(() => undefined);
  }, []);

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
    const q = search.trim().toLowerCase();
    const filtered = q ? processes.filter((p) => p.name.toLowerCase().includes(q)) : processes;
    const sorted = [...filtered].sort((a, b) => {
      let r = 0;
      switch (sortKey) {
        case "name":
          r = a.name.localeCompare(b.name);
          break;
        case "threads":
          r = a.threads - b.threads;
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
  }, [processes, search, sortKey, sortDir]);

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
    if (!selectedGroup) {
      setStatus("请先在左侧选择一个分组");
      return;
    }
    const chosen = processes.filter((p) => selectedPids.has(p.pid));
    let failed = 0;
    for (const proc of chosen) {
      assignProcess(selectedGroup.id, proc.name);
      if (optimizationEnabled) {
        try {
          await applyToProcess(selectedGroup, proc);
        } catch {
          failed += 1;
        }
      }
    }
    setSelectedPids(new Set());
    setStatus(
      `已添加 ${chosen.length} 个进程到「${selectedGroup.name}」` +
        (failed ? ` · ${failed} 个受保护进程应用失败` : ""),
    );
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
                {!selectedGroup.builtin && (
                  <Button variant="danger" onClick={() => removeGroup(selectedGroup.id)}>
                    删除分组
                  </Button>
                )}
              </>
            ) : (
              <span className="text-[12.5px] text-dim">从左侧选择或创建一个分组以分配核心</span>
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
              <Button
                variant="primary"
                onClick={assignSelected}
                disabled={selectedPids.size === 0 || !selectedGroup}
              >
                <Plus size={14} /> 添加到分组{selectedPids.size > 0 ? ` (${selectedPids.size})` : ""}
              </Button>
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
    </>
  );
}
