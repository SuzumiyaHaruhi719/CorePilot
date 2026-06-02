<p align="center">
  <img src="branding/header.gif" alt="CorePilot" width="100%">
</p>

<h1 align="center">CorePilot</h1>

<p align="center">
  <b>面向现代 Windows 11 PC 的高端性能优化软件 — 自动适配 AMD / Intel CPU 与各家 GPU</b><br>
  A premium Windows 11 performance‑optimization app — topology‑aware process affinity (AMD CCD / 3D
  V‑Cache <i>and</i> Intel P/E hybrids), GPU overclocking, a full‑featured Task Manager, live
  monitoring, and one‑click optimization. Tuned on a Ryzen 9 9950X3D + RTX 4090, but it
  auto‑detects and adapts to whatever hardware it runs on.<br>
  <sub>Built with Tauri 2 (Rust) · React 19 · TypeScript · Tailwind v4 · Motion</sub>
</p>

---

## 功能 Features

### ① 进程核心分配 (Process Core Assignment)
受《游戏++》启发的 CPU 亲和性管理器，**自动适配你的 CPU 拓扑**（无需手动配置）：
- 列出所有运行进程：**进程名 / 硬件线程 / CPU / GPU / 内存 / 功耗**，全部支持点击排序、搜索、多选、全选
- **自动检测核心拓扑**：AMD 多 CCD / 3D V‑Cache、Intel 性能核 (P) / 能效核 (E) 混合架构、或单一核心组——经 `GetLogicalProcessorInformationEx` + Windows 效能等级 (EfficiencyClass)
- 创建进程分组，为每个分组选择可运行的 **核心 / 线程 (C/T)**——自适应逻辑核网格，按硬件给出 “仅 V‑Cache / 仅 P 核 / 仅此组 / 全核” 等预设；**每个分组可自定义颜色**
- “硬件线程” 列按进程当前亲和性显示其可用线程数与所跨核心组（**V‑Cache / 频率 CCD / 性能核 / 能效核 / CCD N**，随硬件自适应标注，绝不在非 X3D / Intel 机器上误标）
- **全部进程** 独立标签 + 分组视图（含 “已添加但未运行” 的成员）+ 可点击排序的 **分组** 列
- 分组规则本地持久化（“记忆”），支持导入 / 导出方案；运行时自动把新匹配的进程绑定到分组亲和性
- 右键菜单：加入分组 / 应用 / 移出 / 结束 / 复制；一键 **停用优化** 总开关

### ② 任务管理器 (Task Manager 1:1 复刻)
保留 CorePilot 风格的二级标签页：
- **性能**：CPU / 内存 / GPU / 显存 / 磁盘 / 网络实时曲线 + 每逻辑核·每 CCD 热力图，**可自选显示哪些指标**
- **进程**：可排序进程表 + GPU 占用 / GPU 引擎列（3D / Video Encode / Compute…）
- **详细信息**：名称 / PID / 用户 / CPU / CPU 时间 / 内存 / 句柄 / 线程 / 平台
- **服务 · 启动 · 应用历史**：1:1 列复刻；服务与启动项可按 “已启动优先” 排序、启停 / 禁用

### ③ GPU 超频 (GPU Overclocking) — 类 MSI Afterburner
基于 **NVIDIA NVML + NVAPI** 的实时显卡调优（NVIDIA 独显；其他品牌显卡可监控但不超频）：
- 实时读数：核心 / 显存频率、温度、功耗 (当前 / 上限)、GPU 占用、风扇、显存
- **功率上限**、**温度目标**、**风扇转速**（钳制在固件安全范围）+ **核心 / 显存频率偏移**（NVAPI，即 Afterburner 式 **+/- MHz 真实超频**，提升 Boost 上限）
- **超频配置保存**：命名保存 / 一键切换 / 删除；可设 “启动时自动应用”
- 安全：钳制类项目限制在安全范围；频率偏移为可选高级项（建议小幅递增测试稳定性），随时一键 **恢复出厂默认**

### ④ 优化 (Optimization)
- 释放内存（清空工作集）、清理 standby 缓存、清理临时文件、刷新 DNS
- 电源计划切换（平衡 / 高性能）
- **一键优化**：以上全部 + 高性能电源计划

### ⑤ 监控 & 设置 (Monitoring & Settings)
- 实时性能仪表盘：CPU / GPU / 内存大号读数 + 曲线，磁盘 / 网络速率
- 强调色 / 发光强度 / 减弱动画 / 语言 / 刷新间隔 / 性能卡片可见性 —— **全部即时自动保存**

