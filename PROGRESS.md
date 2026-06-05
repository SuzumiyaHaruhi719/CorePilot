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
- In-app auto-enforcer: newly-launched matching processes auto-bound to their group while CorePilot runs

### ② 任务管理器 (secondary tabs: 性能 / 进程 / 详细信息 / 启动 / 服务)
- Performance: live CPU + Mem + GPU%/VRAM + Disk + Network cards, per-core/per-CCD heatmap, user-selectable metric chips (autosaved)
- Processes + Details: sortable table, End task (confirm), right-click priority/copy
- Startup: list (Run keys + Startup folder) + enable/disable (StartupApproved)
- Services: list (SCM) + start / stop / restart

### ③ 游戏监控
- Live dashboard: big CPU/GPU/RAM gauges + sparklines, disk/net rates

### ④ 优化
- Free working sets, purge standby list, clean temp, flush DNS, one-click 一键优化, power-plan (Balanced/High Performance)

### ⑤ 设置
- Accent / glow / acrylic / reduce-motion / language / poll interval / perf-card visibility — all auto-saved

### Sensors backend (sensors.rs)
- GPU% + VRAM (PDH + DXGI), disk R/W + active% (PDH), network up/down (sysinfo) — REAL
- CPU/GPU power + temps: None (honest — needs a kernel sensor driver)

### 🌀 风扇控制 (fan.rs + sensord sidecar) — FanXpert-style
- `sensord` sidecar extended: enables LHM Motherboard+Controller, streams fans
  (RPM) / temps / controls (PWM) per line, and accepts stdin commands
  (`set <id> <pct>` / `auto <id>` / `autoall`); resets driven fans to BIOS
  default on exit.
- `fan.rs`: snapshot ingest, `fan_info` / `fan_set_config` commands, and a ~2 Hz
  curve engine (auto / manual / temperature-curve with selectable source,
  min-duty floor, hysteresis). Reuses the single sidecar (one driver load).
- Frontend 风扇 tab: live RPM + duty per header, mode segmented, manual slider,
  draggable SVG curve editor (live operating-point marker), 启动时自动应用.
  Graceful "board locked" state when firmware refuses PWM writes.
- Build: `dotnet build`/`cargo check`/`tsc`+`vite build` all green. NOT yet
  exercised on hardware (per owner instruction — functional testing deferred).

## 🔵 Deferred / honest gaps (documented for morning)
- In-game FPS overlay (PresentMon) — Monitor shows live sensors; FPS card marked "即将上线"
- Boot-time background daemon + tray — in-app enforcer auto-applies rules while CorePilot runs; no separate boot-launched watcher yet
- Real wattage/temperature — needs an optional signed sensor driver (not auto-installed without consent)
- Task Manager App history / Users tabs — Perf/Processes/Details/Startup/Services done
- Re-enable acrylic blur as an option (removed per request)

## Build artifacts
- `npm run tauri build` → standalone `src-tauri/target/release/corepilot.exe` (~9.6 MB, auto-elevates)
  + installer `…/bundle/nsis/CorePilot_0.1.0_x64-setup.exe`
- Auto-elevation manifest embedded via `build.rs`
