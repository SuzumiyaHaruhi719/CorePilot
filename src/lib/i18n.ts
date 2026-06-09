import { useEffect, useRef } from "react";
import { useSettings } from "../store/settings";

/**
 * CorePilot i18n.
 *
 * The UI is authored in Chinese. Two mechanisms share one dictionary (keyed by the
 * Chinese source string → English):
 *
 *  1. `useT()` — explicit `t("中文")` used inside shared components.
 *  2. `useGlobalI18n()` (mounted once in <App>) — a runtime translator that walks
 *     the DOM and swaps any text node / `placeholder` / `title` / `aria-label`
 *     whose text exactly matches a dictionary key. It records the original Chinese
 *     so switching back to `zh` restores it, and a MutationObserver keeps newly
 *     rendered nodes translated. This covers every static string without wrapping
 *     each call site. Interpolated strings (with `${…}`) won't match and stay
 *     Chinese — a graceful fallback.
 */
export const EN: Record<string, string> = {
  // Navigation / shell
  "核心分配": "Cores",
  "任务管理器": "Task Manager",
  "监控": "Monitor",
  "游戏OSD": "Game OSD",
  "风扇": "Fans",
  "优化": "Optimize",
  "设置": "Settings",
  "内存": "Memory",
  "优化已启用": "Optimization on",
  "优化已停用": "Optimization off",
  "优化已启用 · 已重新应用所有分组规则": "Optimization on · all group rules re-applied",
  "优化已停用 · 已恢复默认亲和性": "Optimization off · default affinity restored",

  // Tab headers
  "深度优化": "Deep Optimization",
  "游戏内监控 OSD": "In-Game OSD",
  "游戏监控": "Game Monitor", "游戏历史": "Game History",
  "每局游戏的性能报告 — CPU / GPU / 内存 / 磁盘 / 网络": "Per-game performance reports — CPU / GPU / Memory / Disk / Network",
  "GPU 超频": "GPU Overclock",
  "风扇控制": "Fan Control",
  "进程核心分配": "Process Core Assignment",
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
    "Live monitoring — CPU / GPU / Memory / Disk / Network",
  "NVIDIA 实时调优 — 功率 / 频率偏移(NVAPI) / 温度 / 风扇，配置可保存自动应用":
    "Live NVIDIA tuning — power / clock offset (NVAPI) / temp / fan; profiles save & auto-apply",
  "主板风扇调速 — 手动 / 温度曲线（FanXpert 式），基于 LibreHardwareMonitor，配置自动保存":
    "Motherboard fan control — manual / temperature curve (FanXpert-style), via LibreHardwareMonitor, auto-saved",
  "将进程分组并绑定到指定 CPU 核心 / 线程 — CCD 感知调度":
    "Group processes and pin them to specific CPU cores / threads — CCD-aware scheduling",

  // Section headers
  "外观 · APPEARANCE": "APPEARANCE",
  "性能与监控 · PERFORMANCE": "PERFORMANCE",
  "单项操作 · ACTIONS": "ACTIONS",
  "性能汇总 · SUMMARY": "SUMMARY",
  "核心遥测 · CORE TELEMETRY": "CORE TELEMETRY",
  "样式 · 位置 · STYLE": "STYLE · POSITION",
  "实时预览 · LIVE PREVIEW": "LIVE PREVIEW",
  "快速预设 · PRESETS": "PRESETS",
  "数据流 · I/O & POWER": "I/O & POWER",
  "物理内存 · MEMORY": "MEMORY",
  "CORE MAP · 核心映射": "CORE MAP",

  // Settings rows
  "主题": "Theme", "深色 HUD 或浅色界面": "Dark HUD or light interface", "深色": "Dark", "浅色": "Light",
  "主题风格": "Theme style", "选择主题风格": "Choose a palette",
  "石墨": "Graphite", "午夜": "Midnight", "终端": "Terminal", "赛博朋克": "Cyberpunk", "瓷白": "Porcelain", "砂岩": "Sandstone",
  "冷色深色调 + 暖橙强调，适合长时间使用。": "Cool dark surfaces + warm orange accent — easy for long sessions.",
  "更深更蓝的午夜界面，冷紫蓝强调色。": "Deeper, bluer midnight UI with a cool violet accent.",
  "近黑终端 + 磷光绿，极客风。": "Near-black terminal + phosphor green — geek mode.",
  "赛博朋克 2077 霓虹黄，暗夜街头。": "Cyberpunk 2077 neon yellow — neon-noir streets.",
  "高对比度浅色，简洁清爽。": "High-contrast light — clean and crisp.",
  "暖色浅色调，明亮环境更舒适。": "Warm light tone — easier in bright rooms.",
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
  "GPU 渲染（界面与动效）": "GPU rendering (UI & animations)",
  "开启时用 GPU 加速亚克力模糊、光晕与动画；关闭后改用极简渲染，几乎不占用显卡——游戏时避免与游戏抢 GPU，也可消除合成器卡顿":
    "When on, the GPU accelerates the acrylic blur, glow and animations; when off, a minimal render path uses almost no GPU — so it won't compete with your game, and it clears compositor stutter.",
  "开机自启动": "Start on boot",
  "登录 Windows 时自动以管理员身份启动（计划任务方式，不弹 UAC）；配合“关闭后保留到托盘”可在开机后静默后台运行":
    "Auto-starts as administrator at Windows logon (via a scheduled task — no UAC prompt); pair it with “Keep in tray on close” to run silently in the background after boot.",
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

  // Segmented / sub-tabs / positions / modes
  "快速优化": "Quick", "平衡": "Balanced", "高性能": "High Performance",
  "自动": "Auto", "手动": "Manual", "曲线": "Curve",
  "柔和": "Soft", "中等": "Medium", "强烈": "Strong",
  "实时": "Live", "历史": "History", "横向": "Horizontal", "竖排": "Vertical",
  "左上": "Top-left", "上中": "Top-center", "右上": "Top-right",
  "左下": "Bottom-left", "下中": "Bottom-center", "右下": "Bottom-right", "自由": "Free",
  "全部核心": "All cores", "强制记录": "Force record", "从不记录": "Never record",
  "强制显示": "Force show", "强制隐藏": "Force hide",
  "性能": "Performance", "进程": "Processes", "详细信息": "Details", "启动": "Startup", "服务": "Services",

  // Context-menu items
  "立即应用核心分配": "Apply affinity now", "从分组移出": "Remove from group",
  "添加游戏内覆盖": "Add in-game override", "结束任务": "End task", "结束进程": "End process",
  "复制名称": "Copy name", "复制 PID": "Copy PID", "复制应用路径": "Copy app path",
  "打开文件位置": "Open file location", "设为低优先级": "Set low priority",
  "设为正常优先级": "Set normal priority", "设为高优先级": "Set high priority",
  "刷新 DNS 缓存": "Flush DNS cache", "重新获取 IP": "Renew IP",
  "重置 TCP/IP（需重启）": "Reset TCP/IP (reboot)", "重置 Winsock（需重启）": "Reset Winsock (reboot)",
  "重置代理": "Reset proxy",

  // Metrics / chart labels / telemetry
  "CPU 占用": "CPU usage", "CPU 温度": "CPU temp", "CPU 频率": "CPU clock", "CPU 功耗": "CPU power",
  "CPU时间": "CPU time", "GPU 占用": "GPU usage", "GPU 温度": "GPU temp", "GPU 频率": "GPU clock",
  "GPU 功耗": "GPU power", "GPU 风扇": "GPU fan", "GPU 引擎": "GPU engines",
  "内存占用": "Memory usage", "显存占用": "VRAM usage", "显存频率": "VRAM clock",
  "显存控制器": "VRAM controller", "显存已用": "VRAM used", "显存总量": "VRAM total",
  "显存占用量": "VRAM used", "磁盘": "Disk", "硬盘": "Disk", "网络": "Network",
  "上传": "Upload", "下载": "Download", "上传速度": "Upload speed", "下载速度": "Download speed",
  "读取速度": "Read speed", "写入速度": "Write speed", "磁盘读": "Disk read", "磁盘写": "Disk write",
  "磁盘活动": "Disk activity", "总功耗": "Total power", "帧时间": "Frame time",
  "最低 FPS": "Min FPS", "最高 FPS": "Max FPS", "平均 FPS": "Avg FPS",
  "占用率 (%)": "Usage (%)", "占用率": "Usage", "占用量": "Usage", "占空比": "Duty",
  "温度 (°C)": "Temp (°C)", "频率 (MHz)": "Clock (MHz)", "风扇转速 (%)": "Fan speed (%)",
  "热功耗 (W)": "Power (W)", "活动时间 (%)": "Activity (%)", "帧时间 (ms)": "Frame time (ms)",
  "显存占用 (%)": "VRAM (%)", "显存频率 (MHz)": "VRAM clock (MHz)", "核心频率 (MHz)": "Core clock (MHz)",
  "平均 CPU 占用": "Avg CPU usage", "平均 CPU 温度": "Avg CPU temp", "平均 CPU 功耗": "Avg CPU power",
  "平均 GPU 占用": "Avg GPU usage", "平均 GPU 温度": "Avg GPU temp", "平均 GPU 功耗": "Avg GPU power",
  "平均 GPU 频率": "Avg GPU clock", "平均内存占用": "Avg memory", "平均显存占用": "Avg VRAM",
  "平均帧时间": "Avg frame time", "最高 CPU 温度": "Max CPU temp", "最高 GPU 温度": "Max GPU temp",
  "核心": "Core", "显存": "VRAM",
  "最低": "Min", "最高": "Max", "平均": "Avg", "功耗": "Power", "温度": "Temp", "频率": "Clock",
  "转速": "RPM", "风扇转速": "Fan RPM", "核心频率": "Core clock", "显存频率偏移": "VRAM clock offset",
  "核心频率偏移": "Core clock offset", "频率偏移": "Clock offset", "逻辑处理器利用率": "Logical CPU usage",
  "CPU + GPU 实时功耗": "Live CPU + GPU power", "用电量 (CPU + GPU)": "Power draw (CPU + GPU)",
  "本次会话 CPU + GPU 功耗积分": "Session CPU + GPU energy", "二氧化碳排放量 (估算)": "CO₂ emissions (est.)",
  "专用显存 (Dedicated)": "Dedicated VRAM", "实时遥测": "Live telemetry", "网络上传 / 下载": "Net up / down",
  "网络诊断与修复": "Network diagnostics & repair",

  // Common actions / buttons / states
  "应用": "Apply", "应用中…": "Applying…", "保存当前": "Save current", "另存为": "Save as",
  "保存为新的配置": "Save as a new profile", "保存为配置": "Save as profile",
  "保存超频配置": "Save OC profile", "保存风扇配置": "Save fan profile", "保存": "Save",
  "恢复默认": "Reset to default", "全部还原默认": "Revert all", "创建系统还原点": "Create restore point",
  "取消": "Cancel", "删除": "Delete", "添加": "Add", "刷新": "Refresh", "显示全部": "Show all",
  "仅显示活动": "Active only", "导入": "Import", "导出": "Export", "全选": "Select all",
  "全选 / 取消全选": "Select / clear all", "仅此组": "This group only", "完成": "Done",
  "开始校准": "Start calibration", "AI 智能校准": "AI Auto-Tune", "AI 校准完成": "AI calibration done",
  "一键优化": "One-click optimize", "一键检测": "Scan now", "确定": "OK", "重试": "Retry",
  "清空": "Clear", "全部清空": "Clear all", "清空历史": "Clear history", "新建分组": "New group",
  "删除分组": "Delete group", "选择核心": "Select cores", "用默认": "Use default", "自定义": "Custom",
  "确认修复": "Confirm repair", "确认开启危险优化": "Confirm enabling danger tweaks",
  "确认执行修复": "Confirm repair", "我了解风险,开启": "I understand the risk, enable",
  "修复所选": "Repair selected", "修复中…": "Repairing…", "执行中…": "Running…", "检测中…": "Scanning…",
  "点击执行": "Click to run", "点击关闭": "Click to dismiss", "重启": "Reboot",

  // Fan page
  "风扇接口": "Fan headers", "风扇配置": "Fan profiles", "温度源": "Temp source",
  "手动转速": "Manual speed", "最低转速下限（风扇不会低于此值）": "Minimum duty floor (fan never goes below this)",
  "起转": "Start", "起转转速与最高转速": "start RPM and max RPM", "全速 100%": "Full speed 100%",
  "刷新风扇接口": "Refresh fan headers",
  "双击空白加点 · 双击点删除": "Double-click empty to add a point · double-click a point to remove",
  "启动时自动应用": "Apply on startup",
  "把每个风扇调好后点「保存当前」存为一套方案,之后即可一键切换(如「静音」「游戏全速」)。":
    "Tune each fan, then “Save current” to store a profile you can switch in one click (e.g. “Silent”, “Full speed”).",
  "将保存当前每个风扇的模式与曲线，可随时一键切换。": "Saves each fan's current mode and curve; switch any time in one click.",
  "暂未检测到有效转速的风扇接口（接口接入风扇并转动后会自动显示）。":
    "No fan headers reporting RPM yet (a header appears once a connected fan spins).",
  "正在读取风扇接口…": "Reading fan headers…", "未检测到主板风扇传感器": "No motherboard fan sensors detected",
  "未检测到风扇": "No fan", "水泵": "Pump",
  "风扇调速依赖主板 Super-I/O 芯片（Nuvoton / ITE / Fintek）。请确认以管理员身份运行；部分笔记本或精简主板可能不暴露风扇控制。":
    "Fan control relies on the board's Super-I/O chip (Nuvoton / ITE / Fintek). Run as admin; some laptops / minimal boards don't expose fan control.",
  "此风扇接口被主板固件锁定，无法软件调速（仅可读取转速）。":
    "This header is locked by board firmware — no software control (RPM read-only).",
  "检测到风扇转速，但本主板固件未开放软件写入风扇接口（部分锁定的消费级主板如此）。可读取监控，暂不能调速 —— 这是主板固件限制，并非 CorePilot 问题。":
    "Fan RPM is readable, but this board's firmware doesn't allow software fan writes (some locked consumer boards do this). Monitoring works; control doesn't — a firmware limit, not a CorePilot issue.",
  "曲线模式按所选温度源实时插值调速；手动模式固定转速；自动模式交还主板 BIOS 控制。CorePilot 退出时会把所有被接管的风扇恢复为 BIOS 默认，避免风扇被锁定在某一转速。":
    "Curve mode interpolates against the chosen temp source; Manual holds a fixed speed; Auto hands control back to the BIOS. On exit CorePilot returns every managed fan to BIOS default so none stays locked at a speed.",
  "调速会影响散热，请确保温度处于安全范围。": "Fan speed affects cooling — keep temps in a safe range.",
  "温度曲线预设(自动按温度调速)": "Temperature-curve preset (auto by temp)",
  "逐个风扇扫描转速，自动生成专属曲线（约 30 秒/风扇）":
    "Sweep each fan's RPM and auto-build a tailored curve (~30 s / fan)",
  "已为每个风扇生成专属曲线（怠速取最低稳定转速，70°C 全速）并自动应用。":
    "Built a tailored curve per fan (idle at the lowest stable speed, full speed at 70°C) and applied it.",
  "期间风扇会明显变速、可能有噪音，属正常现象；校准时建议不要运行重负载。完成后自动应用。":
    "Fans will change speed audibly during this — that's normal; avoid heavy load while calibrating. Applied automatically when done.",
  "校准失败": "Calibration failed", "正在校准": "Calibrating", "确定删除配置": "Delete the profile",
  "重置默认曲线": "Reset to default curve",
  "撤销 AI 校准 / 自定义，恢复内置默认曲线": "Undo AI calibration / custom tweaks; restore the built-in default curve",
  "删除风扇配置": "Delete fan profile", "确定删除超频配置": "Delete the OC profile",
  "删除超频配置": "Delete OC profile",
  "吗？此操作不可撤销（当前风扇设置不受影响）。": "? This can't be undone (current fan settings are unaffected).",
  "吗？此操作不可撤销（当前 GPU 设置不受影响）。": "? This can't be undone (current GPU settings are unaffected).",
  "配置名称，例如「静音」「游戏全速」": "Profile name, e.g. “Silent” / “Full speed”",
  "配置名称，例如「游戏全速」「静音节能」": "Profile name, e.g. “Full speed” / “Silent & efficient”",

  // GPU page
  "功率上限": "Power limit", "目标功率（提高可获得更持久的 Boost）": "Target power (higher sustains Boost longer)",
  "温度上限": "Temp limit", "目标温度（达到后自动降频维持，越低越凉、性能略降）":
    "Target temp (throttles to hold it; lower = cooler, slightly less performance)",
  "核心频率偏移（Afterburner 式 +/- MHz，提升 Boost 上限）":
    "Core clock offset (Afterburner-style +/- MHz, raises Boost ceiling)",
  "显存频率偏移（+/- MHz）": "VRAM clock offset (+/- MHz)", "调优控制": "Tuning controls",
  "偏移过高可能花屏或崩溃 —— 请小幅递增测试稳定性，随时「恢复默认」清零。":
    "Too high an offset can artifact or crash — raise in small steps to test stability; “Reset to default” zeroes it any time.",
  "清零所有偏移并恢复固件默认": "Zero all offsets and restore firmware default",
  "超频配置": "OC profiles", "当前配置": "current profile", "覆盖保存到当前所选配置": "Overwrite the selected profile",
  "未检测到受支持的 NVIDIA 显卡": "No supported NVIDIA GPU detected",
  "GPU 超频通过 NVIDIA NVML 实现，仅支持 NVIDIA 独立显卡。请确认已安装显卡驱动并以管理员身份运行。":
    "GPU overclocking uses NVIDIA NVML and supports NVIDIA discrete GPUs only. Install the GPU driver and run as admin.",
  "还没有保存的配置。调好参数后点「保存为配置」，即可一键随时切换；开启「启动时自动应用」后，CorePilot 启动会自动套用所选配置。":
    "No saved profiles yet. Tune the settings, then “Save as profile” to switch any time in one click; enable “Apply on startup” to auto-apply the chosen profile when CorePilot launches.",
  "已应用调优设置": "Tuning applied", "已恢复出厂默认": "Restored factory default", "已应用": "Applied",
  "功率上限 / 温度目标 / 风扇通过 NVIDIA NVML（钳制在固件安全范围，不会超压损坏）；核心 / 显存频率偏移通过 NVAPI 实现，即 MSI Afterburner 式 +/- MHz 真实超频，会提升 Boost 上限。":
    "Power limit / temp target / fan use NVIDIA NVML (clamped to firmware-safe limits — no over-volting damage); core / VRAM clock offsets use NVAPI — MSI Afterburner-style +/- MHz real overclocking that raises the Boost ceiling.",

  // Optimize page
  "释放内存": "Free memory", "清理缓存": "Clear cache", "清理临时文件": "Clean temp files", "刷新 DNS": "Flush DNS",
  "清空所有进程的工作集，回收驻留内存": "Trim every process's working set to reclaim resident memory",
  "清除 standby list，释放被缓存占用的内存": "Clear the standby list to free cache-held memory",
  "删除用户与系统临时目录中的文件": "Delete files in the user & system temp folders",
  "清空 DNS 解析缓存": "Flush the DNS resolver cache", "电源计划": "Power plan",
  "高性能模式降低 CPU 调度延迟，适合游戏": "High-performance lowers CPU scheduling latency — good for games",
  "释放内存 + 清理缓存 + 清理临时文件 + 刷新 DNS": "Free memory + clear cache + clean temp + flush DNS",
  "已释放工作集": "Working sets freed", "已清理 standby 缓存": "Standby cache cleared",
  "DNS 缓存已刷新": "DNS cache flushed",
  "提示：释放内存/清理缓存会让被回收的内容在下次访问时重新加载，建议在游戏前或内存占用偏高时使用。所有操作均安全可逆（缓存会自然重建）。":
    "Tip: freeing memory / clearing cache means reclaimed data reloads on next access — best used before gaming or when memory is high. All actions are safe and reversible (caches rebuild naturally).",

  // Deep optimization (tweaks)
  "安全区": "Safe zone", "危险区": "Danger zone",
  "· 可逆、低风险,放心开": "· reversible, low-risk — enable freely",
  "· 含需重启的修复": "· includes reboot-required fixes",
  "· 性能收益更大,但会削弱系统安全/功能": "· bigger gains, but weakens system security/features",
  "以下项目会降低系统安全性或关闭系统功能。仅在你清楚后果时使用,开启需二次确认,且随时可一键还原。":
    "These reduce system security or disable features. Use only if you understand the consequences — enabling needs confirmation, and all are one-click reversible.",
  "游戏调度优先级 (MMCSS)": "Game scheduling priority (MMCSS)",
  "提升游戏/多媒体的 CPU·GPU 调度优先级与响应度,减少卡顿。":
    "Raises CPU·GPU scheduling priority/responsiveness for games & media, reducing stutter.",
  "前台程序优先": "Foreground priority",
  "Win32PrioritySeparation 偏向前台应用,游戏/当前窗口获得更多 CPU。":
    "Win32PrioritySeparation favors foreground apps so the game / active window gets more CPU.",
  "关闭网络限流": "Disable network throttling",
  "解除多媒体网络节流 (NetworkThrottlingIndex),降低网络延迟。":
    "Lifts multimedia network throttling (NetworkThrottlingIndex), lowering latency.",
  "卓越性能电源计划": "Ultimate Performance power plan",
  "启用 Ultimate Performance,减少降频与延迟(台式机推荐)。":
    "Enables Ultimate Performance, reducing down-clocking & latency (recommended for desktops).",
  "关闭 SysMain (Superfetch)": "Disable SysMain (Superfetch)",
  "减少后台预读占用。SSD 上影响很小;机械硬盘请谨慎。":
    "Cuts background prefetch usage. Negligible on SSDs; use care on HDDs.",
  "关闭 Windows 搜索索引": "Disable Windows Search index",
  "省 CPU/磁盘,但开始菜单/资源管理器搜索会变慢。":
    "Saves CPU/disk, but Start-menu / Explorer search gets slower.",
  "关闭 NTFS 最后访问时间戳": "Disable NTFS last-access timestamps",
  "减少每次读文件的额外磁盘写入,降低 IO 开销。": "Cuts extra disk writes on every file read, lowering IO overhead.",
  "关闭遥测服务": "Disable telemetry services",
  "停用 DiagTrack / dmwappushservice 等遥测,省资源、护隐私。":
    "Disables DiagTrack / dmwappushservice telemetry — saves resources, protects privacy.",
  "关闭 Game DVR / 后台录制": "Disable Game DVR / background recording",
  "关闭 Xbox 后台游戏录制,通常能提升游戏帧数。": "Disables Xbox background recording — usually improves FPS.",
  "菜单零延迟": "Zero menu delay", "去掉菜单弹出延迟,界面操作更跟手。": "Removes menu pop-up delay for snappier UI.",
  "关闭自动更新": "Disable auto-update",
  "避免更新打断,但长期不更新有安全风险,请定期手动更新。":
    "Avoids update interruptions, but skipping updates is a security risk — update manually now and then.",
  "关闭 Defender 实时防护": "Disable Defender real-time protection",
  "明显降低后台占用,但关闭杀毒实时保护。若开启了「篡改防护」可能无法生效。":
    "Markedly lowers background usage but turns off real-time AV. May not apply if Tamper Protection is on.",
  "关闭内存完整性 (VBS / HVCI)": "Disable Memory Integrity (VBS / HVCI)",
  "可提升数个百分点性能,但降低内核安全防护。": "Can add a few % performance, but weakens kernel security.",
  "关闭 SmartScreen": "Disable SmartScreen",
  "去掉下载/应用信誉检查,运行更少拦截 —— 也少了一层防护。":
    "Removes download/app reputation checks — fewer prompts, but one less layer of protection.",
  "建议先创建还原点再调整": "Create a restore point before tweaking",
  "可随时在本页关闭开关一键还原。": "Toggle off here any time to revert in one click.",
  "该项需要重启电脑后才完全生效。": "Takes full effect after a reboot.", "需重启": "Reboot needed",
  "已全部还原为默认": "All reverted to default", "已创建系统还原点": "Restore point created",

  // Network diagnostics
  "一键检测常见断网问题，按需修复": "Scan common connectivity issues and fix as needed",
  "修复项（可自行勾选）": "Fixes (choose your own)", "修复结果": "Repair results",
  "未执行任何修复。": "No repairs performed.",
  "注意：含重置 Winsock / TCP-IP，这些操作需重启电脑后生效，并可能短暂中断现有网络连接。":
    "Note: includes Winsock / TCP-IP reset — these take effect after a reboot and may briefly drop current connections.",
  "部分修复（Winsock / TCP-IP 重置）需重启电脑后才能完全生效。":
    "Some fixes (Winsock / TCP-IP reset) only take full effect after a reboot.",

  // OSD page
  "窗口式叠加（桌面检测）": "Window overlay (desktop detection)",
  "检测到游戏自动在前台显示叠加，切到后台自动隐藏；无边框 / 窗口化适用，不注入、最安全":
    "Auto-shows on a foreground game and hides when it's backgrounded; for borderless / windowed games — never injects, safest",
  "游戏内叠加（注入）": "In-game overlay (injection)",
  "注入式叠加，绘制在游戏画面内 — 支持独占全屏；自动检测反作弊并避让":
    "Injected overlay drawn inside the game frame — supports exclusive fullscreen; auto-detects and avoids anti-cheat",
  "桌面模式": "Desktop mode",
  "非游戏时也在桌面显示（仅 CPU / GPU / 内存 / 硬盘 / 网络，不含 FPS）":
    "Also show on the desktop when no game is running (CPU / GPU / Memory / Disk / Network only, no FPS)",
  "检测到 EasyAntiCheat / BattlEye / Vanguard 等反作弊时": "When EasyAntiCheat / BattlEye / Vanguard is detected",
  "绝不注入": "never inject",
  "，自动改用窗口叠加，避免误判封号。": ", it falls back to the window overlay to avoid a false-positive ban.",
  "开启后将自动叠加到前台游戏": "Once on, it overlays the foreground game automatically",
  "布局样式": "Layout style", "字体大小": "Font size", "背景不透明度": "Background opacity",
  "圆角背板": "Rounded plate", "OLED 防烧屏": "OLED burn-in shift", "屏幕位置": "Screen position",
  "拖动叠加层自由摆放": "Drag the overlay to place it freely", "水平位置 X": "Horizontal X", "垂直位置 Y": "Vertical Y",
  "色相": "Hue", "采样间隔": "Sample interval", "刷新率": "Refresh rate",
  "游戏名单 / 白·黑名单": "Game list / white·black list", "性能记录名单 / 白·黑名单": "Record list / white·black list",
  "默认在识别为游戏的应用上自动显示；白名单 = 强制显示，黑名单 = 强制隐藏。":
    "Shows automatically on detected games by default; whitelist = force show, blacklist = force hide.",
  "控制哪些程序会被记录性能报告（独立于 OSD 显示名单）：白名单 = 强制记录（即使未被识别为游戏），黑名单":
    "Controls which apps get a performance report recorded (separate from the OSD list): whitelist = force record (even if not detected as a game), blacklist",
  "= 从不记录（即使被识别为游戏）。": "= never record (even if detected as a game).",
  "暂无条目 — 默认仅记录自动识别为游戏的程序。在此添加以强制记录或屏蔽误判。":
    "No entries — by default only auto-detected games are recorded. Add here to force-record or block false positives.",
  "暂无游戏 — 在此添加，或在任务管理器中右键进程 → “添加游戏内覆盖”。":
    "No games — add here, or right-click a process in Task Manager → “Add in-game override”.",
  "可执行文件名，如 cyberpunk2077.exe": "Executable name, e.g. cyberpunk2077.exe",
  "从运行中的进程选择": "Pick from running processes", "从文件选择": "Pick from file",
  "搜索进程…": "Search processes…", "搜索进程名…": "Search by process name…", "搜索服务…": "Search services…",
  "加入白名单（强制录制）": "Add to whitelist (force record)", "加入黑名单（不录制）": "Add to blacklist (never record)",
  "白名单 · 强制录制此程序": "Whitelist · always record this app", "黑名单 · 不录制此程序": "Blacklist · never record this app",
  "已为该游戏单独定制；点“用默认”可还原为全局默认。": "Customized for this game; click “Use default” to revert to the global default.",
  "当前沿用全局默认外观与监控项；在下方调整即为该游戏单独定制。":
    "Currently using the global default look & metrics; adjusting below customizes it for this game.",
  "已识别的游戏库": "Detected game library",
  "未扫描到已安装游戏（未安装 Steam/Epic/GOG，或装在非默认位置）。":
    "No installed games found (no Steam/Epic/GOG, or installed in a non-default location).",
  "自动扫描各启动器安装目录;运行其中任意一款都会被判定为游戏(无需手动加白名单)。":
    "Auto-scans each launcher's install folder; running any of them counts as a game (no manual whitelist needed).",
  "正在检测前台游戏…": "Detecting foreground game…", "需 PresentMon": "needs PresentMon",

  // Core assignment
  "进程分组": "Process groups", "分组": "Groups", "分组颜色": "Group color", "自定义分组颜色": "Custom group color",
  "全部进程": "All processes", "还没有分组": "No groups yet", "请先在左侧创建一个分组": "Create a group on the left first",
  "已导入分组方案": "Group profile imported", "已导出分组方案": "Group profile exported",
  "导入失败：文件无效": "Import failed: invalid file", "仅 V-Cache CCD": "V-Cache CCD only",
  "全核": "All cores", "性能核": "P-cores", "能效核": "E-cores", "频率核心": "Freq cores",
  "频率 CCD": "Freq CCD", "跨 CCD": "Cross-CCD",
  "确定要结束": "End", "已添加": "Added", "组": "group",

  // Task Manager
  "句柄": "Handles", "线程": "Threads", "用户": "User", "命令": "Command", "描述": "Description",
  "状态": "Status", "名称": "Name", "操作": "Action", "平台": "Platform", "位置": "Location",
  "硬件线程": "HW threads", "逻辑处理器": "Logical CPUs", "超线程": "Hyper-Threading",
  "显卡": "GPU", "电源": "Power", "总计": "Total", "其他": "Other",
  "服务名": "Service", "系统启动": "Boot", "用户启动": "Login", "启动文件夹": "Startup folder",
  "无法读取进程列表": "Couldn't read the process list", "无法读取服务列表": "Couldn't read the service list",
  "无法读取启动项": "Couldn't read startup items", "没有匹配的进程": "No matching processes",
  "没有匹配的服务": "No matching services", "没有启动项": "No startup items",
  "正在读取进程…": "Reading processes…", "正在读取…": "Reading…", "个进程": "processes",
  "运行中": "Running", "已停止": "Stopped", "已暂停": "Paused", "已禁用": "Disabled", "已启用": "Enabled",
  "高": "High", "高于正常": "Above normal", "正常": "Normal", "低于正常": "Below normal", "低": "Low",
  "设置优先级失败（受保护进程）": "Failed to set priority (protected process)",
  "打开文件位置失败": "Couldn't open file location",

  // Perf reports / monitor
  "暂无性能报告": "No performance reports yet",
  "启动并退出游戏后，CorePilot 会自动记录本次会话并在此生成性能报告。":
    "After you launch and exit a game, CorePilot records the session and generates a report here.",
  "删除性能报告": "Delete report", "删除报告": "Delete report", "清空性能历史": "Clear performance history",
  "份性能报告，此操作不可撤销。": " performance reports — this can't be undone.",
  "将删除": "Will delete", "将删除全部": "Will delete all",
  "的这份性能报告，此操作不可撤销。": "'s report — this can't be undone.",
  "无数据": "No data", "报告": "Report",

  // GPU/sensors notes
  "功率上限 / 温度目标 / 风扇通过 NVIDIA": "Power limit / temp target / fan via NVIDIA",
  "功耗 / 温度需要传感器组件；若显示 “—”，请确认 sensord 已随程序部署。":
    "Power / temp need the sensor component; if you see “—”, make sure sensord ships with the app.",

  // Static labels / titles / tooltips found in the i18n audit (whole-node matches)
  "创建分组": "Create group", "已停用 · 点击启用": "Off · click to enable", "进程名": "Process name",
  "总功耗 (CPU+GPU)": "Total power (CPU+GPU)", "GPU 核心频率": "GPU core clock",
  "显存控制器占用": "VRAM controller usage", "磁盘读写": "Disk read/write",
  "↑ 上传": "↑ Upload", "↓ 下载": "↓ Download", "读取": "Read", "写入": "Write",
  "点击重命名": "Rename", "删除配置": "Delete profile", "移除": "Remove", "未发现进程": "No processes found",
  "分组名称": "Group name", "停止服务": "Stop service", "重启服务": "Restart service",
  "刷新服务列表": "Refresh service list", "刷新启动项": "Refresh startup items",
  "诊断 · DEBUG": "DIAGNOSTICS", "导出调试日志": "Export debug logs", "调试日志": "Debug log", "导出失败": "Export failed",
  "将本次启动以来的完整日志保存到下载文件夹，便于反馈问题。":
    "Saves the complete log since this launch to your Downloads folder for bug reports.",
  "预览 · 默认": "Preview · default", "中文": "Chinese", "游戏": "Games",
  "将保存当前已开启的调优项，可随时一键应用。": "Saves the currently enabled tuning items so you can apply them any time.",
  "控制哪些程序会被记录性能报告（独立于 OSD 显示名单）：白名单 = 强制记录（即使未被识别为游戏），黑名单 = 从不记录（即使被识别为游戏）。":
    "Controls which apps get a performance report recorded (independent of the OSD list): whitelist = force record (even if not detected as a game), blacklist = never record (even if detected as a game).",

  // Misc states / units / labels
  "可用": "Available", "不支持": "Unsupported", "通过": "OK", "内置": "Built-in",
  "已用": "Used", "全部": "All", "当前": "Current", "默认": "Default", "停止": "Stop",
  "启用": "Enabled", "关闭": "Off", "开启": "On", "可逆": "Reversible",
  "32位": "32-bit", "64位": "64-bit", "驱动版本": "Driver version", "模块能力": "Module capabilities",
  "未知错误": "Unknown error", "操作失败": "Operation failed", "未运行": "Not running", "显示": "Show",
};

