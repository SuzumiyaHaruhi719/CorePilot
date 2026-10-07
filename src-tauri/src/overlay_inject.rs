//! In-game overlay **injector + metrics sampler + SAFE injection decision**.
//!
//! The in-frame OSD (MSI-Afterburner/RTSS-style) without ever risking a ban:
//!
//! * [`OsdShared`] (the writer mapping) is created **once at startup** and kept
//!   alive for the whole app lifetime ([`start_sampler`]). The injected DLL opens
//!   the same named block; if our mapping were ever dropped the block would be
//!   torn down underneath the game and the overlay would go blank.
//! * One background thread (~3 Hz) publishes metrics for the target under the
//!   seqlock, and (~1 Hz) owns the **injection decision**. It used to live in a
//!   webview poll — which freezes whenever a GPU-heavy game holds the foreground
//!   (the same freeze that moved the perf recorder into Rust) and raced itself
//!   into double injections. Now the frontend only pushes a flat config
//!   ([`overlay_config`]: on/off, allowlist, layout) and this thread injects iff
//!   the foreground app is a detected game, its exe is ALLOWLISTED by the user,
//!   it is native 64-bit, and no anti-cheat is present (module scan + running
//!   kernel anti-cheat services). Everything else gets the window overlay. The
//!   anti-cheat check is repeated immediately before `LoadLibraryW`.
//! * Injection is never undone from outside: an external `FreeLibrary` left
//!   hudhook's Present hooks and window subclass pointing into unmapped memory,
//!   crashing the game on its next frame. Retargeting is enough — the resident
//!   DLL draws nothing unless the block names its own PID — and it unloads with
//!   the game.
//!
//! Injection uses our own [`crate::inject`] (CreateRemoteThread + LoadLibraryW) —
//! the published `dll-syringe` crate cannot build on this project's stable
//! toolchain (it needs nightly `MaybeUninit` APIs / crate-root `#![feature]`).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use corepilot_osd_ipc::{anchor, row, show, OsdShared};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::overlay::{classify_target, is_anticheat_protected, GraphicsApi, OverlayTarget};

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
const DEFAULT_LAYOUT_FLAGS: u32 = show::FPS
    | show::FRAMETIME
    | show::CPU
    | show::GPU
    | show::VRAM
    | show::RAM
    | show::DISK
    | show::NET;

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
    /// Exe of `target_pid`, so an allowlist edit can drop a target that is no
    /// longer allowed.
    target_exe: Option<String>,
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
        target_exe: None,
    })
});

/// What the frontend pushed via [`overlay_config`].
struct OverlayConfig {
    enabled: bool,
    /// Lowercased exe file names the user allowed injection into.
    allow: HashSet<String>,
}

static CONFIG: Lazy<Mutex<OverlayConfig>> = Lazy::new(|| {
    Mutex::new(OverlayConfig {
        enabled: false,
        allow: HashSet::new(),
    })
});

/// Allowlist bounds (it arrives over IPC).
const MAX_ALLOW: usize = 256;
const MAX_EXE_LEN: usize = 260;

/// After a failed injection, leave that PID alone this long (no retry storm).
const INJECT_RETRY_AFTER: Duration = Duration::from_secs(30);
/// Decide every Nth sampler tick (~1 Hz at the 333 ms tick).
const DECIDE_EVERY: u32 = 3;

/// Layout flags the sampler stamps into the block (which metric rows to draw).
/// An atomic so the frontend can retarget the layout without taking the state
/// lock. Defaults to the all-on set; [`overlay_config`] updates it from the
/// user's OSD metric selection.
static LAYOUT_FLAGS: AtomicU32 = AtomicU32::new(DEFAULT_LAYOUT_FLAGS);

/// Per-row OSD colors (packed 0xRRGGBBAA, indexed by the IPC `row` order) the
/// sampler stamps into the block so the injected overlay paints each row in the
/// active theme's color. All-zero until the frontend pushes a palette via
/// [`overlay_set_palette`]; a zero slot falls back to the flat color in the DLL.
static ROW_COLORS: Mutex<[u32; row::COUNT]> = Mutex::new([0; row::COUNT]);

/// Ensures the sampler thread is spawned at most once.
static SAMPLER_STARTED: AtomicBool = AtomicBool::new(false);

/// Set once any injection succeeds this session. The resident DLL then stays
/// mapped in that game until it exits, so the updater has to move the file
/// aside before the installer overwrites it ([`dll_maybe_mapped`]).
static INJECTED_EVER: AtomicBool = AtomicBool::new(false);

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
    pub reason_zh: String,
    pub reason_en: String,
    /// Whether the injected overlay is currently attached to this exact PID.
    pub attached: bool,
}

