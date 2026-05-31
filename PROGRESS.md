# CorePilot — Build Progress

> Overnight autonomous build. Premium Windows 11 performance optimizer for AMD Ryzen 9 9950X3D.
> Stack: Tauri 2 + Rust (windows-rs) + React 19 / TS / Vite / Tailwind v4 / Motion / uPlot / zustand.
> Detailed sub-plans: `docs/planning/00..08`. Running ELEVATED (admin).

## Legend
✅ done & verified · 🟡 in progress · ⬜ todo · 🔵 stretch

## Phase 0 — Toolchain & Scaffold ✅
- ✅ Probe toolchain (Node24, .NET, MSVC BT 2022, WebView2 148, git; admin)
- ✅ Install Rust 1.96.0 (stable-msvc)
- ✅ Scaffold Tauri 2 + React-TS into `CorePilot/`
- ✅ Add Rust deps (windows 0.62, sysinfo 0.39, tokio, window-vibrancy 0.7, store)
- ✅ Add frontend deps (tailwind v4, motion, zustand, uplot, tanstack, lucide)
- ✅ Backend `cargo check` passes (topology/process/affinity/sysmon/commands)
- ✅ Frontend `tsc` passes

## Phase 1 — Foundation + Premium Animated Shell (glow + acrylic) 🟡
- ✅ tauri.conf: custom titlebar (decorations off), transparent, min-size, acrylic
- ✅ window-vibrancy acrylic + CSS soft-glow design tokens (OKLCH)
- ✅ Tailwind v4 theme (near-black surfaces, violet accent, CCD teal/amber)
- ✅ App shell: custom title bar, 5-tab NavRail w/ animated glowing pill, blur page transitions
- ✅ Live StatusBar (real CPU%/RAM via IPC), animated number tickers
- ✅ Settings tab fully functional w/ autosave (accent/glow/acrylic/motion/lang/poll)
- ✅ CoreAssignment shows real CCD topology strip (V-Cache vs frequency)
- 🟡 `tauri dev` launches & shows shell  ← verifying now
- ⬜ Win32 elevation manifest for release build (dev inherits admin)

## Phase 2 — FLAGSHIP: Process Core Assignment (Game++ replica)
- ⬜ Rust: CPU topology (GetLogicalProcessorInformationEx → CCD0 V-Cache / CCD1)
- ⬜ Rust: process enumeration + live metrics (sysinfo), get/set affinity + priority
- ⬜ Commands + live channel stream
- ⬜ UI: group rail (core-chip badges + counts), virtualized sortable table, CoreGrid selector
- ⬜ Groups CRUD + assign + apply affinity + JSON persistence (autosave)
- ⬜ Master "停用优化" toggle, import/export schemes

## Phase 3 — Task Manager replica + live monitoring
- ⬜ Processes view · Performance (per-core + per-CCD graphs, mem) · Details
- 🔵 App history · Startup · Users · Services

## Phase 4 — Optimization
- ⬜ Trim working sets, purge standby list, clear temp/DNS/caches, one-click game mode + revert

## Phase 5 — AMD 9950X3D suite
- ⬜ CCD presets (prefer V-Cache / freq / all), power plan, core-parking, read-only PBO/CO status

## Phase 6 — Settings (auto-save everything)
- ⬜ Theme, accent, glow/acrylic intensity, startup, language, guardrails

## Phase 7 — Game monitoring + OSD  🔵
- 🔵 PresentMon FPS/frametime, in-app charts, click-through OSD overlay

## Phase 8 — Daemon + tray + autostart  🔵
- 🔵 ETW/WMI process-launch watcher, auto-reapply rules, tray, Task Scheduler autostart

## Cross-cutting
- ⬜ Safety guardrails (critical-process whitelist, confirmations, undo)
- ⬜ Lightweight: decouple live telemetry from React render (refs+RAF), virtualize, pause off-screen
- ⬜ Continuous debug loop: `cargo check` + `tsc` + `tauri dev`

## Notes / decisions
- Dev runs elevated (inherits admin shell) so affinity works without a manifest in dev.
- "电源占用" = relative power index (no battery on desktop → Task-Manager-style energy score).
