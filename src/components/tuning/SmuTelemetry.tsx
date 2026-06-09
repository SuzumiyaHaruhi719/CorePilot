import { Activity } from "lucide-react";
import { useSharedSensors } from "../../hooks/useSharedTelemetry";
import type { CpuSensor } from "../../lib/ipc";
import { useTf } from "../../lib/i18n";

// Per-SensorType formatting. Mirrors LHM's CPU SensorType set that sensord emits.
const UNIT: Record<string, string> = {
  Clock: " MHz",
  Temperature: " °C",
  Voltage: " V",
  Power: " W",
  Current: " A",
  Load: "%",
  Factor: "×",
};
const DIGITS: Record<string, number> = {
  Clock: 0,
  Temperature: 1,
  Voltage: 3,
  Power: 1,
  Current: 1,
  Load: 0,
  Factor: 2,
};
// Display order + bilingual group labels.
const ORDER = ["Clock", "Temperature", "Voltage", "Power", "Current", "Load", "Factor"] as const;
const GROUP_LABEL: Record<string, [string, string]> = {
  Clock: ["频率", "Clocks"],
  Temperature: ["温度", "Temps"],
  Voltage: ["电压", "Voltages"],
  Power: ["功耗", "Power"],
  Current: ["电流", "Current"],
  Load: ["负载", "Load"],
  Factor: ["系数", "Factors"],
};

function fmt(s: CpuSensor): string {
  if (s.value == null || !Number.isFinite(s.value)) return "—";
  return s.value.toFixed(DIGITS[s.kind] ?? 1) + (UNIT[s.kind] ?? "");
}

/**
 * Read-only deep SMU/CPU telemetry: per-core effective clocks, CCD temperatures,
 * VDDCR/SoC voltages, package power, TDC/EDC, etc. — sourced from the `sensord`
 * sidecar's LibreHardwareMonitor (which reads the AMD SMU PM table via PawnIO).
 * Degrades gracefully to a hint when no SMU driver is present.
 */
export function SmuTelemetry() {
  const tf = useTf();
  const latest = useSharedSensors();
  const sensors: CpuSensor[] = latest?.cpuSensors ?? [];

  const groups = ORDER.map((kind) => ({
    kind,
    items: sensors.filter((s) => s.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="glass hairline space-y-3 rounded-2xl p-4">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
        <Activity size={15} className="text-accent" /> {tf("SMU 遥测", "SMU telemetry")}
        <span className="text-[11px] font-normal text-dim">
          · {tf("逐核频率 / CCD 温度 / 电压 / 功耗(只读)", "per-core clocks / CCD temps / voltages / power (read-only)")}
        </span>
      </div>

      {groups.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed text-dim">
          {tf(
            "暂无深度 SMU 遥测 —— 需要 PawnIO 驱动(随传感器后台自动加载)。基础 CPU 温度/功耗仍可在监控页查看。",
            "No deep SMU telemetry yet — requires the PawnIO driver (auto-loaded by the sensor backend). Basic CPU temp/power is still on the Monitor page.",
          )}
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="mb-1.5 text-[11px] font-medium text-dim">
                {tf(...(GROUP_LABEL[g.kind] ?? [g.kind, g.kind]))}
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((s, i) => (
                  <div
                    key={`${g.kind}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface2/40 px-2.5 py-1.5"
                  >
                    <span className="truncate text-[11px] text-muted" title={s.name}>
                      {s.name}
                    </span>
                    <span className="shrink-0 font-mono text-[11.5px] font-semibold tabular-nums text-ink">
                      {fmt(s)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
