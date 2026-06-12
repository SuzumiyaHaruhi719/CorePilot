//! In-game overlay **injector + metrics sampler + SAFE hybrid decision**.
//!
//! This is the glue that turns CorePilot's overlay pieces into a working
//! MSI-Afterburner/RTSS-style in-frame OSD, while never risking a ban:
//!
//! * [`OsdShared`] (the writer mapping) is created **once at startup** and kept
//!   alive for the whole app lifetime ([`start_sampler`]). The injected DLL opens
//!   the same named block; if our mapping were ever dropped the block would be
//!   torn down underneath the game and the overlay would go blank. So a single
//!   long-lived writer is mandatory — never per-attach.
//! * A background thread (~3 Hz) samples every metric *only while a target is
//!   attached* and publishes it under the seqlock with `enabled = 1`. When nothing
//!   is attached it writes `enabled = 0` and idles, so the DLL (if still resident
//!   in some process) draws nothing.
//! * [`overlay_attach`] runs the **hybrid decision**: classify the target, and
//!   inject `corepilot_overlay.dll` only when it is hookable AND anti-cheat-free.
//!   Anything guarded by anti-cheat (or an unsupported API) falls back to the
//!   keep-alive WebView2 window overlay — we NEVER inject there. The anti-cheat
//!   check is re-run immediately before the actual injection as a hard gate.
//!
//! Injection uses our own [`crate::inject`] (CreateRemoteThread + LoadLibraryW) —
//! the published `dll-syringe` crate cannot build on this project's stable
//! toolchain (it needs nightly `MaybeUninit` APIs / crate-root `#![feature]`), so
//! we implement the exact mechanism it wraps directly on the `windows` crate.
//! Attach is **idempotent**: the frontend polls and re-issues attach for the same
//! foreground PID, so we track which PID currently has the DLL injected and only
//! `LoadLibraryW` when that PID changes — a repeat attach for the resident PID
//! just refreshes the layout flags through the shared block (no re-injection, so
//! the module never accumulates). Detach re-finds the module by file name, ejects
//! it, and clears that tracking so a later attach to the same PID injects again.
//! The state shared with the sampler — the sampler target PID, the injected PID,
//! and the layout flags — lives behind a small mutex (flags in an atomic).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use corepilot_osd_ipc::{anchor, row, show, OsdShared};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::overlay::{classify_target, is_anticheat_protected, GraphicsApi, OverlayTarget};
use crate::state::AppState;

/// File name of the injectable overlay DLL (built by `cargo build -p
/// corepilot-overlay --release`). Resolved next to the running executable, with
/// the Tauri resource dir as a fallback (see [`resolve_overlay_dll`]).
const OVERLAY_DLL: &str = "corepilot_overlay.dll";

/// Sampler tick period (~3 Hz). Fast enough to feel live in-game, slow enough to
/// stay cheap (PDH/NVML/sidecar reads are not free). Mirrors the cadence the
/// existing window-overlay React poll uses (~1 Hz) but a touch quicker since the
/// in-frame overlay is the "real" gaming HUD.
const SAMPLE_PERIOD: Duration = Duration::from_millis(333);

/// Default metric rows shown by the injected overlay until/unless the frontend
/// sets a specific layout. "Show everything" — the sampler writes the
/// unavailable sentinel (NaN / `u32::MAX`) for metrics this machine can't read,
/// and the DLL renders `—` for those, so an all-on default degrades cleanly.
const DEFAULT_LAYOUT_FLAGS: u32 =
    show::FPS | show::FRAMETIME | show::CPU | show::GPU | show::VRAM | show::RAM | show::DISK | show::NET;

/// Shared writer + attach state. The `OsdShared` writer mapping lives here for the
/// whole app lifetime (created in [`start_sampler`]); `target_pid` is the PID the
/// sampler currently publishes for (None = idle, write `enabled = 0`).
struct OverlayState {
    /// The single, long-lived writer mapping. `None` only if creating the mapping
    /// failed at startup (then the sampler degrades to a no-op).
    writer: Option<OsdShared>,
    /// PID the **sampler** currently publishes metrics for (None = idle, write
    /// `enabled = 0`). Cleared when the game exits so we stop sampling a dead PID.
    target_pid: Option<u32>,
    /// PID that currently has `corepilot_overlay.dll` **injected**, if any.
    ///
    /// This is deliberately separate from `target_pid`: `target_pid` answers "what
    /// should the sampler publish?" while `injected_pid` answers "is the DLL
    /// already resident here?". Tracking it makes [`overlay_attach`] idempotent —
    /// the frontend polls and re-issues attach for the *same* PID, and without this
    /// we would `LoadLibraryW` on every poll, leaking/accumulating the module. We
    /// only run the real injection when the target PID is not already this value,
    /// and [`overlay_detach`] clears it after the eject so a later re-attach works.
    injected_pid: Option<u32>,
}