impl Default for OverlayStatus {
    fn default() -> Self {
        let target = OverlayTarget {
            pid: 0,
            api: GraphicsApi::Unknown,
            anticheat: false,
            blocked_by: None,
            game: false,
            exe: None,
            allowed: false,
            native: false,
            injectable: false,
        };
        Self {
            target,
            mode: OverlayMode::None,
            reason: "未检测到前台游戏".into(),
            reason_zh: "未检测到前台游戏".into(),
            reason_en: "No foreground game detected".into(),
            attached: false,
        }
    }
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
fn publish_metrics(writer: &OsdShared, pid: u32, flags: u32, row_colors: [u32; row::COUNT]) {
    // Use single-owner snapshots; re-sampling here shares PDH state and state.sys.
    let metrics = crate::sampler::metrics_snapshot();
    let sensors = crate::sampler::sensors_snapshot();
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
    let gpu_clock = if gpu.available {
        nonzero(gpu.graphics_clock)
    } else {
        None
    };
    let gpu_mem_clock = if gpu.available {
        nonzero(gpu.mem_clock)
    } else {
        None
    };
    let gpu_fan = if gpu.available {
        Some(gpu.fan_speed_pct as f32)
    } else {
        None
    };

    // VRAM: prefer NVML used/total, else the PDH/DXGI sidecar values.
    let (vram_used_mb, vram_total_mb) = if gpu.available && gpu.mem_total_bytes > 0 {
        (
            bytes_to_mb(gpu.mem_used_bytes),
            bytes_to_mb(gpu.mem_total_bytes),
        )
    } else if let (Some(used), Some(total)) = (sensors.vram_used, sensors.vram_total) {
        (bytes_to_mb(used), bytes_to_mb(total))
    } else {
        (u32::MAX, u32::MAX)
    };

    // RAM from the system sample (bytes → MB).
    let (ram_used_mb, ram_total_mb) = if metrics.mem_total > 0 {
        (
            bytes_to_mb(metrics.mem_used),
            bytes_to_mb(metrics.mem_total),
        )
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

            let mut tick: u32 = 0;
            let mut failed: Option<(u32, Instant)> = None;
            loop {
                tick = tick.wrapping_add(1);
                if tick % DECIDE_EVERY == 0 {
                    decide(&app, &mut failed);
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
                            publish_metrics(writer, pid, flags, row_colors);
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
pub(crate) fn write_disabled() {
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

/// Clear the sampler target iff it still equals `pid` (the game exited).
fn clear_target_if(pid: u32) {
    let mut st = STATE.lock();
    if st.target_pid == Some(pid) {
        st.target_pid = None;
        st.target_exe = None;
    }
}

/// Whether `exe` (lowercased file name) is on the user's injection allowlist.
pub(crate) fn is_allowed(exe: &str) -> bool {
    CONFIG.lock().allow.contains(exe)
}

/// The ~1 Hz injection decision (see the module docs). Never unloads anything.
fn decide(app: &AppHandle, failed: &mut Option<(u32, Instant)>) {
    if !CONFIG.lock().enabled {
        return;
    }
    let pid = crate::fps::foreground_pid_public();
    if pid == 0 || STATE.lock().target_pid == Some(pid) {
        return;
    }
    if failed.is_some_and(|(p, at)| p == pid && at.elapsed() < INJECT_RETRY_AFTER) {
        return;
    }
    let target = classify_target(pid);
    if !target.injectable {
        return;
    }
    match inject_dll(app, pid) {
        Ok(()) => {
            tracing::info!(pid, exe = ?target.exe, "overlay injected");
            let mut st = STATE.lock();
            st.target_pid = Some(pid);
            st.target_exe = target.exe;
            *failed = None;
        }
        Err(e) => {
            tracing::warn!(pid, exe = ?target.exe, "overlay injection failed: {e}");
            *failed = Some((pid, Instant::now()));
        }
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
fn reason_for(target: &OverlayTarget, mode: OverlayMode) -> (String, String) {
    match mode {
        OverlayMode::Inject => {
            let a = api_label(target.api);
            (format!("✅ 可注入（{a}）"), format!("✅ Injectable ({a})"))
        }
        OverlayMode::Window if target.blocked_by.is_some() => {
            let v = target.blocked_by.as_deref().unwrap_or_default();
            (
                format!("⚠️ {v} 内核反作弊正在运行，已禁用注入，改用窗口叠加（避免封号）"),
                format!(
                    "⚠️ {v} kernel anti-cheat is running; injection disabled, using window overlay"
                ),
            )
        }
        OverlayMode::Window if target.anticheat => (
            "⚠️ 检测到反作弊，已自动改用窗口叠加（避免封号）".into(),
            "⚠️ Anti-cheat detected; using window overlay to avoid a ban".into(),
        ),
        OverlayMode::Window if !target.allowed => (
            "未加入游戏内叠加白名单，使用窗口叠加".into(),
            "Not on the in-game overlay allowlist; using window overlay".into(),
        ),
        OverlayMode::Window if !target.native => (
            "⚠️ 32 位游戏暂不支持注入，已改用窗口叠加".into(),
            "⚠️ 32-bit games can't be injected; using window overlay".into(),
        ),
        OverlayMode::Window => match target.api {
            GraphicsApi::Vulkan => (
                "⚠️ Vulkan 暂不支持注入，已改用窗口叠加".into(),
                "⚠️ Vulkan injection is not supported; using window overlay".into(),
            ),
            GraphicsApi::Unknown => (
                "⚠️ 未检测到受支持的图形 API，已改用窗口叠加".into(),
                "⚠️ No supported graphics API detected; using window overlay".into(),
            ),
            _ => (
                "⚠️ 不支持的图形 API，已改用窗口叠加".into(),
                "⚠️ Unsupported graphics API; using window overlay".into(),
            ),
        },
        OverlayMode::None => (
            "未检测到前台游戏".into(),
            "No foreground game detected".into(),
        ),
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
    if target.pid == 0 || !target.game {
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
    if let Some(vendor) = crate::overlay::kernel_anticheat_running() {
        return Err(format!(
            "检测到 {vendor} 内核反作弊正在运行，已拒绝注入（避免封号）"
        ));
    }
    if pid == std::process::id() || !crate::overlay::is_native(pid) {
        return Err("目标不是 64 位游戏进程，已拒绝注入".to_string());
    }

    let dll = resolve_overlay_dll(app)?;
    crate::inject::inject(pid, &dll)?;
    INJECTED_EVER.store(true, Ordering::SeqCst);
    Ok(())
}

/// Whether `corepilot_overlay.dll` may still be mapped into some running game.
/// Injection is never undone from outside, so this stays true for the session
/// once anything was injected; the updater then renames the file aside (legal
/// for a mapped image) instead of letting the installer fail on it.
pub(crate) fn dll_maybe_mapped() -> bool {
    INJECTED_EVER.load(Ordering::SeqCst)
}

/// Lowercased bare exe file names only; anything else is dropped.
fn sanitize_allow(allow: &[String]) -> HashSet<String> {
    allow
        .iter()
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| e.len() <= MAX_EXE_LEN && e.ends_with(".exe") && !e.contains(['\\', '/']))
        .take(MAX_ALLOW)
        .collect()
}

/// Push the overlay config (iron rule 6: flat args into a Rust static). `allow`
/// is the user's per-game allowlist — exe file names, matched case-insensitively.
/// Turning injection off, or removing the current game from the list, stops
/// publishing for it at once; the resident DLL goes inert.
#[tauri::command]
pub fn overlay_config(enabled: bool, allow: Vec<String>, layout_flags: Option<u32>) {
    let allow = sanitize_allow(&allow);
    if let Some(f) = layout_flags {
        LAYOUT_FLAGS.store(f, Ordering::Relaxed);
        push_layout_flags();
    }
    let drop_target = {
        let st = STATE.lock();
        st.target_pid.is_some()
            && (!enabled || !st.target_exe.as_ref().is_some_and(|e| allow.contains(e)))
    };
    *CONFIG.lock() = OverlayConfig { enabled, allow };
    if drop_target {
        let mut st = STATE.lock();
        st.target_pid = None;
        st.target_exe = None;
        drop(st);
        write_disabled();
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
/// UI explain what's happening ("injected (DX12)" / "anti-cheat → window" /
/// "not allowlisted → window" / …). Read-only: injection is [`decide`]'s job.
#[tauri::command]
pub async fn overlay_status(pid: Option<u32>) -> OverlayStatus {
    crate::commands::run_blocking_default("overlay_status", move || {
        let resolved_pid = pid.unwrap_or_else(crate::fps::foreground_pid_public);
        let target = classify_target(resolved_pid);
        let mode = mode_for(&target);
        let attached = STATE.lock().target_pid == Some(resolved_pid) && resolved_pid != 0;
        let (reason_zh, reason_en) = if attached {
            let a = api_label(target.api);
            (format!("✅ 已注入（{a}）"), format!("✅ Injected ({a})"))
        } else {
            reason_for(&target, mode)
        };
        OverlayStatus {
            reason: reason_zh.clone(),
            reason_zh,
            reason_en,
            target,
            mode,
            attached,
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_keeps_only_bare_exe_names() {
        let got = sanitize_allow(&[
            " Cyberpunk2077.EXE ".into(),
            r"C:\Games\x.exe".into(),
            "../evil.exe".into(),
            "notes.txt".into(),
            "eldenring.exe".into(),
        ]);
        let mut got: Vec<_> = got.into_iter().collect();
        got.sort();
        assert_eq!(got, ["cyberpunk2077.exe", "eldenring.exe"]);
    }

    /// Fail closed: nothing is allowed until the user allows it.
    #[test]
    fn nothing_is_allowed_by_default() {
        assert!(!is_allowed("cyberpunk2077.exe"));
    }

    #[test]
    fn kernel_anticheat_probe_runs() {
        // Real SCM query; must not panic. Prints what this machine has running.
        println!(
            "kernel AC running: {:?}",
            crate::overlay::kernel_anticheat_running()
        );
    }
}
