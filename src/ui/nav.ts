import { CalendarClock, Cpu, Fan, Gamepad2, HardDrive, LayoutDashboard, ListTree, Rocket, Settings2, Zap, type LucideIcon } from "lucide-react"
import type { PageId } from "../lib/store"

export interface NavItem { id: PageId; zh: string; en: string; icon: LucideIcon; group: number }
/** Rail order; `group` draws a separator between clusters. */
export const NAV: NavItem[] = [
  { id: "overview", zh: "总览", en: "Overview", icon: LayoutDashboard, group: 0 },
  { id: "processes", zh: "进程", en: "Processes", icon: ListTree, group: 0 },
  { id: "cores", zh: "核心分配", en: "Cores", icon: Cpu, group: 0 },
  { id: "games", zh: "游戏", en: "Games", icon: Gamepad2, group: 1 },
  { id: "thermals", zh: "风扇", en: "Fans", icon: Fan, group: 2 },
  { id: "tuning", zh: "超频", en: "Tuning", icon: Rocket, group: 2 },
  { id: "system", zh: "优化", en: "Optimize", icon: Zap, group: 3 },
  { id: "cron", zh: "定时任务", en: "Cron", icon: CalendarClock, group: 3 },
  { id: "disk", zh: "存储分析", en: "Storage", icon: HardDrive, group: 3 },
  { id: "settings", zh: "设置", en: "Settings", icon: Settings2, group: 4 },
]