/** Non-reactive translate (for use outside React / inside the DOM walker). */
export function translate(zh: string, lang: "zh" | "en"): string {
  return lang === "en" ? EN[zh] ?? zh : zh;
}

/** Reactive translator hook for explicit `t("中文")` usage in components. */
export function useT(): (zh: string) => string {
  const lang = useSettings((s) => s.language);
  return (zh: string) => translate(zh, lang);
}

/**
 * Bilingual formatter for INTERPOLATED / fragmented strings the DOM walker can't
 * match (e.g. `已选 ${n}`). `tf(zh, en)` returns the right language; build each
 * side with its own interpolation so dynamic values slot in naturally.
 */
export function useTf(): (zh: string, en: string) => string {
  const lang = useSettings((s) => s.language);
  return (zh: string, en: string) => (lang === "en" ? en : zh);
}

/** Non-reactive bilingual formatter (for use outside React, e.g. in hooks/effects). */
export function tf(zh: string, en: string): string {
  return useSettings.getState().language === "en" ? en : zh;
}

// ── Global runtime translator ──────────────────────────────────────────────
const ORIG = new WeakMap<Text, string>();
const ATTRS = ["placeholder", "title", "aria-label"] as const;
const ORIG_ATTR = new WeakMap<Element, Map<string, string>>();

