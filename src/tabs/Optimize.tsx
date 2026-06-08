import { AnimatePresence, motion } from "motion/react";
import { Check, Globe, Loader2, MemoryStick, Power, RefreshCw, Trash2, Wand2, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { ClickRipple } from "../components/ui/Ripple";
import { Segmented } from "../components/ui/Segmented";
import { TabHeader } from "../components/ui/TabHeader";
import { hoverPop } from "../lib/motion";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { api, type MemDetail } from "../lib/ipc";

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "操作失败";
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ActionCardProps {
  icon: LucideIcon;
  title: string;
  desc: string;
  hue: number;
  onRun: () => Promise<string>;
}

function ActionCard({ icon: Icon, title, desc, hue, onRun }: ActionCardProps) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await onRun());
    } catch (error: unknown) {
      setResult(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const tint = `oklch(72% 0.16 ${hue})`;

  return (
    <motion.button
      onClick={run}
      whileHover={{ scale: 1.02, y: -3 }}
      whileTap={{ scale: 0.98 }}
      transition={hoverPop}
      className="hud-frame glass hairline group relative flex min-h-[150px] cursor-pointer flex-col items-start gap-3 overflow-hidden rounded-2xl p-4 text-left transition-[box-shadow] duration-200"
      style={{ "--glow": tint } as CSSProperties}
    >
      {/* Faint telemetry tint that lights up on hover. */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-60"
        style={{ background: `linear-gradient(90deg, transparent, ${tint}, transparent)` }}
      />
      <span
        className="grid h-10 w-10 place-items-center rounded-xl text-white transition-shadow duration-200 glow-sm group-hover:glow"
        style={{ background: tint, "--glow": tint } as CSSProperties}
      >
        {busy ? <Loader2 size={19} className="animate-spin" /> : <Icon size={19} />}
      </span>
      <div className="flex-1">
        <div className="text-[13.5px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-dim">{desc}</div>
      </div>
      <AnimatePresence mode="wait">
        {result ? (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-1.5 text-[11.5px] font-medium text-ok glow-text"
          >
            <Check size={13} /> <span className="nums">{result}</span>
          </motion.div>
        ) : (
          <motion.div
            key="cta"
            initial={false}
            className="hud-label text-[10px] text-dim transition-colors group-hover:text-muted"
          >
            {busy ? "执行中…" : "点击执行"}
          </motion.div>
        )}
      </AnimatePresence>
      <ClickRipple />
    </motion.button>
  );
}

export function Optimize() {
  const [mem, setMem] = useState<MemDetail | null>(null);
  const [heroBusy, setHeroBusy] = useState(false);
  const [heroResult, setHeroResult] = useState<string | null>(null);
  const [powerPlan, setPlan] = useState("");

  async function refresh() {
    try {
      setMem(await api.getMemoryDetail());
    } catch {
      /* ignore */
    }
  }

  async function changePlan(plan: string) {
    setPlan(plan);
    try {
      await api.setPowerPlan(plan);
    } catch {
      /* ignore */
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
    return freed > 0 ? `释放了 ${formatBytes(freed)}` : "已释放工作集";
  }

  async function runPurge(): Promise<string> {
    const before = await api.getMemoryDetail();
    await api.purgeStandby();
    await wait(400);
    const after = await api.getMemoryDetail();
    setMem(after);
    const freed = after.avail - before.avail;
    return freed > 0 ? `释放了 ${formatBytes(freed)} 缓存` : "已清理 standby 缓存";
  }

  async function runClean(): Promise<string> {
    const result = await api.cleanTemp();
    return `清理 ${result.files} 个文件 · ${formatBytes(result.bytes)}`;
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
      await api.freeWorkingSets();
      await api.purgeStandby();
      let files = 0;
      try {
        files = (await api.cleanTemp()).files;
      } catch {
        /* ignore */
      }
      try {
        await api.flushDns();
      } catch {
        /* ignore */
      }
      try {
        await api.setPowerPlan("high");
        setPlan("high");
      } catch {
        /* ignore */
      }
      await wait(500);
      const after = await api.getMemoryDetail();
      setMem(after);
      const freed = Math.max(0, after.avail - before.avail);
      setHeroResult(`释放 ${formatBytes(freed)} 内存 · 清理 ${files} 个临时文件`);
    } catch (error: unknown) {
      setHeroResult(getErrorMessage(error));
    } finally {
      setHeroBusy(false);
    }
  }

  const loadPct = mem ? mem.loadPct : 0;

  return (
    <>
      <TabHeader icon={Zap} title="优化" subtitle="释放内存、清理缓存 — 一键提升游戏性能" />
      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-6 pb-6">
        {/* Memory panel */}
        <div className="hud-frame glass hairline rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MemoryStick size={15} className="text-cyan" />
              <span className="hud-label text-[10.5px] text-dim">物理内存 · MEMORY</span>
            </div>
            <button
              onClick={() => void refresh()}
              title="刷新"
              className="no-drag grid h-7 w-7 cursor-pointer place-items-center rounded-lg text-dim transition-colors hover:bg-surface3 hover:text-ink"
            >
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="mb-2 flex items-end justify-between">
            <div className="nums text-[22px] font-semibold text-ink">
              {mem ? formatBytes(mem.used) : "—"}
              <span className="ml-1 text-[13px] font-normal text-dim">
                / {mem ? formatBytes(mem.total) : "—"}
              </span>
            </div>
            <div className="nums text-[15px] font-semibold" style={{ color: `oklch(72% 0.16 ${loadPct > 80 ? 22 : 274})` }}>
              {loadPct}%
            </div>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-surface3">
            <motion.div
              className="h-full rounded-full bg-accent glow-sm"
              initial={false}
              animate={{ width: `${loadPct}%` }}
              transition={{ type: "spring", stiffness: 120, damping: 22 }}
            />
          </div>
        </div>

        {/* Power plan */}
        <div className="glass hairline flex items-center justify-between gap-4 rounded-2xl p-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-warn/15 text-warn">
              <Power size={17} />
            </span>
            <div>
              <div className="text-[13.5px] font-semibold text-ink">电源计划</div>
              <div className="text-[11.5px] text-dim">高性能模式降低 CPU 调度延迟，适合游戏</div>
            </div>
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

        {/* Hero one-click — the single primary CTA of this view. */}
        <motion.button
          onClick={runAll}
          disabled={heroBusy}
          whileHover={heroBusy ? undefined : { y: -2, scale: 1.012 }}
          whileTap={heroBusy ? undefined : { scale: 0.99 }}
          transition={hoverPop}
          className={cn(
            "relative flex w-full items-center gap-4 overflow-hidden rounded-2xl border border-accent/40 bg-accent/10 p-4 text-left text-ink glow transition-[border-color,background-color,box-shadow] duration-200",
            heroBusy ? "cursor-wait opacity-90" : "cursor-pointer hover:border-accent/60 hover:bg-accent/15",
          )}
        >
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-accent/30 bg-accent/20 text-accent-bright glow-sm">
            {heroBusy ? <Loader2 size={24} className="animate-spin" /> : <Wand2 size={24} />}
          </span>
          <div className="flex-1">
            <div className="display text-[15px] font-bold uppercase tracking-[0.06em]">一键优化</div>
            <div className="text-[12px] text-muted">释放内存 + 清理缓存 + 清理临时文件 + 刷新 DNS</div>
            <AnimatePresence>
              {heroResult && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-1 flex items-center gap-1.5 text-[12px] font-medium text-white"
                >
                  <Check size={14} /> <span className="nums">{heroResult}</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <ClickRipple />
        </motion.button>

        {/* Action grid — individual "mission control" actions, subordinate to the hero. */}
        <div>
          <div className="mb-2.5 flex items-center gap-2">
            <span className="hud-label text-[10.5px] text-dim">单项操作 · ACTIONS</span>
            <span className="h-px flex-1 bg-line/70" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ActionCard
              icon={MemoryStick}
              title="释放内存"
              desc="清空所有进程的工作集，回收驻留内存"
              hue={274}
              onRun={runFree}
            />
            <ActionCard
              icon={Trash2}
              title="清理缓存"
              desc="清除 standby list，释放被缓存占用的内存"
              hue={182}
              onRun={runPurge}
            />
            <ActionCard
              icon={Trash2}
              title="清理临时文件"
              desc="删除用户与系统临时目录中的文件"
              hue={75}
              onRun={runClean}
            />
            <ActionCard icon={Globe} title="刷新 DNS" desc="清空 DNS 解析缓存" hue={220} onRun={runDns} />
          </div>
        </div>

        <p className={cn("text-[11px] leading-relaxed text-dim")}>
          提示：释放内存/清理缓存会让被回收的内容在下次访问时重新加载，建议在游戏前或内存占用偏高时使用。所有操作均安全可逆（缓存会自然重建）。
        </p>
      </div>
    </>
  );
}