// SAFETY: `OsdShared` holds a raw pointer (so it is `!Send`/`!Sync` by default),
// but the mapping it points at is a process-wide, page-aligned shared section that
// is valid for the whole app lifetime, and every access goes through the
// `Mutex<OverlayState>` below — so exactly one thread touches it at a time. That
// makes moving it onto the sampler thread and sharing it via the mutex sound.
unsafe impl Send for OverlayState {}

static STATE: Lazy<Mutex<OverlayState>> = Lazy::new(|| {
    Mutex::new(OverlayState {
        writer: None,
        target_pid: None,
        injected_pid: None,
    })
});

/// Layout flags the sampler stamps into the block (which metric rows to draw).
/// An atomic so the frontend can retarget the layout without taking the state
/// lock. Defaults to the all-on set; [`overlay_attach`] updates it from the
/// caller-supplied flags (derived from the user's OSD metric selection).
static LAYOUT_FLAGS: AtomicU32 = AtomicU32::new(DEFAULT_LAYOUT_FLAGS);

/// Per-row OSD colors (packed 0xRRGGBBAA, indexed by the IPC `row` order) the
/// sampler stamps into the block so the injected overlay paints each row in the
/// active theme's color. All-zero until the frontend pushes a palette via
/// [`overlay_set_palette`]; a zero slot falls back to the flat color in the DLL.
static ROW_COLORS: Mutex<[u32; row::COUNT]> = Mutex::new([0; row::COUNT]);

/// Ensures the sampler thread is spawned at most once.
static SAMPLER_STARTED: AtomicBool = AtomicBool::new(false);

/// AUTO mode: the sampler itself detects the foreground injectable game, injects
/// `corepilot_overlay.dll` ONCE (resident), and gates OSD visibility by foreground
/// — shown only while the game is the active window, hidden (NOT ejected) on
/// alt-tab so it reappears instantly, ejected only when the game exits or auto mode
/// is switched off. Toggled by [`overlay_set_auto`]. (Distinct from the manual
/// `inject` path driven by the frontend, which ejects on every foreground change.)
static AUTO_MODE: AtomicBool = AtomicBool::new(false);
/// Last foreground PID seen by [`auto_tick`], so the heavy `classify_target` only
/// runs when the foreground actually changes (the cheap PID read runs every tick).
static AUTO_LAST_FG: AtomicU32 = AtomicU32::new(0);

/// Bytes-per-MB (binary). VRAM/RAM cross the shared block as `u32` megabytes.
const BYTES_PER_MB: u64 = 1024 * 1024;

/// What the overlay is doing for a given target, surfaced to the UI so it can
/// explain *why* (e.g. anti-cheat → window fallback).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlayMode {
    /// The in-frame DLL overlay is (or would be) injected — the premium path.
    Inject,
    /// Falling back to the keep-alive WebView2 window overlay (anti-cheat or an
    /// API the DLL can't hook). Safe — never injects.
    Window,
    /// No usable target (no foreground game / PID 0 / nothing detected).
    None,
}

/// Status of the overlay for one target: the classification, the chosen mode, and
/// a human-readable (Chinese) reason for the UI status line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStatus {
    pub target: OverlayTarget,
    pub mode: OverlayMode,
    /// Localised explanation, e.g. "检测到反作弊，已自动改用窗口叠加（避免封号）".
    pub reason: String,
    /// Whether the injected overlay is currently attached to this exact PID.
    pub attached: bool,
}

/// u64 bytes → u32 MB, saturating. `u32::MAX` is the block's "unavailable"
/// sentinel, so a real value is capped one below it to avoid colliding with it.
fn bytes_to_mb(bytes: u64) -> u32 {
    let mb = bytes / BYTES_PER_MB;
    mb.min((u32::MAX - 1) as u64) as u32
}