function translateTextNode(node: Text, en: boolean) {
  const raw = node.nodeValue ?? "";
  const trimmed = raw.trim();
  if (!trimmed) return;
  if (en) {
    const hit = EN[trimmed];
    if (hit !== undefined && hit !== trimmed) {
      if (!ORIG.has(node)) ORIG.set(node, raw);
      node.nodeValue = raw.replace(trimmed, hit);
    }
  } else {
    const orig = ORIG.get(node);
    if (orig !== undefined && node.nodeValue !== orig) node.nodeValue = orig;
  }
}

function translateAttrs(el: Element, en: boolean) {
  for (const attr of ATTRS) {
    const val = el.getAttribute(attr);
    if (en) {
      if (val) {
        const tr = val.trim();
        const hit = EN[tr];
        if (hit !== undefined && hit !== tr) {
          let m = ORIG_ATTR.get(el);
          if (!m) ORIG_ATTR.set(el, (m = new Map()));
          if (!m.has(attr)) m.set(attr, val);
          el.setAttribute(attr, val.replace(tr, hit));
        }
      }
    } else {
      const orig = ORIG_ATTR.get(el)?.get(attr);
      if (orig !== undefined) el.setAttribute(attr, orig);
    }
  }
}

function walk(root: Node, en: boolean) {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = tw.nextNode(); n; n = tw.nextNode()) texts.push(n as Text);
  for (const t of texts) translateTextNode(t, en);
  if (root instanceof Element) {
    translateAttrs(root, en);
    root.querySelectorAll("[placeholder],[title],[aria-label]").forEach((el) => translateAttrs(el, en));
  }
}

