import { ShieldCheck, ShieldOff } from "lucide-react";
import type { ReactNode } from "react";
import { formatBytes } from "../../lib/format";
import { useSharedMetrics, useSharedSensors } from "../../hooks/useSharedTelemetry";
import { useUiActive } from "../../hooks/useUiActive";
import { useUi } from "../../store/ui";
import { useTf } from "../../lib/i18n";
import { AnimatedNumber } from "../ui/AnimatedNumber";

/** A 24px usage tick under-scoring a value — the strip's only graphic. */
function Tick({ pct, color }: { pct: number | null | undefined; color: string }) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <span className="h-[3px] w-6 overflow-hidden rounded-full bg-surface3" aria-hidden>
      <span
        className="block h-full origin-left rounded-full transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ transform: `scaleX(${v / 100})`, background: color }}
      />
    </span>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <span className="text-dim">{label}</span>
      {children}
    </div>
  );
}

const Sep = () => <span className="h-3 w-px bg-line" aria-hidden />;

/** GPU + temperatures — only mounted while someone can see the window, so the
 *  shared sensors poller can stop entirely when the app sits in the tray. */
function SensorCells() {
  const s = useSharedSensors();
  const tf = useTf();
  return (
    <>
      <Sep />
      <Cell label="GPU">
        <span className="nums w-9 text-right text-ink">{s?.gpuPct != null ? `${Math.round(s.gpuPct)}%` : "—"}</span>
        <Tick pct={s?.gpuPct} color="var(--color-vcache)" />
        {s?.gpuTemp != null && <span className="nums text-muted">{Math.round(s.gpuTemp)}°</span>}
      </Cell>
      {s?.cpuTemp != null && (
        <>
          <Sep />
          <Cell label={tf("CPU 温度", "CPU temp")}>
            <span className="nums text-ink">{Math.round(s.cpuTemp)}°C</span>
          </Cell>
        </>
      )}
    </>
  );
}

export function StatusBar() {
  const metrics = useSharedMetrics();
  const optimizationEnabled = useUi((s) => s.optimizationEnabled);
  const uiActive = useUiActive((s) => s.active);
  const tf = useTf();

  const memPct = metrics ? (metrics.memUsed / metrics.memTotal) * 100 : null;

  return (
    <footer className="relative z-10 flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-4 text-[11.5px] text-muted">
      <Cell label="CPU">
        <span className="nums w-11 text-right text-ink">
          <AnimatedNumber value={metrics?.cpuOverall ?? 0} digits={1} suffix="%" />
        </span>
        <Tick pct={metrics?.cpuOverall} color="var(--color-accent)" />
      </Cell>
      {uiActive && <SensorCells />}
      <Sep />
      <Cell label={tf("内存", "Memory")}>
        <span className="nums text-ink">{metrics ? formatBytes(metrics.memUsed) : "—"}</span>
        <span className="nums text-dim">/ {metrics ? formatBytes(metrics.memTotal) : "—"}</span>
        <Tick pct={memPct} color="var(--color-cyan)" />
      </Cell>

      <div className="ml-auto flex items-center gap-1.5">
        {optimizationEnabled ? (
          <>
            <ShieldCheck size={13} className="text-ok" />
            <span className="text-ok">{tf("亲和性优化运行中", "Affinity optimization on")}</span>
          </>
        ) : (
          <>
            <ShieldOff size={13} className="text-dim" />
            <span className="text-dim">{tf("亲和性优化已停用", "Affinity optimization off")}</span>
          </>
        )}
      </div>
    </footer>
  );
}
