import { Gauge } from "lucide-react";
import { PerfHistory } from "../components/perf/PerfHistory";
import { TabHeader } from "../components/ui/TabHeader";

/**
 * 游戏历史 / Game History — per-game performance reports. The live dashboard +
 * 实时/历史 sub-tabs were removed; this tab now shows recorded session reports only.
 */
export function Monitor() {
  return (
    <>
      <TabHeader
        icon={Gauge}
        title="游戏历史"
        subtitle="每局游戏的性能报告 — CPU / GPU / 内存 / 磁盘 / 网络"
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <PerfHistory />
      </div>
    </>
  );
}
