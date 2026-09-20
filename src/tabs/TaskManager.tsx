import { ListTree } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { PerfView } from "../components/taskmgr/PerfView";
import { ProcessView } from "../components/taskmgr/ProcessView";
import { ServicesView } from "../components/taskmgr/ServicesView";
import { StartupView } from "../components/taskmgr/StartupView";
import { SecondaryTabs } from "../components/ui/SecondaryTabs";
import { TabHeader } from "../components/ui/TabHeader";
import { useUi, type TaskmgrSec as Sec } from "../store/ui";

const SECS: { id: Sec; label: string }[] = [
  { id: "perf", label: "性能" },
  { id: "procs", label: "进程" },
  { id: "details", label: "详细信息" },
  { id: "startup", label: "启动" },
  { id: "services", label: "服务" },
];

export function TaskManager() {
  // Held in the UI store, not local state: switching to another top-level tab
  // unmounts this whole component (App.tsx keys its AnimatePresence on `tab`),
  // and coming back used to dump the user on 性能 again no matter where they were.
  const sec = useUi((s) => s.taskmgrSec);
  const setSec = useUi((s) => s.setTaskmgrSec);

  return (
    <>
      <TabHeader icon={ListTree} title="任务管理器" subtitle="复刻 Windows 任务管理器 — 实时性能与进程管理" />
      <SecondaryTabs tabs={SECS} active={sec} onChange={setSec} layoutId="tm-sec" />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AnimatePresence mode="wait">
          <motion.div
            key={sec}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {sec === "perf" && <PerfView />}
            {sec === "procs" && <ProcessView />}
            {sec === "details" && <ProcessView detailed />}
            {sec === "startup" && <StartupView />}
            {sec === "services" && <ServicesView />}
          </motion.div>
        </AnimatePresence>
      </div>
    </>
  );
}