/// Map an `Option<f32>`/`f64` metric to the block's `f32`-with-NaN convention.
fn opt_f32(v: Option<f32>) -> f32 {
    v.unwrap_or(f32::NAN)
}
fn opt_f64_as_f32(v: Option<f64>) -> f32 {
    v.map(|x| x as f32).unwrap_or(f32::NAN)
}

/// Sample every metric for `pid` and publish it into the shared block under the
/// seqlock with `enabled = 1`. The metric→field mapping mirrors the frontend
/// `src/lib/osd.ts` (`OSD_METRICS` / `fetchOsdData`) one-for-one so the in-frame
/// overlay and the window overlay always agree on sources and fallbacks.
fn publish_metrics(writer: &OsdShared, app: &AppHandle, pid: u32, flags: u32, row_colors: [u32; row::COUNT]) {
    // --- system CPU + memory (shared `System` in AppState) ---
    let metrics = {
        let state = app.state::<AppState>();
        let mut sys = state.sys.lock();
        crate::sysmon::sample(&mut sys)
    };
    // --- telemetry sidecar + PDH (temps/power/clock/disk/net/vram fallback) ---
    let sensors = crate::sensors::sample();
    // --- NVML GPU snapshot (preferred for GPU util/temp/power/clocks/VRAM) ---
    let gpu = crate::gpu::gpu_oc_info_snapshot();
    // --- frame pacing for THIS pid (not the foreground) ---
    let fps = crate::fps::stats_for_pid(pid);

    // GPU util / temp / power: prefer NVML (gpu tab), fall back to the PDH/sidecar
    // aggregate — identical precedence to `osd.ts`.
    let gpu_load = if gpu.available {
        Some(gpu.utilization_gpu as f32)
    } else {
        sensors.gpu_pct
    };
    let gpu_temp = if gpu.available {
        Some(gpu.temperature as f32)
    } else {
        sensors.gpu_temp
    };
    let gpu_power = if gpu.available {
        Some(gpu.power_usage_w as f32)
    } else {
        sensors.gpu_power
    };
    // Clocks/fan only come from NVML; 0 from NVML means "unknown" → sentinel.
    let nonzero = |v: u32| (v != 0).then_some(v as f32);
    let gpu_clock = if gpu.available { nonzero(gpu.graphics_clock) } else { None };
    let gpu_mem_clock = if gpu.available { nonzero(gpu.mem_clock) } else { None };
    let gpu_fan = if gpu.available { Some(gpu.fan_speed_pct as f32) } else { None };

    // VRAM: prefer NVML used/total, else the PDH/DXGI sidecar values.
    let (vram_used_mb, vram_total_mb) = if gpu.available && gpu.mem_total_bytes > 0 {
        (bytes_to_mb(gpu.mem_used_bytes), bytes_to_mb(gpu.mem_total_bytes))
    } else if let (Some(used), Some(total)) = (sensors.vram_used, sensors.vram_total) {
        (bytes_to_mb(used), bytes_to_mb(total))
    } else {
        (u32::MAX, u32::MAX)
    };

    // RAM from the system sample (bytes → MB).
    let (ram_used_mb, ram_total_mb) = if metrics.mem_total > 0 {
        (bytes_to_mb(metrics.mem_used), bytes_to_mb(metrics.mem_total))
    } else {
        (u32::MAX, u32::MAX)
    };

    writer.write(|b| {
        b.enabled = 1;
        b.target_pid = pid;
        b.layout_flags = flags;
        b.row_colors_rgba = row_colors;
        b.anchor = anchor::TOP_LEFT;
        // Placement/scale/colour keep the block defaults (top-left, scale 1,
        // white). The DLL renders relative to the back buffer; fine-grained
        // placement of the in-frame overlay is future work — the window overlay
        // owns user placement today.

        // FPS / frame pacing.
        b.fps = opt_f64_as_f32(fps.fps);
        b.frametime_ms = opt_f64_as_f32(fps.frametime_ms);
        b.low1_fps = opt_f64_as_f32(fps.low1);
        b.low01_fps = opt_f64_as_f32(fps.low01);

        // CPU.
        b.cpu_load = metrics.cpu_overall;
        b.cpu_temp = opt_f32(sensors.cpu_temp);
        b.cpu_clock_mhz = opt_f64_as_f32(sensors.cpu_clock);
        b.cpu_power_w = opt_f32(sensors.cpu_power);

        // GPU.
        b.gpu_load = opt_f32(gpu_load);
        b.gpu_temp = opt_f32(gpu_temp);
        b.gpu_clock_mhz = opt_f32(gpu_clock);
        b.gpu_power_w = opt_f32(gpu_power);
        b.gpu_mem_clock_mhz = opt_f32(gpu_mem_clock);
        b.gpu_fan_pct = opt_f32(gpu_fan);

        // VRAM / RAM (megabytes).
        b.vram_used_mb = vram_used_mb;
        b.vram_total_mb = vram_total_mb;
        b.ram_used_mb = ram_used_mb;
        b.ram_total_mb = ram_total_mb;

        // Disk / network.
        b.disk_pct = opt_f32(sensors.disk_pct);
        b.net_down_bps = sensors.net_down.map(|v| v as f32).unwrap_or(f32::NAN);
        b.net_up_bps = sensors.net_up.map(|v| v as f32).unwrap_or(f32::NAN);
    });
}

