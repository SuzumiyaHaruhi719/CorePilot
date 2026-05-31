# CorePilot — Build Progress

> Premium Windows 11 performance optimizer for AMD Ryzen 9 9950X3D.
> Tauri 2 + Rust (windows-rs) + React 19 / TS / Vite / Tailwind v4 / Motion / zustand.
> Runs ELEVATED in dev. Detailed sub-plans in `docs/planning/`.

## ✅ Done & verified (compiles: `cargo check` + `tsc` green; runs via `tauri dev`)

### Foundation + Shell
- Tauri 2 + React-TS scaffold; Rust backend modules (topology, process, affinity, sysmon, optimize, sensors, commands)
- Opaque dark "cockpit" palette (OKLCH), violet accent, CCD teal/amber identity colors, Microsoft YaHei/PingFang fonts, antialiased
- Custom title bar (window controls), animated 5-tab NavRail (glowing active pill), live StatusBar (CPU%/RAM)
- Compositor-only animations (transform/opacity), smooth tab transitions, card entrances, animated number tickers
- Suppressed WebView default right-click; custom themed context menus
- Acrylic intentionally REMOVED for now (per request) — re-add later

### ① 进程核心分配 (flagship)
- CPU topology detection: CCD0 V-Cache vs CCD1 frequency (GetLogicalProcessorInformationEx)
- Group rail (core-chip badges + active/total counts), seeded defaults (游戏 = V-Cache, 全核)
- Virtualized-ready sortable process table: 进程名/线程/CPU/GPU/内存/电源, click-to-sort, search, select-all, multi-select
- Per-process GPU% (PDH GPU Engine) + relative power-impact index
- CCD core-grid selector (32 LPs, presets incl. 仅 V-Cache CCD), apply affinity + priority
- Group persistence (autosave), import/export JSON, master 停用优化 toggle
- Right-click: add-to-group / apply / remove / end / copy

### ② 任务管理器 (secondary tabs: 性能 / 进程 / 详细信息)
- Performance: live CPU + Mem + GPU%/VRAM + Disk + Network cards, per-core/per-CCD heatmap, user-selectable metric chips (autosaved)
- Processes + Details: sortable table, End task (confirm), right-click priority/copy

### ③ 游戏监控
- Live dashboard: big CPU/GPU/RAM gauges + sparklines, disk/net rates

### ④ 优化
- Free working sets, purge standby list, clean temp, flush DNS, one-click 一键优化, power-plan (Balanced/High Performance)

### ⑤ 设置
- Accent / glow / acrylic / reduce-motion / language / poll interval / perf-card visibility — all auto-saved

### Sensors backend (sensors.rs)
- GPU% + VRAM (PDH + DXGI), disk R/W + active% (PDH), network up/down (sysinfo) — REAL
- CPU/GPU power + temps: None (honest — needs a kernel sensor driver)

## 🔵 Deferred / honest gaps (documented for morning)
- In-game FPS overlay (PresentMon) — Monitor shows live sensors; FPS marked "即将上线"
- Persistent background daemon + tray auto-reapply on process launch — rules persist + apply on demand/assignment, but no boot-time watcher yet
- Real wattage/temperature — needs an optional signed sensor driver (not auto-installed without consent)
- Full Task Manager parity (App history / Startup / Users / Services tabs) — core views (Perf/Processes/Details) done
- Release installer + auto-elevation manifest — see below

## Next
- Win elevation manifest (build.rs) + `tauri build` → NSIS installer
- Re-enable acrylic as an option
