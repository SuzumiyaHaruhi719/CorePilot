import { useSettings } from "../store/settings";

/**
 * Lightweight i18n for CorePilot.
 *
 * The UI is authored in Chinese, so the dictionary is keyed by the Chinese source
 * string and maps to English. `t("中文")` returns the English when the language is
 * `en`, otherwise the original Chinese. A missing key falls back to the Chinese so
 * partial translation degrades gracefully. Strings flow through `t()` either via
 * shared components (TabHeader, Segmented, SettingRow, SectionHeader, ContextMenu,
 * NavRail, StatusBar, SecondaryTabs) or by wrapping inline usages directly.
 */
export const EN: Record<string, string> = {
  // ── Navigation ────────────────────────────────────────────────────────
  "核心分配": "Cores",
  "任务管理器": "Task Manager",
  "监控": "Monitor",
  "游戏OSD": "Game OSD",
  "风扇": "Fans",
  "优化": "Optimize",
  "设置": "Settings",

  // ── Status bar ────────────────────────────────────────────────────────
  "内存": "Memory",
  "优化已启用": "Optimization on",
  "优化已停用": "Optimization off",

  // ── Tab headers (titles) ──────────────────────────────────────────────
  "深度优化": "Deep Optimization",
  "游戏内监控 OSD": "In-Game OSD",
  "游戏监控": "Game Monitor",
  "GPU 超频": "GPU Overclock",
  "风扇控制": "Fan Control",
  "进程核心分配": "Process Core Assignment",

  // ── Tab headers (subtitles) ───────────────────────────────────────────
  "可逆的系统性能优化 —— 安全区随便开,危险区谨慎用。每项都可一键还原为系统默认。":
    "Reversible system tweaks — the Safe zone is free to use, the Danger zone with care; every item reverts to default in one click.",
  "复刻 Windows 任务管理器 — 实时性能与进程管理":
    "A Windows Task Manager clone — live performance & process management",
  "所有更改即时自动保存 — 无需手动保存": "All changes auto-save instantly — no manual save needed",
  "可定制的低占用游戏叠加层 — 适用于无边框 / 窗口化游戏，所有更改即时生效":
    "Customizable low-overhead in-game overlay — for borderless / windowed games, changes apply instantly",
  "释放内存、清理缓存、深度调优 — 一键提升游戏性能":
    "Free memory, clear caches, deep tuning — one-click performance boost",
  "实时性能监控 — CPU / GPU / 内存 / 磁盘 / 网络":
    "Live performance monitoring — CPU / GPU / Memory / Disk / Network",
  "NVIDIA 实时调优 — 功率 / 频率偏移(NVAPI) / 温度 / 风扇，配置可保存自动应用":
    "Live NVIDIA tuning — power / clock offset (NVAPI) / temp / fan; profiles save & auto-apply",
  "主板风扇调速 — 手动 / 温度曲线（FanXpert 式），基于 LibreHardwareMonitor，配置自动保存":
    "Motherboard fan control — manual / temperature curve (FanXpert-style), via LibreHardwareMonitor, auto-saved",
  "将进程分组并绑定到指定 CPU 核心 / 线程 — CCD 感知调度":
    "Group processes and pin them to specific CPU cores / threads — CCD-aware scheduling",

  // ── Settings: section headers ─────────────────────────────────────────
  "外观 · APPEARANCE": "APPEARANCE",
  "性能与监控 · PERFORMANCE": "PERFORMANCE",

  // ── Settings: rows ────────────────────────────────────────────────────
  "强调色": "Accent color",
  "主题主色调，实时应用": "Theme primary color, applied live",
  "发光强度": "Glow intensity",
  "界面柔和发光效果": "Soft UI glow effect",
  "亚克力模糊": "Acrylic blur",
  "Windows 11 acrylic 背景效果": "Windows 11 acrylic background",
  "窗口不透明度": "Window opacity",
  "整个窗口的不透明度（亚克力开启时可透出背景）":
    "Whole-window opacity (shows the background through when acrylic is on)",
  "关闭动画（省电）": "Disable animations (power saving)",
  "关闭持续动效（HUD 背景 / 光晕 / 旋转图标等），明显降低空闲 CPU 占用，适合低端设备":
    "Disables continuous motion (HUD background / glow / spinners), markedly lowering idle CPU — good for low-end machines",
  "后台记录性能曲线": "Record charts in background",
  "关闭任务管理器后仍在后台记录 CPU / GPU / 内存 / 磁盘 / 网络，下次打开图表即为完整曲线（会略增空闲占用）":
    "Keeps recording CPU / GPU / Memory / Disk / Network after Task Manager is closed, so charts open already full (slightly raises idle usage)",
  "关闭后保留到托盘": "Keep in tray on close",
  "关闭窗口时收起到系统托盘，后台继续运行（亲和性 / 超频 / OSD）；右键托盘图标可退出":
    "Minimize to the system tray on close; keeps running (affinity / OC / OSD). Right-click the tray icon to quit.",
  "语言 / Language": "Language",
  "刷新间隔": "Refresh interval",
  "实时数据轮询频率": "Live data polling frequency",
  "游戏性能记录": "Game performance recording",
  "检测到游戏运行时自动采样性能；游戏关闭后在 监控 → 历史 生成报告":
    "Auto-sample performance when a game runs; a report appears in Monitor → History after it closes",
  "游戏结束后自动弹出性能报告": "Auto-open report after game exits",
  "游戏关闭时将 CorePilot 切到前台并打开本次性能报告":
    "Bring CorePilot to the front and open the report when a game closes",
  "游戏检测通知": "Game-detection notifications",
  "检测到游戏运行 / 性能报告生成时发送 Windows 系统通知":
    "Send a Windows notification when a game is detected / a report is saved",

  // ── Segmented / sub-tabs ──────────────────────────────────────────────
  "快速优化": "Quick",
  "平衡": "Balanced",
  "高性能": "High Performance",
  "自动": "Auto",
  "手动": "Manual",
  "曲线": "Curve",
  "柔和": "Soft",
  "中等": "Medium",
  "强烈": "Strong",
  "实时": "Live",
  "历史": "History",
  "横向": "Horizontal",
  "竖排": "Vertical",
  "左上": "Top-left",
  "上中": "Top-center",
  "右上": "Top-right",
  "左下": "Bottom-left",
  "下中": "Bottom-center",
  "右下": "Bottom-right",
  "自由": "Free",
  "全部核心": "All cores",
  "强制记录": "Force record",
  "从不记录": "Never record",
  "强制显示": "Force show",
  "强制隐藏": "Force hide",

  // ── Task Manager secondary tabs ───────────────────────────────────────
  "性能": "Performance",
  "进程": "Processes",
  "详细信息": "Details",
  "启动": "Startup",
  "服务": "Services",

  // ── Context-menu items ────────────────────────────────────────────────
  "立即应用核心分配": "Apply affinity now",
  "从分组移出": "Remove from group",
  "添加游戏内覆盖": "Add in-game override",
  "结束任务": "End task",
  "结束进程": "End process",
  "复制名称": "Copy name",
  "复制 PID": "Copy PID",
  "复制应用路径": "Copy app path",
  "打开文件位置": "Open file location",
  "设为低优先级": "Set low priority",
  "设为正常优先级": "Set normal priority",
  "设为高优先级": "Set high priority",
  "刷新 DNS 缓存": "Flush DNS cache",
  "重新获取 IP": "Renew IP",
  "重置 TCP/IP（需重启）": "Reset TCP/IP (reboot)",
  "重置 Winsock（需重启）": "Reset Winsock (reboot)",
  "重置代理": "Reset proxy",

  // ── Monitor / chart metric labels ─────────────────────────────────────
  "CPU 占用": "CPU usage",
  "CPU 温度": "CPU temp",
  "CPU 频率": "CPU clock",
  "CPU 功耗": "CPU power",
  "GPU 占用": "GPU usage",
  "GPU 温度": "GPU temp",
  "GPU 频率": "GPU clock",
  "GPU 功耗": "GPU power",
  "GPU 风扇": "GPU fan",
  "内存占用": "Memory usage",
  "显存占用": "VRAM usage",
  "显存频率": "VRAM clock",
  "显存控制器": "VRAM controller",
  "磁盘": "Disk",
  "硬盘": "Disk",
  "网络": "Network",
  "上传": "Upload",
  "下载": "Download",
  "上传速度": "Upload speed",
  "下载速度": "Download speed",
  "读取速度": "Read speed",
  "写入速度": "Write speed",
  "磁盘读": "Disk read",
  "磁盘写": "Disk write",
  "磁盘活动": "Disk activity",
  "总功耗": "Total power",
  "帧时间": "Frame time",
  "最低 FPS": "Min FPS",
  "最高 FPS": "Max FPS",
  "平均 FPS": "Avg FPS",
  "占用率 (%)": "Usage (%)",
  "占用量": "Usage",
  "温度 (°C)": "Temp (°C)",
  "频率 (MHz)": "Clock (MHz)",
  "风扇转速 (%)": "Fan speed (%)",
  "热功耗 (W)": "Power (W)",
  "活动时间 (%)": "Activity (%)",
  "帧时间 (ms)": "Frame time (ms)",
  "显存占用 (%)": "VRAM (%)",
  "显存占用量": "VRAM used",
  "显存频率 (MHz)": "VRAM clock (MHz)",
  "核心频率 (MHz)": "Core clock (MHz)",
  "平均 CPU 占用": "Avg CPU usage",
  "平均 CPU 温度": "Avg CPU temp",
  "平均 CPU 功耗": "Avg CPU power",
  "平均 GPU 占用": "Avg GPU usage",
  "平均 GPU 温度": "Avg GPU temp",
  "平均 GPU 功耗": "Avg GPU power",
  "平均 GPU 频率": "Avg GPU clock",
  "平均内存占用": "Avg memory",
  "平均显存占用": "Avg VRAM",
  "平均帧时间": "Avg frame time",
  "最高 CPU 温度": "Max CPU temp",
  "最高 GPU 温度": "Max GPU temp",
  "最低": "Min",
  "最高": "Max",
  "平均": "Avg",
  "功耗": "Power",

  // ── Common actions / buttons ──────────────────────────────────────────
  "应用": "Apply",
  "应用中…": "Applying…",
  "保存当前": "Save current",
  "另存为": "Save as",
  "保存为配置": "Save as profile",
  "恢复默认": "Reset to default",
  "全部还原默认": "Revert all",
  "创建系统还原点": "Create restore point",
  "取消": "Cancel",
  "保存": "Save",
  "删除": "Delete",
  "添加": "Add",
  "刷新": "Refresh",
  "显示全部": "Show all",
  "仅显示活动": "Active only",
  "导入": "Import",
  "导出": "Export",
  "全选": "Select all",
  "仅此组": "This group only",
  "完成": "Done",
  "开始校准": "Start calibration",
  "AI 智能校准": "AI Auto-Tune",
};

/** Non-reactive translate (for use outside React). */
export function translate(zh: string, lang: "zh" | "en"): string {
  return lang === "en" ? EN[zh] ?? zh : zh;
}

/**
 * Reactive translator hook: returns `t(zh)` bound to the current language, so
 * consuming components re-render when the language setting changes.
 */
export function useT(): (zh: string) => string {
  const lang = useSettings((s) => s.language);
  return (zh: string) => translate(zh, lang);
}
