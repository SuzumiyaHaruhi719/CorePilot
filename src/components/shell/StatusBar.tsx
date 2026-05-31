import { Activity, MemoryStick, ShieldCheck, ShieldOff } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { formatBytes } from "../../lib/format";
import { api, type Metrics } from "../../lib/ipc";
import { useSettings } from "../../store/settings";
import { useUi } from "../../store/ui";
import { AnimatedNumber } from "../ui/AnimatedNumber";

export function StatusBar() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const pollMs = useSettings((s) => s.pollMs);
  const optimizationEnabled = useUi((s) => s.optimizationEnabled);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const data = await api.getMetrics();
        if (alive) setMetrics(data);
      } catch {
        /* backend not ready yet */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), pollMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pollMs]);

  const memPct = metrics ? (metrics.memUsed / metrics.memTotal) * 100 : 0;

  return (
    <footer className="relative z-10 flex h-7 shrink-0 items-center gap-5 border-t border-line px-4 text-[11.5px] text-muted">
      <div className="flex items-center gap-1.5">
        <Activity size={13} className="text-accent" />
        <span>CPU</span>
        <span className="nums w-[44px] font-semibold text-ink">
          <AnimatedNumber value={metrics?.cpuOverall ?? 0} digits={1} suffix="%" />
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <MemoryStick size={13} className="text-cyan" />
        <span>内存</span>
        <span className="nums font-semibold text-ink">{metrics ? formatBytes(metrics.memUsed) : "—"}</span>
        <span className="nums text-dim">
          / {metrics ? formatBytes(metrics.memTotal) : "—"} · {memPct.toFixed(0)}%
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {optimizationEnabled ? (
          <>
            <motion.span
              animate={{ opacity: [0.45, 1, 0.45] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
              className="text-ok"
            >
              <ShieldCheck size={13} />
            </motion.span>
            <span className="text-ok">优化已启用</span>
          </>
        ) : (
          <>
            <span className="text-dim">
              <ShieldOff size={13} />
            </span>
            <span className="text-dim">优化已停用</span>
          </>
        )}
      </div>
    </footer>
  );
}