// ── Neural "脉络亮起熄灭" language-switch animation ─────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";

interface NeuralNode {
  x: number;
  y: number;
}

/** Read a CSS custom property off :root, falling back to a default. */
function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Procedurally place neuron nodes at random viewport positions. */
function makeNodes(count: number, w: number, h: number): NeuralNode[] {
  const nodes: NeuralNode[] = [];
  // Keep nodes off the very edge so the glow isn't clipped.
  const padX = w * 0.06;
  const padY = h * 0.06;
  for (let i = 0; i < count; i++) {
    nodes.push({
      x: padX + Math.random() * (w - padX * 2),
      y: padY + Math.random() * (h - padY * 2),
    });
  }
  return nodes;
}

/** Connect each node to its 2–3 nearest neighbours; dedupe undirected edges. */
function makeEdges(nodes: NeuralNode[]): Array<[number, number]> {
  const edges = new Set<string>();
  nodes.forEach((node, i) => {
    const neighbours = nodes
      .map((other, j) => ({ j, d: (other.x - node.x) ** 2 + (other.y - node.y) ** 2 }))
      .filter((n) => n.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2 + Math.floor(Math.random() * 2)); // 2–3 nearest
    for (const n of neighbours) {
      const key = i < n.j ? `${i}-${n.j}` : `${n.j}-${i}`;
      edges.add(key);
    }
  });
  return [...edges].map((k) => k.split("-").map(Number) as [number, number]);
}

