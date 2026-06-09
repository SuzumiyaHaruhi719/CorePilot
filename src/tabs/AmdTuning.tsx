import { Activity } from "lucide-react";
import { TabHeader } from "../components/ui/TabHeader";
import { SmuTelemetry } from "../components/tuning/SmuTelemetry";
import { SmuTuning } from "../components/tuning/SmuTuning";

/**
 * AMD 优化 — the Ryzen SMU toolbox (deep telemetry + Curve Optimizer + PBO).
 * This whole tab is hidden until the user unlocks it from Settings
 * (`amdTuningUnlocked`), so the dangerous write controls can't be reached by
 * accident. Mounted only when unlocked, so its children render directly.
 */
export function AmdTuning() {
  return (
    <>
      <TabHeader
        icon={Activity}
        title="AMD 优化"
        subtitle="Ryzen SMU 级调优 —— 深度遥测、Curve Optimizer 撤压、PBO 限制。实验性:写入为实时覆盖,重启恢复 BIOS 设置。"
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-6">
        <SmuTelemetry />
        <SmuTuning />
      </div>
    </>
  );
}