/// Start the long-lived sampler thread + create the writer mapping. Idempotent —
/// safe to call once from `lib.rs` `setup`. The `OsdShared` writer is created on
/// the sampler thread and stored in [`STATE`] so the mapping outlives every
/// attach/detach for the whole app lifetime.
pub fn start_sampler(app: AppHandle) {
    if SAMPLER_STARTED.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    std::thread::Builder::new()
        .name("corepilot-osd-sampler".into())
        .spawn(move || {
            // Create the single writer mapping and keep it for the app lifetime.
            match OsdShared::create() {
                Ok(writer) => {
                    STATE.lock().writer = Some(writer);
                    tracing::info!("OSD shared-memory writer created");
                }
                Err(e) => {
                    // Without the mapping the injected overlay can't read metrics,
                    // but the rest of the app (and the window fallback) is fine.
                    tracing::error!("failed to create OSD shared mapping: {e:?}");
                    return;
                }
            }

            loop {
                // AUTO mode drives its own target/injection from the foreground.
                if AUTO_MODE.load(Ordering::Relaxed) {
                    auto_tick(&app);
                }

                // Snapshot the current target while holding the lock briefly; do
                // the (slower) sampling outside the lock so attach/detach/status
                // never block on a metric read.
                let target = STATE.lock().target_pid;
                let flags = LAYOUT_FLAGS.load(Ordering::Relaxed);

                match target {
                    Some(pid) if pid != 0 => {
                        // If the game exited, stop drawing and clear the target so
                        // we don't keep sampling a dead PID forever. Also clear any
                        // injected-PID tracking for it: the process (and its resident
                        // DLL) is gone, so a future attach to a recycled PID must be
                        // free to inject again rather than be treated as idempotent.
                        if !crate::fps::pid_alive(pid) {
                            clear_target_if(pid);
                            write_disabled();
                        } else if AUTO_MODE.load(Ordering::Relaxed)
                            && crate::fps::foreground_pid_public() != pid
                        {
                            // AUTO mode: the DLL stays resident, but the game isn't
                            // the active window — hide the OSD (don't eject) so it
                            // reappears instantly when the user alt-tabs back.
                            write_disabled();
                        } else if let Some(writer) = STATE.lock().writer.as_ref() {
                            // Re-borrow the writer for the publish. The lock is
                            // held only for the duration of the seqlock write.
                            // Read the palette WHILE holding STATE so it can't
                            // interleave with overlay_set_palette's update+publish —
                            // the sampler can't clobber a just-pushed palette with a
                            // stale snapshot ("reflect immediately" stays true). No
                            // deadlock: overlay_set_palette never holds ROW_COLORS
                            // while awaiting STATE.
                            let row_colors = *ROW_COLORS.lock();
                            publish_metrics(writer, &app, pid, flags, row_colors);
                        }
                    }
                    _ => write_disabled(),
                }

                std::thread::sleep(SAMPLE_PERIOD);
            }
        })
        .ok();
}

/// Publish `enabled = 0` (overlay hides) without touching the metric fields.
fn write_disabled() {
    if let Some(writer) = STATE.lock().writer.as_ref() {
        writer.write(|b| b.enabled = 0);
    }
}

