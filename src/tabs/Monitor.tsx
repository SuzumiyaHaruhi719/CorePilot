import { Gauge } from "lucide-react";
import { FeaturePanel } from "../components/ui/FeaturePanel";
import { TabHeader } from "../components/ui/TabHeader";

export function Monitor() {
  return (
    <>
      <TabHeader icon={Gauge} title="游戏监控" subtitle="实时帧率、帧时间与完整性能指标（PresentMon）" />
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <FeaturePanel
          points={[
            "FPS / 帧时间 / 1% · 0.1% Low（PresentMon）",
            "自动检测前台游戏",
            "实时帧时间曲线与 FPS 分布",
            "CPU / GPU / 显存 / 温度 / 功耗叠加",
            "游戏内 OSD 悬浮显示（可定制、热键切换）",
            "每局会话记录与回放对比",
          ]}
        />
      </div>
    </>
  );
}
