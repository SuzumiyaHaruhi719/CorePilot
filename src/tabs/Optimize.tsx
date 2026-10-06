import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, Globe, Layers, Loader2, MemoryStick, Power, RefreshCw, Trash2, Wand2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Panel } from "../components/ui/Panel";
import { Cluster, ClusterCell, Readout } from "../components/ui/Readout";
import { SecondaryTabs } from "../components/ui/SecondaryTabs";
import { Segmented } from "../components/ui/Segmented";
import { TabHeader } from "../components/ui/TabHeader";
import { easeOut } from "../lib/motion";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { useT, useTf } from "../lib/i18n";
import { api, type MemDetail } from "../lib/ipc";
import { Tuning } from "./Tuning";

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "操作失败";
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ActionRowProps {
  icon: LucideIcon;
  title: string;
  desc: string;
  onRun: () => Promise<string>;
}

/** One single-shot action: what it does on the left, its result + run button on the right. */
function ActionRow({ icon: Icon, title, desc, onRun }: ActionRowProps) {
  const t = useT();
  const tf = useTf();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      setResult({ text: await onRun(), ok: true });
    } catch (error: unknown) {
      setResult({ text: getErrorMessage(error), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4 border-t border-line py-3.5 first:border-t-0 first:pt-1">
      <Icon size={17} className="shrink-0 text-dim" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{t(title)}</div>
        <div className="text-[12px] text-muted">{t(desc)}</div>
      </div>
      <AnimatePresence mode="wait">
        {result && (
          <motion.span
            key={result.text}
            role="status"
            initial={{ opacity: 0, x: 4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: easeOut }}
            className={cn("nums flex max-w-[40%] items-center gap-1.5 truncate text-[12px]", result.ok ? "text-ok" : "text-danger")}
          >
            {result.ok ? <Check size={13} className="shrink-0" /> : <AlertTriangle size={13} className="shrink-0" />}
            <span className="truncate">{t(result.text)}</span>
          </motion.span>
        )}
      </AnimatePresence>
      <Button size="sm" onClick={() => void run()} disabled={busy} className="min-w-16">
        {busy ? <Loader2 size={13} className="animate-spin" /> : tf("执行", "Run")}
      </Button>
    </div>
  );
}

export function Optimize() {
  const tf = useTf();
  const [view, setView] = useState<"quick" | "deep">("quick");
  const [mem, setMem] = useState<MemDetail | null>(null);
  const [heroBusy, setHeroBusy] = useState(false);
  const [heroResult, setHeroResult] = useState<{ text: string; ok: boolean } | null>(null);
  const [powerPlan, setPlan] = useState("");

  async function refresh() {
    try {
      setMem(await api.getMemoryDetail());
    } catch {
      /* ignore */
    }
  }

  async function changePlan(plan: string) {
    const prev = powerPlan;
    setPlan(plan);
    try {
      await api.setPowerPlan(plan);
    } catch {
      // Apply failed — re-sync the toggle to the real plan so the UI doesn't lie.
      api.getPowerPlan().then(setPlan).catch(() => setPlan(prev));
    }
  }

  useEffect(() => {
    void refresh();
    api.getPowerPlan().then(setPlan).catch(() => undefined);
  }, []);

  async function runFree(): Promise<string> {
    const before = await api.getMemoryDetail();
    await api.freeWorkingSets();
    await wait(400);
    const after = await api.getMemoryDetail();
    setMem(after);
    const freed = after.avail - before.avail;
    return freed > 0 ? tf(`释放了 ${formatBytes(freed)}`, `Freed ${formatBytes(freed)}`) : "已释放工作集";
  }

  async function runPurge(): Promise<string> {
    const before = await api.getMemoryDetail();
    await api.purgeStandby();
    await wait(400);
    const after = await api.getMemoryDetail();
    setMem(after);
    const freed = after.avail - before.avail;
    return freed > 0 ? tf(`释放了 ${formatBytes(freed)} 缓存`, `Freed ${formatBytes(freed)} cache`) : "已清理 standby 缓存";
  }

  async function runClean(): Promise<string> {
    const result = await api.cleanTemp();
    return tf(`清理 ${result.files} 个文件 · ${formatBytes(result.bytes)}`, `Cleaned ${result.files} files · ${formatBytes(result.bytes)}`);
  }

  async function runDns(): Promise<string> {
    await api.flushDns();
    return "DNS 缓存已刷新";
  }

  async function runAll() {
    setHeroBusy(true);
    setHeroResult(null);
    try {
      const before = await api.getMemoryDetail();
      const failedSteps: string[] = [];
      try {
        await api.freeWorkingSets();
      } catch {
        failedSteps.push(tf("释放内存", "free memory"));
      }
      try {
        await api.purgeStandby();
      } catch {
        failedSteps.push(tf("清理缓存", "clear cache"));
      }
      // Measure the reclaimed memory NOW — immediately after the two RAM steps.
      // The later clean_temp / power-plan steps take seconds, during which the
      // trimmed working sets get re-faulted (and other apps allocate), so the
      // `avail` delta nets back toward 0; measuring at the very end reported the
      // real multi-GB reclaim as "0 B".
      await wait(400);
      const afterMem = await api.getMemoryDetail();
      const freed = Math.max(0, afterMem.avail - before.avail);
      let files = 0;
      try {
        files = (await api.cleanTemp()).files;
      } catch {
        failedSteps.push(tf("清理临时文件", "temp clean"));
      }
      try {
        await api.flushDns();
      } catch {
        failedSteps.push(tf("刷新 DNS", "DNS flush"));
      }
      // Unlike the other steps, the power plan is a PERSISTENT system-wide
      // Windows setting that outlives the click and never reverts on its own.
      // It therefore has to be named in the CTA copy AND in the result line —
      // when it wasn't, the button silently rewrote the user's power plan and
      // the only hint was the Segmented control above jumping to 高性能.
      let planSwitched = false;
      try {
        await api.setPowerPlan("high");
        setPlan("high");
        planSwitched = true;
      } catch {
        failedSteps.push(tf("电源计划", "power plan"));
      }
      // Refresh the displayed gauge with the final state (after all steps).
      setMem(await api.getMemoryDetail());
      const note =
        failedSteps.length > 0
          ? tf(`（${failedSteps.join("、")}失败）`, ` (failed: ${failedSteps.join(", ")})`)
          : "";
      // Only claim the plan switch when it actually applied — a failure is
      // already named in `note`, and reporting both would contradict itself.
      const planNote = planSwitched
        ? tf(" · 电源计划已切换为高性能", " · power plan set to High Performance")
        : "";
      setHeroResult({
        text:
          tf(`释放 ${formatBytes(freed)} 内存 · 清理 ${files} 个临时文件`, `Freed ${formatBytes(freed)} memory · cleaned ${files} temp files`) +
          planNote +
          note,
        ok: failedSteps.length === 0,
      });
    } catch (error: unknown) {
      setHeroResult({ text: getErrorMessage(error), ok: false });
    } finally {
      setHeroBusy(false);
    }
  }

  const loadPct = mem ? mem.loadPct : 0;

  return (
    <>
      <TabHeader title="优化" subtitle="释放内存、清理缓存、深度调优 — 一键提升游戏性能" />
      <SecondaryTabs
        tabs={[
          { id: "quick", label: "快速优化" },
          { id: "deep", label: "深度优化" },
        ]}
        active={view}
        onChange={(v) => setView(v)}
        layoutId="opt-view"
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: easeOut } }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {view === "deep" ? (
            <Tuning embedded />
          ) : (
            <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-6 pt-4">
              {/* Memory instrument */}
              <Panel
                title="物理内存"
                actions={
                  <Button variant="subtle" size="sm" className="w-7 px-0" ariaLabel={tf("刷新", "Refresh")} title={tf("刷新", "Refresh")} onClick={() => void refresh()}>
                    <RefreshCw size={13} />
                  </Button>
                }
                flush
              >
                <Cluster className="rounded-b-xl" min={140}>
                  <ClusterCell meter={loadPct} meterColor={loadPct > 80 ? "var(--color-warn)" : "var(--color-cyan)"}>
                    <Readout label="已用" value={mem ? formatBytes(mem.used) : null} size="lg" sub={mem ? `/ ${formatBytes(mem.total)}` : undefined} />
                  </ClusterCell>
                  <ClusterCell>
                    <Readout label="可用" value={mem ? formatBytes(mem.avail) : null} size="lg" />
                  </ClusterCell>
                  <ClusterCell>
                    <Readout label="负载" value={mem ? loadPct : null} unit="%" size="lg" color={loadPct > 80 ? "var(--color-warn)" : undefined} />
                  </ClusterCell>
                </Cluster>
              </Panel>

              {/* One-click — the single primary action of this view. */}
              <Panel>
                <div className="flex flex-wrap items-center gap-4">
                  <Wand2 size={20} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-ink">{tf("一键优化", "One-click optimize")}</div>
                    {/* Every step this button performs is listed here, the power plan
                        included — it is the one step that persists after the click. */}
                    <div className="mt-0.5 text-[12.5px] text-muted">
                      {tf(
                        "释放内存 + 清理缓存 + 清理临时文件 + 刷新 DNS + 高性能电源计划",
                        "Free memory + clear cache + clean temp + flush DNS + High Performance power plan",
                      )}
                    </div>
                  </div>
                  <Button variant="primary" onClick={() => void runAll()} disabled={heroBusy} className="h-9 px-4">
                    {heroBusy && <Loader2 size={14} className="animate-spin" />} {heroBusy ? tf("优化中…", "Optimizing…") : tf("立即优化", "Optimize now")}
                  </Button>
                </div>
                <AnimatePresence>
                  {heroResult && (
                    <motion.div
                      role="status"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease: easeOut }}
                      className="overflow-hidden"
                    >
                      <div className={cn("mt-3 flex items-center gap-2 border-t border-line pt-3 text-[12.5px]", heroResult.ok ? "text-ok" : "text-danger")}>
                        {heroResult.ok ? <Check size={14} /> : <AlertTriangle size={14} />} <span className="nums">{heroResult.text}</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Panel>

              {/* Individual actions + the power plan setting */}
              <Panel title="单项操作" desc="按需单独执行，所有操作均安全可逆" bodyClassName="px-4 pb-1">
                <ActionRow icon={MemoryStick} title="释放内存" desc="清空所有进程的工作集，回收驻留内存" onRun={runFree} />
                <ActionRow icon={Layers} title="清理缓存" desc="清除 standby list，释放被缓存占用的内存" onRun={runPurge} />
                <ActionRow icon={Trash2} title="清理临时文件" desc="删除用户与系统临时目录中的文件" onRun={runClean} />
                <ActionRow icon={Globe} title="刷新 DNS" desc="清空 DNS 解析缓存" onRun={runDns} />
                <div className="flex items-center gap-4 border-t border-line py-3.5">
                  <Power size={17} className="shrink-0 text-dim" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">电源计划</div>
                    <div className="text-[12px] text-muted">高性能模式降低 CPU 调度延迟，适合游戏</div>
                  </div>
                  <Segmented
                    id="plan"
                    value={powerPlan === "high" ? "high" : "balanced"}
                    onChange={changePlan}
                    options={[
                      { value: "balanced", label: "平衡" },
                      { value: "high", label: "高性能" },
                    ]}
                  />
                </div>
              </Panel>

              <p className="max-w-[110ch] text-[11.5px] leading-relaxed text-dim">
                提示：释放内存/清理缓存会让被回收的内容在下次访问时重新加载，建议在游戏前或内存占用偏高时使用。所有操作均安全可逆（缓存会自然重建）。
              </p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </>
  );
}
