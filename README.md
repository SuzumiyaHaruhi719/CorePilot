<p align="center">
  <img src="branding/header.gif" alt="CorePilot" width="100%">
</p>

<h1 align="center">CorePilot</h1>

<p align="center">
  <b>面向 AMD Ryzen 9 9950X3D 的高端 Windows 11 性能优化软件</b><br>
  A premium Windows 11 performance‑optimization app — CCD‑aware process affinity, GPU overclocking,
  a full‑featured Task Manager, live monitoring, and one‑click optimization.<br>
  <sub>Built with Tauri 2 (Rust) · React 19 · TypeScript · Tailwind v4 · Motion</sub>
</p>

---

## 功能 Features

### ① 进程核心分配 (Process Core Assignment)
受《游戏++》启发的 CPU 亲和性管理器，专为 9950X3D 的双 CCD 架构设计：
- 列出所有运行进程：**进程名 / 硬件线程 / CPU / GPU / 内存 / 功耗**，全部支持点击排序、搜索、多选、全选
- 自动检测 **CCD0 (3D V‑Cache) 与 CCD1 (高频)** 拓扑
- 创建进程分组，为每个分组选择可运行的 **核心 / 线程 (C/T)**——32 逻辑核网格，含 “仅 V‑Cache CCD / 仅频率 CCD / 全核” 预设
- “硬件线程” 列按进程当前亲和性显示其可用线程数与所跨 CCD（受保护的系统进程无法限制，保持全核）
- 分组规则本地持久化（“记忆”），支持导入 / 导出方案；运行时自动把新匹配的进程绑定到分组亲和性
- 右键菜单：加入分组 / 应用 / 移出 / 结束 / 复制；一键 **停用优化** 总开关

### ② 任务管理器 (Task Manager 1:1 复刻)
保留 CorePilot 风格的二级标签页：
- **性能**：CPU / 内存 / GPU / 显存 / 磁盘 / 网络实时曲线 + 每逻辑核·每 CCD 热力图，**可自选显示哪些指标**
- **进程**：可排序进程表 + GPU 占用 / GPU 引擎列（3D / Video Encode / Compute…）
- **详细信息**：名称 / PID / 用户 / CPU / CPU 时间 / 内存 / 句柄 / 线程 / 平台
- **服务 · 启动 · 应用历史**：1:1 列复刻；服务与启动项可按 “已启动优先” 排序、启停 / 禁用

### ③ GPU 超频 (GPU Overclocking) — 类 MSI Afterburner
基于 **NVIDIA NVML** 的实时显卡调优（NVIDIA 独显）：
- 实时读数：核心 / 显存频率、温度、功耗 (当前 / 上限)、GPU 占用、风扇、显存
- **功率上限**、**核心频率锁定**、**风扇转速** 三类调节，全部钳制在固件安全范围内
- **超频配置保存**：命名保存 / 一键切换 / 删除；可设 “启动时自动应用”
- 安全：NVML 不会超压、无法损坏硬件，随时一键 **恢复出厂默认**

### ④ 优化 (Optimization)
- 释放内存（清空工作集）、清理 standby 缓存、清理临时文件、刷新 DNS
- 电源计划切换（平衡 / 高性能）
- **一键优化**：以上全部 + 高性能电源计划

### ⑤ 监控 & 设置 (Monitoring & Settings)
- 实时性能仪表盘：CPU / GPU / 内存大号读数 + 曲线，磁盘 / 网络速率
- 强调色 / 发光强度 / 减弱动画 / 语言 / 刷新间隔 / 性能卡片可见性 —— **全部即时自动保存**

> 路线图：游戏内 FPS 叠加 (PresentMon)、**CPU 风扇曲线 (类 FanExpert 4)**、可选亚克力模糊。

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
- **后端**：Rust + Tauri 2，`windows` (windows‑rs) 直接调用 Win32 — 亲和性 (`SetProcessAffinityMask`)、拓扑 (`GetLogicalProcessorInformationEx`)、PDH 性能计数器、DXGI、`NtSetSystemInformation` 内存命令、SCM 服务枚举
- **GPU 调优**：`nvml-wrapper` (NVIDIA NVML) — 功率上限 / 锁定频率 / 风扇
- **传感器**：LibreHardwareMonitor (.NET 8 sidecar) 提供真实功耗 (瓦) 与温度；PDH (GPU/磁盘) + DXGI (显存) + sysinfo (网络/进程)
- **前端**：React 19 + TypeScript + Vite + Tailwind v4 + Motion (动画) + zustand (自动持久化)

## 诚实的局限 Known limitations
- **GPU 超频**：通过 NVML，因此是固件安全范围内的功率/锁频/风扇控制，**非** MSI Afterburner 那种 `+MHz` 偏移超频（后者需 NVAPI 私有接口，风险更高）。仅支持 NVIDIA 独显。
- **游戏内 FPS 叠加**：需集成 Intel PresentMon，计划后续加入。
- **CPU 风扇曲线**：计划基于 LibreHardwareMonitor 主板 Super‑I/O 控制实现，并带退出即恢复 BIOS/自动 的失效保护（开发中）。
- **亚克力模糊**：按要求暂时关闭，后续将作为可选项重新加入。

详细规划见 `docs/planning/`，构建进度见 `PROGRESS.md`。
