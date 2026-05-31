# CorePilot

**面向 AMD Ryzen 9 9950X3D 的高级 Windows 性能优化软件**
A premium Windows 11 performance‑optimization app — CCD‑aware process affinity, a full‑featured
Task Manager, live monitoring, and one‑click optimization. Built with Tauri 2 (Rust) + React.

---

## 功能 Features

### ① 进程核心分配 (Process Core Assignment)
受《游戏++》启发的 CPU 亲和性管理器，专为 9950X3D 的双 CCD 架构设计：
- 列出所有运行进程：**进程名 / 线程数 / CPU / GPU / 内存 / 电源占用**，全部支持点击排序、搜索、多选、全选
- 自动检测 **CCD0 (3D V‑Cache) 与 CCD1 (高频)** 拓扑
- 创建进程分组，为每个分组选择可运行的 **核心 / 线程 (C/T)**——32 逻辑核网格，含 “仅 V‑Cache CCD / 仅频率 CCD / 全核” 预设
- 分组规则本地持久化（“记忆”），支持导入 / 导出方案
- 右键菜单：加入分组 / 应用 / 移出 / 结束 / 复制；一键 **停用优化** 总开关

### ② 任务管理器 (Task Manager 复刻)
二级标签页：
- **性能**：CPU / 内存 / GPU / 显存 / 磁盘 / 网络实时曲线 + 每逻辑核·每 CCD 热力图，**可自选显示哪些指标**
- **进程 / 详细信息**：可排序进程表、结束任务、设置优先级、右键菜单

### ③ 游戏监控 (Monitoring)
实时性能仪表盘：CPU / GPU / 内存大号读数 + 曲线，磁盘 / 网络速率。
> 游戏内 FPS 叠加 (PresentMon) 计划在后续版本加入。

### ④ 优化 (Optimization)
- 释放内存（清空工作集）、清理 standby 缓存、清理临时文件、刷新 DNS
- 电源计划切换（平衡 / 高性能）
- **一键优化**：以上全部 + 高性能电源计划

### ⑤ 设置 (Settings)
强调色 / 发光强度 / 亚克力 / 减弱动画 / 语言 / 刷新间隔 / 性能卡片可见性 —— **全部即时自动保存**。

---

## 运行 Running

应用需要 **管理员权限**（设置进程亲和性、清理 standby list 等）。发行版 exe 已内置清单，会自动请求 UAC 提权。

```powershell
# 开发模式
npm install
npm run tauri dev

# 构建发行版（生成 NSIS 安装包 + 独立 exe）
npm run tauri build
# 产物: src-tauri/target/release/corepilot.exe
#       src-tauri/target/release/bundle/nsis/CorePilot_*_x64-setup.exe
```

环境要求：Windows 10/11、Node ≥ 18、Rust (stable‑msvc)、MSVC Build Tools、WebView2 Runtime。

---

## 技术栈 Tech Stack
- **后端**：Rust + Tauri 2，`windows` (windows‑rs) 直接调用 Win32 — 亲和性 (`SetProcessAffinityMask`)、拓扑 (`GetLogicalProcessorInformationEx`)、PDH 性能计数器、DXGI、`NtSetSystemInformation` 内存命令
- **前端**：React 19 + TypeScript + Vite + Tailwind v4 + Motion (动画) + zustand
- **传感器**：PDH (GPU/磁盘) + DXGI (显存) + sysinfo (网络/进程)

## 诚实的局限 Known limitations
- **真实功耗 (瓦特) 与温度**：需要内核级传感器驱动（如 LibreHardwareMonitor）。本版本未自动安装驱动，相关字段显示 “—”。
- **游戏内 FPS 叠加**：需集成 Intel PresentMon，计划后续加入；当前监控页显示系统级实时占用。
- **常驻后台守护进程**：分组规则会持久保存并可手动 / 即时应用，但尚无开机自启的后台进程在程序启动时自动重新绑定（计划中）。
- **亚克力模糊**：按要求暂时关闭，后续将作为可选项重新加入。

详细规划见 `docs/planning/`，构建进度见 `PROGRESS.md`。