/// Stamp the current [`LAYOUT_FLAGS`] into the shared block without touching the
/// metric fields. The lightweight path used when [`overlay_attach`] is called for
/// an already-injected PID purely to change which metric rows are drawn: the new
/// flags take effect immediately for the resident overlay instead of waiting for
/// the next sampler tick, and crucially without re-running injection.
fn push_layout_flags() {
    let flags = LAYOUT_FLAGS.load(Ordering::Relaxed);
    if let Some(writer) = STATE.lock().writer.as_ref() {
        writer.write(|b| b.layout_flags = flags);
    }
}

/// Clear the sampler target iff it still equals `pid` (avoids racing a fresh
/// attach that happened while we were sampling the old one). Also clears the
/// injected-PID tracking when it matches: this is called when the target PID's
/// process has exited, so the resident DLL is gone with it and a later attach to
/// the same (recycled) PID must inject again rather than be skipped as idempotent.
fn clear_target_if(pid: u32) {
    let mut st = STATE.lock();
    if st.target_pid == Some(pid) {
        st.target_pid = None;
    }
    if st.injected_pid == Some(pid) {
        st.injected_pid = None;
    }
}

/// AUTO-mode tick: keep the overlay DLL resident in the foreground injectable
/// game. Only (re)classifies when the foreground PID changes — the per-tick
/// visibility gating (show only while the game is foreground) is handled in the
/// sampler loop with the cheap `foreground_pid_public` read.
fn auto_tick(app: &AppHandle) {
    let fg = crate::fps::foreground_pid_public();
    let last = AUTO_LAST_FG.swap(fg, Ordering::Relaxed);
    if fg == last || fg == 0 {
        return; // foreground unchanged (gate handles show/hide) or no foreground
    }
    let target = classify_target(fg);
    if target.pid == 0 || !target.injectable {
        // Desktop / non-game / anti-cheat / unsupported API: leave any resident
        // inject as-is — the gate hides the OSD because it isn't the foreground.
        return;
    }
    if STATE.lock().injected_pid == Some(fg) {
        STATE.lock().target_pid = Some(fg); // already resident in this game
        return;
    }
    // A new/different injectable game is in front — switch to it.
    let previous = STATE.lock().injected_pid;
    if let Some(old) = previous {
        let _ = eject_dll(old);
        let mut st = STATE.lock();
        st.injected_pid = None;
        if st.target_pid == Some(old) {
            st.target_pid = None;
        }
    }
    // `inject_dll` re-checks anti-cheat immediately before injecting (hard gate).
    if inject_dll(app, fg).is_ok() {
        let mut st = STATE.lock();
        st.injected_pid = Some(fg);
        st.target_pid = Some(fg);
    }
}

/// Resolve the absolute path to `corepilot_overlay.dll`.
///
/// Primary: next to the running executable. In `tauri dev` that's
/// `target/release/` (which holds both `corepilot.exe` and, once
/// `cargo build -p corepilot-overlay --release` has run, the DLL); in a bundled
/// install it's the app's install dir, where the DLL ships as a bundled resource.
/// Fallback: the Tauri resource dir (`resolve_resource`), where the bundler
/// places `resources` entries.
fn resolve_overlay_dll(app: &AppHandle) -> Result<PathBuf, String> {
    // 1) Next to the current executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(OVERLAY_DLL);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    // 2) Tauri resource dir (bundled `resources`).
    if let Ok(res_dir) = app.path().resource_dir() {
        let candidate = res_dir.join(OVERLAY_DLL);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "{OVERLAY_DLL} 未找到（请先运行 `cargo build -p corepilot-overlay --release`）"
    ))
}

/// Localised reason string for a classification + mode.
fn reason_for(target: &OverlayTarget, mode: OverlayMode) -> String {
    match mode {
        OverlayMode::Inject => format!("✅ 可注入（{}）", api_label(target.api)),
        OverlayMode::Window if target.anticheat => {
            "⚠️ 检测到反作弊，已自动改用窗口叠加（避免封号）".to_string()
        }
        OverlayMode::Window => match target.api {
            GraphicsApi::Vulkan => "⚠️ Vulkan 暂不支持注入，已改用窗口叠加".to_string(),
            GraphicsApi::Unknown => "⚠️ 未检测到受支持的图形 API，已改用窗口叠加".to_string(),
            _ => "⚠️ 不支持的图形 API，已改用窗口叠加".to_string(),
        },
        OverlayMode::None => "未检测到前台游戏".to_string(),
    }
}

