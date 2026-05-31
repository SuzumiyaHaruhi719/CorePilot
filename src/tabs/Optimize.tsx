import { Zap } from "lucide-react";
import { FeaturePanel } from "../components/ui/FeaturePanel";
import { TabHeader } from "../components/ui/TabHeader";

export function Optimize() {
  return (
    <>
      <TabHeader icon={Zap} title="优化" subtitle="释放内存、清理缓存、一键游戏优化" />
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <FeaturePanel
          points={[
            "释放工作集 · 清理 standby list（释放内存）",
            "清理临时文件 / DNS / 缩略图 / 更新缓存",
            "挂起非关键后台进程",
            "启动项管理（含影响评估）",
            "一键游戏模式：清内存 + 电源计划 + CCD 亲和",
            "可逆操作 + 操作前后对比",
          ]}
          note="所有有风险的操作都受关键进程白名单与二次确认保护，并可撤销。"
        />
      </div>
    </>
  );
}
