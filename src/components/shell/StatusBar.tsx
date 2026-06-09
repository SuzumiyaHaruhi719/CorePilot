import { Activity, MemoryStick, ShieldCheck, ShieldOff } from "lucide-react";
import { motion } from "motion/react";
import { formatBytes } from "../../lib/format";
import { useSharedMetrics } from "../../hooks/useSharedTelemetry";
import { useUi } from "../../store/ui";
import { useSettings } from "../../store/settings";
import { useT } from "../../lib/i18n";
import { AnimatedNumber } from "../ui/AnimatedNumber";

export function StatusBar() {
  const metrics = useSharedMetrics();
  const optimizationEnabled = useUi((s) => s.optimizationEnabled);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const t = useT();

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
        <span>{t("内存")}</span>
        <span className="nums font-semibold text-ink">{metrics ? formatBytes(metrics.memUsed) : "—"}</span>
        <span className="nums text-dim">
          / {metrics ? formatBytes(metrics.memTotal) : "—"} · {memPct.toFixed(0)}%
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {optimizationEnabled ? (
          <>
            <motion.span
              animate={reduceMotion ? { opacity: 1 } : { opacity: [0.45, 1, 0.45] }}
              transition={reduceMotion ? { duration: 0 } : { duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
              className="text-ok"
            >
              <ShieldCheck size={13} />
            </motion.span>
            <span className="text-ok">{t("优化已启用")}</span>
          </>
        ) : (
          <>
            <span className="text-dim">
              <ShieldOff size={13} />
            </span>
            <span className="text-dim">{t("优化已停用")}</span>
          </>
        )}
      </div>
    </footer>
  );
}