/// Short human label for a graphics API (for the status line).
fn api_label(api: GraphicsApi) -> &'static str {
    match api {
        GraphicsApi::Dx12 => "DX12",
        GraphicsApi::Dx11 => "DX11",
        GraphicsApi::Dx10 => "DX10",
        GraphicsApi::Dx9 => "DX9",
        GraphicsApi::Vulkan => "Vulkan",
        GraphicsApi::OpenGl => "OpenGL",
        GraphicsApi::Unknown => "未知",
    }
}

/// Decide the overlay mode for an already-classified target (no side effects).
fn mode_for(target: &OverlayTarget) -> OverlayMode {
    if target.pid == 0 {
        OverlayMode::None
    } else if target.injectable {
        OverlayMode::Inject
    } else {
        // Anti-cheat OR unsupported API → safe window fallback.
        OverlayMode::Window
    }
}

/// Inject `corepilot_overlay.dll` into `pid`. Caller has already classified the
/// target as injectable; this performs the **final anti-cheat re-check** (the
/// whole point — a game can load its anti-cheat between classification and here)
/// and then the actual injection.
fn inject_dll(app: &AppHandle, pid: u32) -> Result<(), String> {
    // HARD GATE: never inject into an anti-cheat-protected process. Re-checked
    // immediately before injection so a TOCTOU window can't slip a protected
    // game past the earlier `classify_target` call.
    if is_anticheat_protected(pid) {
        return Err("检测到反作弊保护，已拒绝注入（避免封号）".to_string());
    }

    let dll = resolve_overlay_dll(app)?;
    crate::inject::inject(pid, &dll)
}

/// Eject the overlay DLL from `pid` (best-effort): find the loaded module by file
/// name and `FreeLibrary` it. Missing module / dead process is treated as
/// "already gone" — not an error.
fn eject_dll(pid: u32) -> Result<(), String> {
    crate::inject::eject(pid, OVERLAY_DLL)
}

/// **Hybrid attach.** Classify `pid`; if injectable, inject the in-frame DLL and
/// start the sampler writing for it. If anti-cheat-protected OR an unsupported
/// API, DO NOT inject — show the keep-alive window overlay instead and return a
/// status explaining why.
#[tauri::command]
pub fn overlay_attach(app: AppHandle, pid: u32, layout_flags: Option<u32>) -> Result<OverlayStatus, String> {
    let target = classify_target(pid);
    let mode = mode_for(&target);

    // Apply the caller's layout selection (which metric rows to draw) if given.
    if let Some(flags) = layout_flags {
        LAYOUT_FLAGS.store(flags, Ordering::Relaxed);
    }

    match mode {
        OverlayMode::Inject => {
            // IDEMPOTENCY: the frontend polls the foreground app and re-issues
            // attach for the *same* PID to keep the layout current. Injecting on
            // every such call would `LoadLibraryW` repeatedly and leave the module
            // accumulating/resident. So inject only when this PID isn't already the
            // injected one; otherwise this is a cheap "update layout flags" path —
            // we push the new flags through the existing shared block (which the
            // overlay reads) and the sampler keeps publishing, no re-injection.
            let already_injected = STATE.lock().injected_pid == Some(pid);
            if !already_injected {
                inject_dll(&app, pid)?;
                // Record the resident PID so subsequent attaches for it are no-ops.
                STATE.lock().injected_pid = Some(pid);
            } else {
                // Flags-only update: stamp the latest layout into the shared block
                // now so it takes effect without waiting for the next sampler tick.
                push_layout_flags();
            }
            // Sampler (re)publishes for this PID on its next tick either way.
            STATE.lock().target_pid = Some(pid);
            Ok(OverlayStatus {
                // Distinct from the probe's "可注入": the DLL is now injected and
                // drawing in the game's own frame (so it follows the game window).
                reason: format!("✅ 已注入（{}）", api_label(target.api)),
                target,
                mode,
                attached: true,
            })
        }
        OverlayMode::Window => {
            // Anti-cheat or unsupported API: the window overlay is the safe path.
            let _ = crate::osd::osd_set_visible(app.clone(), true);
            Ok(OverlayStatus {
                reason: reason_for(&target, mode),
                target,
                mode,
                attached: false,
            })
        }
        OverlayMode::None => Ok(OverlayStatus {
            reason: reason_for(&target, mode),
            target,
            mode,
            attached: false,
        }),
    }
}