/**
 * Language switch: a SILKY content crossfade — the foreground UI gently dips, the
 * text swaps at the trough, then it returns — accompanied by a subtle neural-network
 * shimmer rendered in the BACKGROUND (inside `.app-backdrop`, low opacity, behind the
 * content). NEVER a flash over the UI. Pure WAAPI; self-cleaning. Returns a disposer.
 */
function runNeuralSwitch(runWalk: () => void): () => void {
  // Reduce-motion safety net: the caller only invokes this when reduce-motion is
  // off, but the effect re-runs only on language change — so if reduce-motion was
  // toggled on mid-flight, bail to an instant swap with no animation.
  if (document.documentElement.dataset.reduceMotion === "true") {
    runWalk();
    return () => {};
  }
  const SWAP_AT = 280; // text swaps at the crossfade trough
  const FADE_MS = 640; // content dip-and-return
  const LAYER_MS = 800; // background shimmer lifetime

  // Crossfade ONLY the foreground content (the app shell's children EXCEPT the
  // backdrop), so the background neural shimmer keeps glowing while the UI dips and
  // the backdrop itself never fades with the content.
  const backdrop = document.querySelector(".app-backdrop") as HTMLElement | null;
  const shell = backdrop?.parentElement ?? null;
  const contentEls: HTMLElement[] = shell
    ? Array.from(shell.children).filter(
        (el): el is HTMLElement =>
          el instanceof HTMLElement && !el.classList.contains("app-backdrop"),
      )
    : [document.body];
  const contentAnims = contentEls.map((el) =>
    el.animate([{ opacity: 1 }, { opacity: 0.6, offset: 0.42 }, { opacity: 1 }], {
      duration: FADE_MS,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    }),
  );

  // Subtle neural shimmer INSIDE the backdrop (behind the UI, low opacity). Skipped
  // when the backdrop is absent or hidden (低 GPU 模式 sets .app-backdrop display:none)
  // → then it's a pure content crossfade, still silky, just no shimmer.
  let layer: HTMLDivElement | null = null;
  if (backdrop && getComputedStyle(backdrop).display !== "none") {
    const accent = readVar("--color-accent", "oklch(62% 0.225 293)");
    const cyan = readVar("--color-cyan", "oklch(80% 0.13 218)");
    const w = backdrop.clientWidth || window.innerWidth || 1280;
    const h = backdrop.clientHeight || window.innerHeight || 720;

    layer = document.createElement("div");
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      zIndex: "1", // above .hud-grid but still inside the -z-10 backdrop → behind UI
      pointerEvents: "none",
      overflow: "hidden",
      opacity: "0",
      contain: "paint",
    } as CSSStyleDeclaration);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    Object.assign(svg.style, { width: "100%", height: "100%", display: "block" } as CSSStyleDeclaration);
    layer.appendChild(svg);

    const nodes = makeNodes(14 + Math.floor(Math.random() * 5), w, h);
    const edges = makeEdges(nodes);
    const lineEls: SVGLineElement[] = [];
    edges.forEach(([a, b]) => {
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(nodes[a].x));
      line.setAttribute("y1", String(nodes[a].y));
      line.setAttribute("x2", String(nodes[b].x));
      line.setAttribute("y2", String(nodes[b].y));
      const useCyan = Math.random() < 0.35;
      line.setAttribute("stroke", useCyan ? cyan : accent);
      line.setAttribute("stroke-width", "1.1");
      line.setAttribute("stroke-linecap", "round");
      line.style.opacity = "0";
      svg.appendChild(line);
      lineEls.push(line);
    });
    const nodeEls: SVGCircleElement[] = [];
    nodes.forEach((node, i) => {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", String(node.x));
      c.setAttribute("cy", String(node.y));
      c.setAttribute("r", String(2 + Math.random() * 1.8));
      const useCyan = i % 4 === 0;
      c.setAttribute("fill", useCyan ? cyan : accent);
      c.style.filter = `drop-shadow(0 0 5px ${useCyan ? cyan : accent})`;
      c.style.transformBox = "fill-box";
      c.style.transformOrigin = "center";
      c.style.opacity = "0";
      svg.appendChild(c);
      nodeEls.push(c);
    });

    backdrop.appendChild(layer);

    // Whole-layer envelope: fade in, hold faint, fade out — ambient, never harsh.
    layer.animate(
      [{ opacity: 0 }, { opacity: 0.7, offset: 0.2 }, { opacity: 0.7, offset: 0.72 }, { opacity: 0 }],
      { duration: LAYER_MS, easing: "ease-in-out", fill: "both" },
    );
    // SMOOTH (not stepped) low-opacity synapse pulses, staggered for an organic feel.
    const STAGGER = 16;
    lineEls.forEach((line, i) => {
      line.animate(
        [{ opacity: 0 }, { opacity: 0.16, offset: 0.45 }, { opacity: 0.08, offset: 0.75 }, { opacity: 0.13 }],
        { duration: 520, delay: 80 + i * STAGGER, easing: "ease-in-out", fill: "both" },
      );
    });
    nodeEls.forEach((c, i) => {
      c.animate(
        [
          { opacity: 0, transform: "scale(0.6)" },
          { opacity: 0.22, transform: "scale(1.15)", offset: 0.45 },
          { opacity: 0.12, transform: "scale(1)", offset: 0.75 },
          { opacity: 0.18, transform: "scale(1.05)" },
        ],
        { duration: 560, delay: 60 + Math.round(i * STAGGER * 0.8), easing: "ease-in-out", fill: "both" },
      );
    });
  }

  // Swap the language at the crossfade trough so the change reads as a smooth dip.
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    runWalk();
  };
  const swapTimer = window.setTimeout(swap, SWAP_AT);

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    window.clearTimeout(swapTimer);
    window.clearTimeout(endTimer);
    contentAnims.forEach((a) => {
      try {
        a.cancel();
      } catch {
        /* already finished/removed */
      }
    });
    layer?.remove();
  };
  const endTimer = window.setTimeout(cleanup, LAYER_MS + 40);

  // Disposer: ensure the swap still happens and everything is cleaned up on unmount.
  return () => {
    swap();
    cleanup();
  };
}

