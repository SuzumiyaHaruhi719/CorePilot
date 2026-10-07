# Backend rework — targeted restructure + full bug/perf sweep

Date: 2026-10-06 · Branch: `SuzumiyaHaruhi719/backend-rework` (own worktree `ribbonworm-backend`)
Scope: `src-tauri/` only. The frontend (`src/`) is owned by a parallel redesign session; every
TS-facing contract change is sent to it as an exact diff before it lands (§6).

## 1. Why targeted, not a rewrite

A four-way read-only audit (core/IPC, game/overlay, hardware/system, IPC load map) produced ~80
distinct backend findings. Most trace to four seams where the *structure* generates bugs; the rest
are local. A rewrite would discard the field-hardened fixes the CLAUDE.md iron rules encode and
can't be re-verified without hardware. So: restructure the four seams, fix every confirmed finding
in severity waves, apply perf cuts that keep visible behavior byte-identical.

Decisions taken with the user:
- Approach A (targeted rework).
- In-game DLL injection is **fail-closed allowlist**; non-allowlisted games get the existing
  corner-OSD window.
- Defaults (flagged, not asked): a manual GPU fan reverts to driver auto on exit (same as
  motherboard fans); SMU writes are refused on CPUs other than Zen4/Zen5.

## 2. Restructures

### 2.1 `sidecar.rs` — single owner for sensord
Today spawn/reader/watchdog/interval live in `sensors.rs`, stdin + generation in `fan.rs`, SMU
piggybacks on `fan::send_command`, teardown handshakes in `updater.rs` and `taskbar_mon.rs`.

New `sidecar.rs` owns:
- **Child + writer thread.** `sidecar::send(line) -> bool` is a `try_send` into a bounded
  `sync_channel`; one writer thread does the pipe IO. No caller ever blocks on, or holds a lock
  across, a pipe write. Full channel → drop + rate-limited warn (the fan engine re-sends every
  2 s, so drops self-heal).
- **Reader.** Parses each line once to `serde_json::Value`, stamps `Instant`, dispatches
  `&Value` to `sensors::ingest`, `fan::ingest`, `smu::ingest`.
- **State machine** Starting → Live → Draining → Dead. Generation that lived < 10 s → exponential
  backoff 1.5 s … 5 min; reset after a healthy run. `SHUTTING_DOWN` gate: no respawn during
  teardown. WARN after 5 consecutive failed spawns.
- **`graceful_stop(timeout)`**: `autoall` → close stdin → wait → kill. The only stop path, used by
  watchdog, updater teardown, `WM_ENDSESSION`, app exit.
- **Watchdog** on monotonic ticks; two consecutive misses before acting (no wall-clock false kills
  on clock jumps / resume).
- **Dirty headers.** If a generation ends uncleanly while headers were driven, mark them dirty.
  Dirty headers' fail-safe is curve-max (or 100 %) instead of `auto` (which a fresh sidecar can't
  honor); `fan_info` exposes them so the UI can say "reboot restores BIOS fan control".
- `latest_readings()` returns age; auto-tune heartbeat rejects readings > 3 s old; desired
  sidecar interval respects `fan::exclusive_active()`; the emergency 100 % is held for a cool-down
  before config restore.
- spawn uses an absolute exe path; helper tools (`reg`, `sc`, `powercfg`, `powershell`, `netsh`)
  are spawned via `%SystemRoot%\System32\…` absolute paths (no exe-dir plant).

