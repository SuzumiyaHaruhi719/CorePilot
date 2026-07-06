# CorePilot — working rules

Tauri v2 (Rust backend, React/zustand frontend, WebView2) system utility: task manager, fan/SMU tuning, game OSD + perf recorder, disk analyzer. Runs elevated, 24/7, on Windows 11.

## Iron rules (violating these caused real field failures)

1. **Never run a slow body in a sync `#[tauri::command]`.** Sync commands execute on the MAIN thread (the window's message pump); anything that locks `state.sys`, does disk/registry IO, PDH/NVML calls, or spawns a child process must be `async` + `commands::run_blocking_default` / `run_blocking_err` / `run_blocking`. This is the recurring "未响应" freeze class. `warn_slow` logs any body >100 ms — check logs before hunting.
2. **Never touch a transparent WebView2 window from a background thread, and never create/resize it per-frame.** Upstream GDI leak (tauri#11525) + main-thread create-hang. The OSD window recycles via the GDI guard (`osd.rs`); the taskbar plate is native Win32 on its own thread (`taskbar_mon.rs`) — cached GDI objects only, never per-paint creation.
3. **Store IO goes through `persist.rs` only** (atomic tmp+fsync+rename, quarantine + `.bak` auto-restore). Never `fs::write` user data; never hand-edit `corepilot.store.json` (corruption = total profile wipe).
4. **zustand stores: never bump `version` without a `migrate`** — zustand silently discards persisted state on mismatch (wiped data once).
5. **No per-PID "is a game" decisions from GLOBAL signals.** `SHQueryUserNotificationState` is session-global; using it per-app misdetected every presenting app while a game ran. Detection lives in `fps.rs::foreground_info_now` (library path check + ≥20 fps + window-covers-monitor); junk sessions are filtered at finalize in `perf_recorder.rs::should_keep`.
6. **Frontend↔backend config flows one way:** frontend pushes flat args (`perf_recorder_config`, `tbmon_config`) into a Rust static; Rust never parses the store. Keep new features on this pattern.
7. **Chinese-first UI**: user-visible strings are `tf(zh, en)` (or dict entries) — see `src/lib/i18n.ts`.

## Build / verify

- Build: `npx tauri build` — **never bare `cargo build`** (bakes the dev URL → ERR_CONNECTION_REFUSED). App must be closed first (exe lock).
- Compile-check while the app runs: `cargo check` + `cargo test --lib` in `src-tauri/`, `npx tsc --noEmit` at root.
- WebView2 screenshots come out black unless the window is visible; CJK in the Windows terminal displays as mojibake — verify bytes, not display.

## Map (where things live)

- `src-tauri/src/commands.rs` — most IPC commands + the blocking-pool helpers.
- `sampler.rs` — single-owner background sampling; everything reads its `Arc` snapshots (`metrics_snapshot`/`sensors_snapshot`), never re-samples hardware.
- `fps.rs` — ETW present-event FPS + foreground/game detection. One fixed-name session (`CorePilot-FPS`), stale ones force-stopped.
- `perf_recorder.rs` — per-PID concurrent game sessions, 5 Hz, finalize on process exit only; `should_keep` junk filter (launchers/tools).
- `persist.rs` — crash-safe store IO (see rule 3).
- `osd.rs` — corner OSD webview window: keep-alive + GDI-recycle guard, click-through/toolwindow style re-assert, close-guarded in `lib.rs`.
- `overlay_inject.rs` — in-game DLL injection OSD; `taskbar_mon.rs` — native taskbar plate (double-buffered paint, debounced fullscreen hide).
- `fan.rs`/`fan_autotune/` — fan engine + closed-loop tuning; `smu.rs` + `sensord/` (C#) — SMU/PawnIO sidecar (clean-room, **no GPL code in tree**).
- Frontend: `src/store/*` (zustand, persisted via `src/lib/persist.ts`), `src/lib/ipc.ts` (typed `api`), `src/hooks/usePerfRecorder.ts` (session persist + report).

## Perf-work constraint

Optimizations must be invisible: keep every feature and animation; only IPC dedupe, no-op-setState skips, lock-scope cuts, clone removal. Visible behavior stays byte-identical unless the user asked for the change.
