import { ListTree } from "lucide-react";
import { FeaturePanel } from "../components/ui/FeaturePanel";
import { TabHeader } from "../components/ui/TabHeader";

export function TaskManager() {
  return (
    <>
      <TabHeader icon={ListTree} title="任务管理器" subtitle="复刻 Windows 任务管理器的完整功能（二级标签）" />
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <FeaturePanel
          points={[
            "进程：应用 / 后台 / Windows 分组",
            "性能：每逻辑核 + 每 CCD 图表、内存、磁盘、GPU、网络",
            "应用历史 · 启动项（含启动影响）",
            "用户 · 详细信息（全列 + 右键操作）",
            "服务：启动 / 停止 / 重启",
            "结束任务、设置优先级、设置亲和性",
          ]}
        />
      </div>
    </>
  );
}