/**
 * Mount once in <App>. Applies the dictionary to the whole DOM on a language
 * change (with a brief fade for a smooth switch) and keeps newly rendered nodes
 * in sync via a MutationObserver.
 */
export function useGlobalI18n(): void {
  const lang = useSettings((s) => s.language);
  const langFirst = useRef(true);
  useEffect(() => {
    const en = lang === "en";
    // Honour ONLY the in-app reduce-motion toggle. The rest of CorePilot ignores the
    // OS prefers-reduced-motion flag on purpose (see index.css), so the language
    // animation must too — otherwise it's the ONE thing that silently vanishes on a
    // PC that has OS "reduced motion / show animations off" enabled.
    const reduce = document.documentElement.dataset.reduceMotion === "true";
    const runWalk = () => walk(document.body, en);

    let disposeNeural: (() => void) | undefined;
    if (langFirst.current || reduce) {
      // First mount (no change to animate) or reduced motion → swap instantly.
      langFirst.current = false;
      runWalk();
    } else {
      // Silky content crossfade (the UI dips, text swaps at the trough, then
      // returns) with a SUBTLE neural shimmer in the BACKDROP — never a flash over
      // the UI (see runNeuralSwitch).
      disposeNeural = runNeuralSwitch(runWalk);
    }

    let raf = 0;
    const pending: Node[] = [];
    const flush = () => {
      raf = 0;
      for (const n of pending.splice(0)) walk(n, en);
    };
    const observer = new MutationObserver((muts) => {
      if (!en) return;
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) pending.push(n);
        });
      }
      if (pending.length && !raf) raf = window.requestAnimationFrame(flush);
    });
    // NB: characterData is intentionally NOT observed. Live telemetry numbers update
    // their text nodes every poll tick; observing characterData fired this walker
    // continuously on data that's never translatable — a real main-thread drain.
    // New translatable nodes still arrive via childList when components mount.
    observer.observe(document.body, { childList: true, subtree: true, characterData: false });

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      observer.disconnect();
      disposeNeural?.();
    };
  }, [lang]);
}