sensord (C#):
- Retry `OpenComputer` with backoff when it returns null or previously-seen motherboard controls
  vanish (instead of serving `NullLine` forever).
- SMU host: gate every write on CPUID family/model (Zen4/Zen5) + minimum SMU version; reply
  `ok=false, detail="unsupported"` otherwise. Lower bounds (PPT ≥ 45 W, TDC/EDC ≥ 30 A).
- Delete dead `SmuMailboxClient`/`ISmnAccess` and unused message IDs; add
  `THIRD_PARTY_NOTICES` (LibreHardwareMonitorLib MPL-2.0, PawnIO modules LGPL).

### 2.2 Overlay injection — backend-owned, fail-closed
Today a frontend 1.5 s poll drives attach/detach; detach `FreeLibrary`s from outside (crashes the
game — hudhook's hooks stay installed); there is no game gate (explorer, CorePilot itself qualify);
the anti-cheat gate fails open; no bitness check.

New:
- Frontend pushes flat config (iron rule 6): `overlay_config({ enabled, allow: string[],
  layoutFlags })` → Rust static. Exe names lowercase basenames.
- One backend thread (~1 Hz, mirrors `perf_recorder`) injects iff **all**: enabled ∧
  `fps::foreground_info_now().is_game` ∧ exe ∈ allow ∧ native 64-bit (`IsWow64Process2`) ∧ pid ≠
  own ∧ no anti-cheat (module names **and** running kernel-AC services/drivers: vgc/vgk, mhyprot*,
  EasyAntiCheat(_EOS), BEService, faceit, ESEADriver2, nProtect GameGuard) ∧ not already injected (key = pid + creation time).
- **Never unload from outside.** Detach = clear target / `enabled=0` in shared memory; the DLL goes
  inert. Shared block gains a versioned `eject_requested` flag; the DLL calls `hudhook::eject()`
  itself — used only by updater teardown (DLL file must be unlocked).
- Remote `LoadLibraryW` wait timeout → `mem::forget` the remote path buffer (no use-after-free).
- Delete dead AUTO mode (`overlay_set_auto`, `AUTO_MODE`). `overlay_attach`/`overlay_detach` leave
  the frontend surface; `overlay_status` stays read-only with a `notAllowlisted` reason.
- Classification: one module walk computing API + anti-cheat; cache prunes expired entries.

### 2.3 Sampler / telemetry / NVML
- Split the sampler into a fixed-cadence **metrics+sensors loop** and an on-demand **roster loop**.
  Each publishes `Snapshot<T> { gen: u64, at: Instant, data: Arc<T> }`.
- Cold roster callers wait until `gen` passes the generation current at their request (fixes the
  stale-roster/recycled-PID race and the double walk per enforcer request).
- Rows are built after releasing `state.sys`. Identity cache keyed by (pid, creation time) holds
  image path, name, user, platform, description, settable — always used (fixes recycled-PID name
  revert). Idle sweep drops signalled handles.
- Telemetry: VRAM PDH query kept open; per-instance string churn removed; per-process GPU
  breakdown computed only while process list / engine-load view is consumed; engine-total collect
  demand-gated with a two-sample prime on wake (first value after idle not averaged over the gap).
- NVML: static fields (name, driver, power-limit range, max clock, thresholds) cached per init,
  reset on re-init; snapshot shared via `Arc`; `gpu_oc_info` drops the needless blocking hop;
  `ACTIVE_SESSIONS` reset on the recorder's disabled branch.
- **Supervision:** every 24/7 loop (sampler loops, telemetry, ui-vis, persist writer, sidecar
  reader, recorder, overlay sampler) runs under `catch_unwind` + restart with backoff; snapshot age
  makes a frozen subsystem detectable.

### 2.4 `taskbar_mon/` split + shared pieces
- `taskbar_mon/{mod, config, readings, layout, render, dock, window}.rs`. `layout` is pure and
  unit-tested. RAII `MemDc` (re-selects the original bitmap before delete) + `Gdi<T>` make the
  "delete while selected" leak structurally impossible. Rebuild D2D target + brush after
  `D2DERR_RECREATE_TARGET`. Cache `IDWriteTextLayout` per cell (built in tick, reused in paint).
  Drop dead `field_template` / unused `FieldClass`.
- `metric_view::read()` — one "prefer NVML, fall back to sensors" mapping used by
  `perf_recorder::build_sample`, `overlay_inject::publish_metrics`, `taskbar_mon::Readings::read`.
- `fps`: ETW consumer becomes a supervisor (restart on external stop, backoff, gated by
  `SHUTTING_DOWN`); CLI uses its own session name. One shared fullscreen helper (rejects
  `WS_MAXIMIZE`/`WS_CAPTION`/`WS_THICKFRAME`) used by `fps` and the plate; `foreground_info_now`
  reads the foreground HWND once. Plate hides only when the fullscreen window is on its monitor.

Left alone except targeted fixes: `disk_scan*`, `fan_autotune/model.rs`, `persist.rs`, `osd.rs`,
`tweaks.rs`, `winsvc.rs`, `netfix.rs`.

## 3. Fix waves

Implementation plans are written per wave (Wave 0 first). Each wave ends green (`cargo check`, `cargo test --lib`, no new clippy warnings) and is one
revertable commit set. Wave 0 lands first because it's small and removes user harm now.

### Wave 0 — user harm / security stopgaps (no restructure)
| Fix | Where |
|---|---|
| Detach no longer `FreeLibrary`s from outside (shared-mem disable only) | `inject.rs:265`, `overlay_inject.rs:694` |
| Inject requires `is_game`, native bitness, pid ≠ own (allowlist arrives in Wave 2) | `overlay.rs:192`, `overlay_inject.rs:590` |
| `restart_task`/`end_task`: refuse `IsProcessCritical`; refuse image-relaunch of service hosts; relaunch with original command line | `commands.rs:297`, `process.rs:105` |
| Updater installer: teardown first, write verified bytes to admin-only dir (DACL SYSTEM/Admins), hold handle `FILE_SHARE_READ`, launch ourselves | `updater.rs:572,695` |
| `tweak_revert` accepts only entries in a static per-tweak descriptor table; type ∈ DWORD/SZ | `tweaks.rs:442,575` |
| `clean_temp` reparse-safe deletion (no follow of junctions) | `optimize.rs:166` |
| Taskbar plate back-buffer: deselect before delete (resize + `Drop`) | `taskbar_mon.rs:1656,797` |
| Rule 1: `tweak_apply`/`tweak_revert`/`create_restore_point`, `disk_scan_start`, `overlay_set_auto`, `smu_*`, `fan_set_config` → `async` + `run_blocking*` | `tweaks.rs`, `disk_scan.rs:1986`, `overlay_inject.rs:719`, `commands.rs:345`, `fan.rs:792` |
| Remote-thread timeout leaks (not frees) the remote buffer | `inject.rs:122,175` |

### Wave 1 — §2.1 sidecar (+ C# host fixes)
Covers: fan fail-safe after kill/crash, sidecar respawn storm, wall-clock watchdog, chip-reopen
no-recovery, SMU family gate + bounds + reply-await, stale readings in auto-tune, interval override
during exclusive tune, emergency-100 % overwrite, triple JSON parse, teardown respawn race,
GPL-resembling dead code + notices.

### Wave 2 — §2.2 injection owner
Covers: allowlist, kernel-AC refusal, attach race (double inject), classification double walk +
cache growth, dead AUTO mode. Needs frontend allowlist UI (§6).

### Wave 3 — §2.3 sampler/telemetry/NVML
Covers: stale-roster cold race, double walk, recycled-PID identity, roster stalls freezing metric
snapshots, GPU PDH always-on cost, VRAM query reopen, NVML static re-reads, `ACTIVE_SESSIONS` stuck,
unsupervised loops, zombie handle pinning, `get_overview` inline block.

### Wave 4 — §2.4 taskbar/metric_view/fps
Covers: ETW permanent death, CLI killing the app's session, maximized-window false game, double
foreground read, plate hide on other monitor, D2D target never rebuilt, per-paint layout creation.

### Wave 5 — remaining medium/low sweep
- **fan / GPU:** manual GPU fan → driver auto in teardown; `DEFAULT_TEMP_LIMIT` captured once per
  boot via persist; `GpuLoad::start` reports pipeline build failure; `load_gen` spawn failure
  restores affinity.
- **perf recorder:** sample series bounded (halve in place past 18 000 samples ≈ 1 h at 5 Hz; running aggregates keep summary
  exact); energy/duration skip gaps > 5× sample period (TS parity change sent to frontend); session
  liveness by held `SYNCHRONIZE` handle (PID reuse); probe skipped when disabled with no session;
  no per-tick list clones; `pid_alive` creation-time check.
- **OSD:** GDI guard checks the count actually dropped after a recycle, else exponential backoff +
  error naming the non-OSD leak; click-through re-assert via `run_on_main_thread`;
  `osd_set_bounds` skips the move when unchanged but **keeps** the topmost re-assert.
- **FPS:** `osd_fps_stats` cached against a per-PID frame counter; percentiles via
  `select_nth_unstable` (same values).
- **overlay DLL:** rows rebuilt only when `seq` changes; mapping-open retry throttled to 1 Hz.
- **game library:** single-flight rescan, stale list served meanwhile.
- **disk:** `disk_scan_close` removes `SCANS` entry; `top_items` bounded heap; MFT pass-2 frees
  side arrays + `mem::take` instead of clones; cancel checks in pass-2 loops; extension records
  skipped; fixed 512-byte fixup stride; walk fallback when runs don't cover `MftValidDataLength`;
  hardlink dedup opens with `FILE_READ_ATTRIBUTES` only and only on NTFS/ReFS; adaptive publish
  interval.
- **persist:** failed deferred write retries with backoff; debounce max-wait 2 s; serialize
  `&map` (no deep clone) outside the lock; backup generations (`.bak`, `.bak.1`) and skip refresh
  when size shrinks drastically; quarantine a corrupt `.bak`; `persist_get` returns `Err` on
  poisoned/failed init (frontend must refuse to hydrate — §6).
- **tweaks / services / net:** `restore_one` aggregates errors; multi-step tweaks roll back on Err;
  restore-point detects the 24 h rate limit and uses `%SystemDrive%`; plan duplication by GUID;
  service restart waits on stop with a real timeout; `RegEnumValueW` grows the buffer on
  `ERROR_MORE_DATA`; netfix uses `GetAdaptersAddresses` (no codepage / `(Preferred)` parsing),
  proxy diagnosis and repair target the same stack (WinINet).
- **startup items:** distinct `key` (file name) for Startup-folder entries (§6).
- **logging:** `LOG_BUFFER` is a ring; `list_processes` cold wait excluded from `warn_slow`;
  `crash.log` capped + identical-location panics rate-limited; raw `spawn_blocking` commands routed
  through the shared helpers.
- **process icons:** drop `SHGFI_USEFILEATTRIBUTES` (real embedded icon) + `CoInitializeEx` on the
  calling thread.
- **misc:** `update://progress` throttled (≥1 % or 100 ms); overlay sampler skips redundant idle
  writes.

## 4. Perf cuts (invisible) — summary
GPU PDH: persistent VRAM query + demand-gated per-process breakdown + string-churn removal ·
NVML static-field cache + `Arc` snapshot · single roster walk per cold request, rows built off-lock ·
recorder early-out when disabled · FPS stats cache + partial select · sidecar line parsed once ·
game-library single-flight · `cpuSensors` moved out of every `get_sensors` response (§6) · persist
no deep clone · taskbar layout cache · `osd_set_bounds` no-op move skip. No feature, animation,
cadence the user can perceive, or displayed value changes.

## 5. Error handling principles
- Hardware-control failure paths fail toward safety (fans up, not down; SMU refuse, not guess).
- No silent subsystem death: supervised loops, snapshot age, WARN on repeated failure.
- System-mutating commands report real outcomes (aggregate errors, SMU reply, restore-point rate
  limit) — never "成功" for a no-op.
- Untrusted input (frontend payloads) validated against static tables at the Rust boundary.

## 6. TS-facing contract changes (sent to the frontend session as diffs before landing)
1. `overlay_config({ enabled, allow, layoutFlags })` new; frontend stops calling
   `overlayAttach`/`overlayDetach`; `useOverlayInjection` becomes a config pusher + `overlay_status`
   reader; `OverlayStatus` reason gains `notAllowlisted`. Frontend adds the per-game allowlist UI.
2. `cpu_sensors()` new command; `get_sensors` drops `cpuSensors` (only `SmuTelemetry` reads it).
3. Startup items gain `key`; `set_startup_enabled` takes `key`.
4. `fan_info` gains `dirtyHeaders: string[]`.
5. `smu_apply_*` resolve with `{ ok, detail }` after the SMU reply; `smu_status` gains
   `supported: boolean, reason?: string`.
6. `disk_scan_close(scanId)` new — call on tab close.
7. `persist_get` can reject; frontend must not hydrate defaults over real data on rejection.
   Frontend also chains `setItem` per key (out-of-order write race, `persist.ts`).
8. Perf session energy/duration gap rule mirrored in TS `energyWh`.
Sync→async command changes are TS-invisible (`invoke` is already a Promise).

## 7. Verification
- Per wave: `cargo check` + `cargo test --lib` in `src-tauri/`, `cargo clippy` with no new warnings,
  `dotnet build` for sensord changes, `npx tsc --noEmit` once frontend applies contract diffs.
  Never bare `cargo build` (CLAUDE.md); `npx tauri build` only with the app closed, on request.
- New unit tests (pure logic, no hardware): sidecar state machine + backoff (injected clock),
  snapshot-generation cold handshake, taskbar layout, FPS stats cache parity vs full sort, recorder
  downsample summary exactness, energy gap rule, tweak descriptor validation, startup key mapping,
  adapter parsing, SMU bounds, MemDc deselect ordering (drop order assertion).
- Manual hardware checklist for the user (can't be automated here): kill sensord mid-curve →
  dirty-header fail-safe + reboot notice; SMU apply on the 9950X3D shows real reply; allowlisted
  game inject + alt-tab survives; non-allowlisted game gets corner OSD; taskbar plate GDI count flat
  over 1 h (Task Manager GDI column); updater end-to-end from a test release; startup-folder toggle
  sticks.

## 8. Out of scope
Frontend redesign and frontend-only bugs (owned by the parallel session; 9 bugs forwarded).
`fan_autotune/model.rs` restructure. Demand-gating the *whole* sensors loop (would change
first-sample values after idle; not invisible).