/// Detach the injected overlay from `pid`: eject the DLL and clear the target so
/// the sampler stops writing (sets `enabled = 0`). Idempotent.
#[tauri::command]
pub fn overlay_detach(_app: AppHandle, pid: u32) -> Result<(), String> {
    // Clear the sampler target first so it immediately stops publishing for it.
    clear_target_if(pid);
    write_disabled();
    let result = eject_dll(pid);
    // Clear the injected-PID tracking for this PID regardless of the eject result.
    // On success the module is gone; if the eject failed (e.g. the process already
    // exited, or FreeLibrary errored) we still must not leave this PID marked as
    // injected forever — otherwise a later attach would be wrongly skipped as
    // idempotent and never re-inject. Clearing here lets re-attach retry cleanly.
    {
        let mut st = STATE.lock();
        if st.injected_pid == Some(pid) {
            st.injected_pid = None;
        }
    }
    result
}

/// Toggle AUTO injection mode. When `enable` is true the sampler auto-injects the
/// foreground injectable game (resident) and shows the OSD only while that game is
/// the active window — hidden (not ejected) on alt-tab, ejected on game exit or
/// when this is turned off. `layout_flags` sets which metric rows to draw. This is
/// the "follow the game" mode, distinct from the manual `overlay_attach` path.
#[tauri::command]
pub fn overlay_set_auto(_app: AppHandle, enable: bool, layout_flags: Option<u32>) {
    if let Some(f) = layout_flags {
        LAYOUT_FLAGS.store(f, Ordering::Relaxed);
        push_layout_flags();
    }
    let was = AUTO_MODE.swap(enable, Ordering::SeqCst);
    if enable {
        AUTO_LAST_FG.store(0, Ordering::Relaxed); // force a re-detect next tick
    } else if was {
        // Turning off: eject the resident DLL and stop publishing.
        let injected = STATE.lock().injected_pid;
        if let Some(pid) = injected {
            let _ = eject_dll(pid);
        }
        {
            let mut st = STATE.lock();
            st.injected_pid = None;
            st.target_pid = None;
        }
        write_disabled();
        AUTO_LAST_FG.store(0, Ordering::Relaxed);
    }
}

/// Push the per-theme OSD row-color palette (packed 0xRRGGBBAA, indexed by the IPC
/// `row` order: FPS, FRAMETIME, CPU, GPU, VRAM, RAM, DISK, NET). The sampler stamps
/// these into every subsequent block write, and we reflect them on the resident
/// overlay immediately so a theme switch recolors the in-game OSD without waiting
/// for the next tick. A zero slot makes the DLL fall back to the flat text color.
#[tauri::command]
pub fn overlay_set_palette(row_colors: Vec<u32>) -> Result<(), String> {
    if row_colors.len() != row::COUNT {
        return Err(format!(
            "overlay_set_palette: expected {} colors, got {}",
            row::COUNT,
            row_colors.len()
        ));
    }
    let mut arr = [0u32; row::COUNT];
    arr.copy_from_slice(&row_colors);
    *ROW_COLORS.lock() = arr;
    // Reflect immediately on the resident overlay (no-op when the writer mapping is
    // absent). Holds STATE.lock() across the seqlock write, like push_layout_flags.
    if let Some(writer) = STATE.lock().writer.as_ref() {
        writer.write(|b| b.row_colors_rgba = arr);
    }
    Ok(())
}

/// Report the overlay status for a specific `pid`, or — when `pid` is `None` — for
/// the current foreground app (via [`crate::fps::foreground_pid_public`]). Lets the
/// UI explain what's happening ("injectable (DX12)" / "anti-cheat → window" / …).
#[tauri::command]
pub fn overlay_status(pid: Option<u32>) -> OverlayStatus {
    let resolved_pid = match pid {
        Some(p) => p,
        None => crate::fps::foreground_pid_public(),
    };
    let target = classify_target(resolved_pid);
    let mode = mode_for(&target);
    let attached = STATE.lock().target_pid == Some(resolved_pid) && resolved_pid != 0;
    OverlayStatus {
        reason: reason_for(&target, mode),
        target,
        mode,
        attached,
    }
}