> 路线图：游戏内 OSD 叠加（硬件指标已可用，FPS / 帧时间待接入 PresentMon）、可选亚克力模糊。

---

## 硬件适配 Hardware support

CorePilot 自动适配运行它的硬件，无需手动配置：

| 部件 | 支持范围 |
|------|----------|
| **CPU** | AMD 多 CCD / 3D V‑Cache（如 9950X3D）、Intel 性能核 / 能效核混合架构（12–14 代 / Core Ultra）、单 CCD Ryzen、同构 Intel —— 拓扑与核心类型自动识别并相应标注 |
| **GPU** | NVIDIA 独显：完整监控 + NVML / NVAPI 超频；AMD / Intel / 核显：监控（占用 / 显存 / 温度，经 PDH · DXGI · LibreHardwareMonitor），超频面板提示 “不支持” |
| **传感器** | 有 LibreHardwareMonitor sidecar 时提供 CPU / 主板功耗与温度；GPU 温度 / 功耗优先取 NVML（与 nvidia‑smi 一致），任何缺失的数据优雅降级为 “—” 而非伪造 |

> 在非 X3D / Intel / 单簇 CPU 上不会再误标 “V‑Cache / 频率 CCD”；GPU 温度在监控页与超频页一致（均取 NVML 核心温度，而非 sidecar 的热点温度）。

---

## 运行 Running

应用需要 **管理员权限**（设置进程亲和性、GPU 调优、清理 standby list 等）。发行版 exe 已内置清单，会自动请求 UAC 提权。

```powershell
# 开发模式
npm install
npm run tauri dev

# 构建发行版（生成 NSIS 安装包 + 独立 exe）
npm run tauri build
# 产物: src-tauri/target/release/corepilot.exe
#       src-tauri/target/release/bundle/nsis/CorePilot_*_x64-setup.exe
```

环境要求：Windows 10/11、Node ≥ 18、Rust (stable‑msvc)、MSVC Build Tools、WebView2 Runtime、.NET 8 (传感器 sidecar)。

---

## 技术栈 Tech Stack
- **后端**：Rust + Tauri 2，`windows` (windows‑rs) 直接调用 Win32 — 亲和性 (`SetProcessAffinityMask`)、拓扑 (`GetLogicalProcessorInformationEx` + EfficiencyClass，识别 AMD CCD / Intel P‑E)、PDH 性能计数器、DXGI、`NtSetSystemInformation` 内存命令、SCM 服务枚举
- **GPU 调优**：`nvml-wrapper` (NVML) — 功率上限 / 温度目标 / 风扇 + 实时读数；`nvapi` — 核心 / 显存 +/- MHz 频率偏移（Afterburner 式真实超频）
- **传感器**：LibreHardwareMonitor (.NET 8 sidecar) 提供 CPU / 主板功耗与温度；GPU 温度 / 功耗优先取 NVML（与 nvidia‑smi 一致）；PDH (GPU/磁盘) + DXGI (显存) + sysinfo (网络/进程)
- **前端**：React 19 + TypeScript + Vite + Tailwind v4 + Motion (动画) + zustand (自动持久化)

## 诚实的局限 Known limitations
- **GPU 超频**：功率 / 温度 / 风扇通过 NVML 钳制在固件安全范围；核心 / 显存 `+/- MHz` 频率偏移通过 **NVAPI**（Afterburner 式真实超频，偏移过高可能花屏，请小幅测试）。仅 **NVIDIA** 独显支持超频；AMD / Intel 显卡可监控但不可超频。
- **游戏内 OSD 叠加**：硬件指标（CPU / GPU / 内存 / 温度 / 功耗 / 频率…）的低占用叠加层开发中；**FPS / 帧时间 / 延迟** 需集成 Intel PresentMon（ETW present 计时），已预留接入点。
- **CPU 风扇曲线**：依赖主板 Super‑I/O / 嵌入式控制器；许多锁定的消费级主板（如部分 B850）固件不允许写入，故仅在受支持的主板上可用。
- **超大核心数 CPU**：前端亲和性掩码当前用 JS number（双精度），逻辑核 > 53 的平台（Threadripper / EPYC / 双路）核心分配可能不精确；后端 (u64) 正确。计划改用 BigInt。
- **亚克力模糊**：按要求暂时关闭，后续将作为可选项重新加入。

详细规划见 `docs/planning/`，构建进度见 `PROGRESS.md`。
