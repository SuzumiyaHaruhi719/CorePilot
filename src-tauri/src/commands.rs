//! Tauri command surface (IPC). Affinity masks are u64 on this side but cross
//! the boundary as decimal strings (a JS number only holds integers < 2^53, too
//! few bits for a 64-logical-CPU mask); see `serde_u64`.

use crate::affinity;
use crate::error::{CoreError, CoreResult};
use crate::optimize::{self, CleanResult, MemDetail};
use crate::process::{self, ProcInfo};
use crate::state::AppState;
use crate::sysmon::Metrics;
use crate::topology::CpuTopology;
use serde::Serialize;
use std::sync::Arc;
use sysinfo::System;
use tauri::{Manager, State};

/// Retained no-op for the "亚克力模糊" toggle. The acrylic effect is rendered
/// IN-APP as layered CSS frosted glass (see `[data-acrylic]` in `index.css`):
/// true DWM acrylic/mica does NOT composite through a transparent WebView2 on
/// Win11 24H2 — it shows the windows behind unblurred — so the window stays
/// opaque and the frost is drawn by the page. The frontend still calls this so a
/// future native backdrop could hook in here without changing the IPC contract.
#[tauri::command]
pub fn set_acrylic(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    let _ = (&window, enabled);
    Ok(())
}

/// Set the whole-window opacity (30–100%). On Windows this toggles WS_EX_LAYERED
/// and applies a constant alpha via SetLayeredWindowAttributes, fading the entire
/// DWM-composited window (content + acrylic backdrop). At 100% the layered style
/// is removed so the window renders exactly as the (transparent/acrylic)
/// compositor intends; values are clamped so it can never become invisible.
#[tauri::command]
pub fn set_window_opacity(window: tauri::WebviewWindow, percent: u8) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{COLORREF, HWND};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE,
            LWA_ALPHA, WS_EX_LAYERED,
        };
        let raw = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        if raw != 0 {
            let hwnd = HWND(raw as *mut core::ffi::c_void);
            let pct = percent.clamp(30, 100);
            let layered = WS_EX_LAYERED.0 as isize;
            unsafe {
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                if pct >= 100 {
                    if ex & layered != 0 {
                        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !layered);
                    }
                } else {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | layered);
                    let alpha = (pct as u32 * 255 / 100) as u8;
                    SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&window, percent);
    }
    Ok(())
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub cpu_name: String,
    pub physical_cores: u32,
    pub logical_cpus: u32,
    pub ram_total: u64,
    pub os: String,
    pub vcache_ccd: Option<u32>,
    pub detection: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffinityInfo {
    // Affinity masks are serialized as decimal strings so bits ≥ 53 survive the
    // JS-number (f64) frontend boundary; see `serde_u64`.
    #[serde(with = "crate::serde_u64::str")]
    pub proc_mask: u64,
    #[serde(with = "crate::serde_u64::str")]
    pub sys_mask: u64,
}

#[tauri::command]
pub fn get_topology(state: State<AppState>) -> CpuTopology {
    state.topo.clone()
}

/// Async + blocking-pool (see `run_blocking_default`): waits on the shared
/// `sys` mutex, which `list_processes` can hold for seconds under load — as a
/// sync command that wait happened on the main thread.
/// Overview is effectively static (CPU name / core counts / RAM / OS). Compute it
/// once (locking `state.sys` a single time — it is not polled, so it can never
/// pile up) and serve the cached clone thereafter.
static OVERVIEW_CACHE: std::sync::OnceLock<Overview> = std::sync::OnceLock::new();

#[tauri::command]
pub async fn get_overview(app: tauri::AppHandle) -> Overview {
    OVERVIEW_CACHE
        .get_or_init(|| {
            let state = app.state::<AppState>();
            let sys = state.sys.lock();
            let cpu_name = sys
                .cpus()
                .first()
                .map(|c| c.brand().trim().to_string())
                .unwrap_or_else(|| "Unknown CPU".into());
            Overview {
                cpu_name,
                physical_cores: state.topo.physical_cores,
                logical_cpus: state.topo.logical_count,
                ram_total: sys.total_memory(),
                os: System::long_os_version().unwrap_or_default(),
                vcache_ccd: state.topo.vcache_ccd,
                detection: state.topo.detection.clone(),
            }
        })
        .clone()
}

/// Read of the background sampler's latest process snapshot. The expensive
/// refresh (system-wide process refresh + Toolhelp thread scan + GPU columns from
/// the telemetry snapshot) runs in `crate::sampler`, NEVER on this request path —
/// so this never holds `state.sys` or piles up on a lock (the recurring freeze
/// class). `app` lazily starts the sampler.
///
/// On the blocking pool rather than an async-runtime worker: enumeration is
/// on-demand now, so a COLD call (nobody has asked in >2 s — every
/// `useAffinityEnforcer` sweep, every "pick a running process" dialog) waits for
/// the refresh it just triggered. That wait is short but real, and parking a
/// shared async worker on it is the same starvation bug in a different pool.
///
/// Returns `Err` when the refresh could not be delivered in time — see
/// `sampler::proc_snapshot`. The frontend skips the round rather than acting on
/// a stale roster by PID.
#[tauri::command]
pub async fn list_processes(app: tauri::AppHandle) -> Result<Arc<Vec<ProcInfo>>, String> {
    // Return the shared snapshot `Arc` directly — serde serializes `Arc<T>`
    // byte-identically to `T`, so the IPC wire format and the frontend are
    // unchanged, and we skip a deep clone of the (large) process vector.
    run_blocking_err("list_processes", move || {
        crate::sampler::proc_snapshot(&app)
    })
    .await
}

/// O(1) read of the sampler's latest CPU/memory metrics (no `state.sys` lock here).
#[tauri::command]
pub async fn get_metrics() -> Arc<Metrics> {
    crate::sampler::metrics_snapshot()
}

/// Pin a process to a logical-CPU mask. The mask arrives as a decimal string
/// (it can exceed 2^53, which a JS number can't represent exactly); parse it to
/// a `u64` before delegating to the affinity setter.
#[tauri::command]
pub fn set_affinity(pid: u32, mask: String) -> CoreResult<()> {
    process::guard_critical_pid(pid)?;
    let mask: u64 = mask
        .parse()
        .map_err(|_| crate::error::CoreError::from(format!("invalid affinity mask: {mask}")))?;
    affinity::set_affinity(pid, mask)
}

#[tauri::command]
pub fn get_process_affinity(pid: u32) -> CoreResult<AffinityInfo> {
    let (proc_mask, sys_mask) = affinity::get_affinity(pid)?;
    Ok(AffinityInfo {
        proc_mask,
        sys_mask,
    })
}

#[tauri::command]
pub fn set_priority(pid: u32, class: u32) -> CoreResult<()> {
    process::guard_critical_pid(pid)?;
    affinity::set_priority(pid, class)
}

#[tauri::command]
pub fn get_memory_detail() -> CoreResult<MemDetail> {
    optimize::memory_detail()
}

/// Like [`run_blocking_default`], for command bodies returning
/// `Result<T, String>` (persist writes, overlay injection): runs on the
/// blocking pool with the slow-body warning, surfacing a join failure as `Err`.
pub(crate) async fn run_blocking_err<T, F>(name: &'static str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || warn_slow(name, f))
        .await
        .map_err(|e| format!("blocking task failed: {e}"))?
}

/// Run a blocking optimization step on the blocking thread pool. Sync Tauri
/// commands execute on the MAIN thread — the window's message pump — so
/// seconds-long work (temp-tree deletion, standby purge, powercfg/ipconfig
/// child processes) froze the whole app into "未响应". Async commands leave the
/// main thread alone; `spawn_blocking` keeps the heavy work off the async
/// reactor too.
pub(crate) async fn run_blocking<T, F>(f: F) -> CoreResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CoreResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CoreError::Msg(format!("blocking task failed: {e}")))?
}

/// Absolute path of a Windows helper tool (`reg`, `sc`, `powercfg`, …). A bare
/// name goes through `CreateProcess`'s search order, which looks in the
/// application's own directory first — and this process runs elevated, so a
/// `reg.exe` planted next to a portable install would run as admin.
pub(crate) fn system_tool(name: &str) -> std::path::PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    let name = name.strip_suffix(".exe").unwrap_or(name);
    match name {
        "explorer" => root.join("explorer.exe"),
        "powershell" => root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
        _ => root.join("System32").join(format!("{name}.exe")),
    }
}

/// Run one tick of a 24/7 background loop, surviving a panic in it. Those
/// loops (sampler, telemetry) had no supervision: one panic ended the thread
/// and its snapshot froze forever while every reader kept serving it. The panic
/// itself is still recorded by the hook in `lib.rs`.
pub(crate) fn guarded_tick(name: &'static str, f: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
        tracing::error!("{name}: tick panicked; continuing");
    }
}

/// Duration above which a blocking-capable command body logs a warning. The
/// recurring "未响应" freezes were sync commands stalling the main thread for
/// seconds; now that they run on the blocking pool, this keeps naming the slow
/// ones (with measured durations) in the session log so any recurrence of the
/// stall class stays attributable in the field.
const SLOW_COMMAND_WARN_MS: u128 = 100;

/// Run a command body, logging its name + duration when it exceeds
/// [`SLOW_COMMAND_WARN_MS`]. Zero-cost beyond one `Instant` when fast.
pub(crate) fn warn_slow<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
    let started = std::time::Instant::now();
    let out = f();
    let ms = started.elapsed().as_millis();
    // `list_processes` waits for a fresh walk by design after an idle gap (the
    // affinity enforcer every 8 s): that is not a stall, and at WARN it pushed
    // real evidence out of the 1 MB warn log within a day.
    // process_icon extractions are serialized (process_icon.rs SHELL_LOCK), so a
    // fresh list's burst of requests queues by design.
    let budget = match name {
        "list_processes" => 1_500,
        "process_icon" => 5_000,
        _ => SLOW_COMMAND_WARN_MS,
    };
    if ms > budget {
        tracing::warn!("slow command body: {name} took {ms} ms (off the main thread)");
    }
    out
}

/// Like [`run_blocking`], for commands whose IPC shape is a plain (infallible)
/// value rather than a `CoreResult`. Sync Tauri commands execute on the MAIN
/// thread — the window's message pump — and several polled reads here can stall
/// for seconds under system load (PDH `\GPU Engine(*)` wildcard collection
/// scales with process count, NVML re-inits per call, storefront re-scans spawn
/// `reg.exe`), which froze the window into "未响应" on every poll tick. Running
/// the body on the blocking pool keeps the UI painting; a panicked body
/// degrades to `T::default()` ("no data"), matching these commands' existing
/// fail-soft, never-fabricate contract.
pub(crate) async fn run_blocking_default<T, F>(name: &'static str, f: F) -> T
where
    T: Send + Default + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || warn_slow(name, f))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn free_working_sets() -> CoreResult<()> {
    run_blocking(optimize::free_working_sets).await
}

#[tauri::command]
pub async fn purge_standby() -> CoreResult<()> {
    run_blocking(optimize::purge_standby).await
}

#[tauri::command]
pub async fn flush_modified() -> CoreResult<()> {
    run_blocking(optimize::flush_modified).await
}

#[tauri::command]
pub async fn clean_temp() -> CoreResult<CleanResult> {
    run_blocking(|| Ok(optimize::clean_temp())).await
}

#[tauri::command]
pub async fn flush_dns() -> CoreResult<()> {
    run_blocking(optimize::flush_dns).await
}

#[tauri::command]
pub fn end_task(pid: u32) -> CoreResult<()> {
    process::guard_critical_pid(pid)?;
    process::kill(pid)
}

/// Restart a process: kill it, wait for it to exit, then relaunch the same
/// executable image with its original arguments. This is what the task-manager
/// view offers for SYSTEM / service-account processes instead of a bare "end
/// task" (mirrors Windows Task Manager's explorer.exe "重新启动"). The
/// critical-PID guard refuses the OS-critical set (csrss/lsass/… and anything
/// the kernel flags critical) outright. Async + blocking-pool: waits up to ~3 s
/// for the old process to exit before respawning.
///
/// Service hosts are refused: an image relaunch can't bring their services back
/// (a bare `svchost.exe` with no `-k` exits immediately), so the user is pointed
/// at the services view, which restarts through the SCM.
#[tauri::command]
pub async fn restart_task(pid: u32) -> CoreResult<()> {
    run_blocking(move || {
        process::guard_critical_pid(pid)?;
        if crate::winsvc::list_services()?.iter().any(|s| s.pid == pid) {
            return Err(CoreError::Msg(
                "该进程承载系统服务，无法直接重启；请在「服务」页重启对应服务".into(),
            ));
        }
        let path = crate::fps::process_image_path(pid)
            .ok_or_else(|| CoreError::Msg("无法解析进程路径，无法重启".into()))?;
        // Capture the command line BEFORE the kill — it's gone with the process.
        let args = process::command_line_args(pid);
        process::kill(pid)?;
        // Wait for the old instance to release single-instance locks (<=3 s).
        for _ in 0..30 {
            if !crate::fps::pid_alive(pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf());
        let mut cmd = std::process::Command::new(&path);
        cmd.args(args);
        if let Some(dir) = dir {
            cmd.current_dir(dir);
        }
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| CoreError::Msg(format!("重启失败：{e}")))
    })
    .await
}

/// Async + blocking-pool: `sample()` runs a PDH collect whose `\GPU Engine(*)`
/// wildcard scales with the number of GPU-touching processes (measured: 1374
/// instances / seconds per collect at ~800 processes under load) plus a
/// per-call NVML init/read. Polled at ~1 Hz by the shared telemetry poller AND
/// the OSD overlay window, this was the primary repeated main-thread stall
/// behind the recurring "未响应" (same bug class as cfd1ec0's 一键优化 freeze).
#[tauri::command]
pub async fn get_sensors() -> crate::error::CoreResult<std::sync::Arc<crate::sensors::SensorSample>>
{
    // O(1) read of the sampler's latest sensors snapshot — no SAMPLER lock or PDH/
    // NVML on this request path (the sampler does that off-path on its cadence).
    // Return the shared `Arc` directly: serde serializes `Arc<T>` byte-identically
    // to `T`, so the IPC wire format and the frontend are unchanged, and we skip a
    // deep clone of the sample.
    Ok(crate::sampler::sensors_snapshot())
}

// --- SMU tuning (Curve Optimizer / PBO) — forwarded to the sensord sidecar -----

/// Latest SMU status (also asks the sidecar to emit a fresh line; poll to refresh).
#[tauri::command]
pub fn smu_status() -> crate::smu::SmuStatus {
    crate::smu::request_status();
    crate::smu::status()
}

/// The SMU writes below each wait (≤3 s) for sensord's reply to that exact
/// request, so they run on the blocking pool. All are live overrides; never
/// auto-reverted.
///
/// Per-core Curve Optimizer margin (±50, enforced in sensord).
#[tauri::command]
pub async fn smu_apply_co(ccd: i32, core: i32, margin: i32) -> crate::smu::SmuApplyResult {
    run_blocking_default("smu_apply_co", move || {
        crate::smu::apply_co(ccd, core, margin)
    })
    .await
}

/// All-core Curve Optimizer margin.
#[tauri::command]
pub async fn smu_apply_co_all(margin: i32) -> crate::smu::SmuApplyResult {
    run_blocking_default("smu_apply_co_all", move || crate::smu::apply_co_all(margin)).await
}

/// PBO limit. `kind` ∈ {ppt, tdc, edc}; `value` W (PPT) or A (TDC/EDC).
#[tauri::command]
pub async fn smu_apply_limit(kind: String, value: f64) -> crate::smu::SmuApplyResult {
    run_blocking_default("smu_apply_limit", move || {
        crate::smu::apply_limit(&kind, value)
    })
    .await
}

/// PBO scalar (1×–10×).
#[tauri::command]
pub async fn smu_set_scalar(scalar: i32) -> crate::smu::SmuApplyResult {
    run_blocking_default("smu_set_scalar", move || crate::smu::set_scalar(scalar)).await
}

/// Explicit "force stock": all-core CO = 0. Overrides BIOS Curve-Optimizer for
/// this boot (reboot restores the BIOS undervolt). User-initiated only.
#[tauri::command]
pub async fn smu_force_stock() -> crate::smu::SmuApplyResult {
    run_blocking_default("smu_force_stock", crate::smu::force_stock_co).await
}

/// The deep CPU sensor list (per-core clocks, CCD temps, voltages, TDC/EDC…)
/// from the sidecar. Split out of `get_sensors`, which every 1 Hz poller pays
/// for, because only the SMU telemetry view reads it.
#[tauri::command]
pub fn cpu_sensors() -> Vec<crate::sensors::CpuSensor> {
    crate::sensors::cpu_sensors()
}

/// Reveal a file in Windows Explorer (opens its folder and selects it). Used by
/// the Task Manager "打开文件位置" context action. Best-effort: `explorer` often
/// returns a non-zero exit code even on success, so we only fail if it can't be
/// spawned at all.
#[tauri::command]
pub async fn reveal_in_explorer(path: String, open: Option<bool>) -> CoreResult<()> {
    // Spawning a child process (and the path-exists stat) can block; run it on the
    // blocking pool so the main thread's message pump never stalls.
    tauri::async_runtime::spawn_blocking(move || -> CoreResult<()> {
        use std::os::windows::process::CommandExt;
        let p = path.trim();
        if p.is_empty() {
            return Err("该进程没有可用的文件路径（受保护/系统进程）".into());
        }
        // We build the explorer argument with raw_arg (the path may contain spaces),
        // wrapping the path in double quotes. Because the quoting is unescaped, a path
        // containing a double quote, control char, or newline could break out of the
        // quoted argument and inject additional `explorer.exe` arguments. Reject any
        // such path before constructing the command.
        if p.contains('"') || p.chars().any(|c| c.is_control()) {
            return Err("文件路径包含非法字符".into());
        }
        // Require the file to actually exist; this both gives a clearer error for
        // stale paths and ensures we never hand explorer an arbitrary attacker-shaped
        // string for a nonexistent target.
        if !std::path::Path::new(p).exists() {
            return Err("文件路径不存在".into());
        }
        // `explorer /select,"<full path>"` — pass verbatim via raw_arg so the path
        // (which may contain spaces) is quoted correctly for explorer's parser.
        // `open` on a folder opens the folder itself instead (disk analyzer menu).
        let arg = if open == Some(true) && std::path::Path::new(p).is_dir() {
            format!("\"{p}\"")
        } else {
            format!("/select,\"{p}\"")
        };
        std::process::Command::new(system_tool("explorer"))
            .raw_arg(arg)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| crate::error::CoreError::Msg(format!("打开资源管理器失败: {e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| crate::error::CoreError::Msg(format!("task failed: {e}")))?
}

#[tauri::command]
pub async fn get_power_plan() -> CoreResult<String> {
    // Shells out to powercfg — a child-process spawn+wait that stalled the
    // main thread's message pump as a sync command.
    run_blocking(optimize::get_power_plan).await
}

#[tauri::command]
pub async fn set_power_plan(plan: String) -> CoreResult<()> {
    run_blocking(move || optimize::set_power_plan(&plan)).await
}

#[tauri::command]
pub async fn list_services() -> CoreResult<Vec<crate::winsvc::ServiceItem>> {
    // Enumerating the SCM can block for seconds — keep it off the main thread.
    tauri::async_runtime::spawn_blocking(crate::winsvc::list_services)
        .await
        .map_err(|e| crate::error::CoreError::Msg(format!("task failed: {e}")))?
}

/// Async: SCM start/stop can block for seconds — keep it off the main thread.
#[tauri::command]
pub async fn control_service(name: String, action: String) -> CoreResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::winsvc::control_service(name, action))
        .await
        .map_err(|e| CoreError::Msg(format!("service control task failed: {e}")))?
}

#[tauri::command]
pub async fn list_startup() -> CoreResult<Vec<crate::winsvc::StartupItem>> {
    // Registry/filesystem startup-entry scan (may spawn `reg.exe`) can block —
    // run it on the blocking pool so the main thread keeps painting.
    tauri::async_runtime::spawn_blocking(crate::winsvc::list_startup)
        .await
        .map_err(|e| crate::error::CoreError::Msg(format!("task failed: {e}")))?
}

#[tauri::command]
pub async fn set_startup_enabled(name: String, location: String, enabled: bool) -> CoreResult<()> {
    // Registry writes / startup-folder edits can block — keep them off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        crate::winsvc::set_startup_enabled(name, location, enabled)
    })
    .await
    .map_err(|e| crate::error::CoreError::Msg(format!("task failed: {e}")))?
}

/// Open a native file-open dialog for `.exe` files and return the chosen files'
/// base names, lowercased (e.g. `["cyberpunk2077.exe"]`); empty if cancelled.
/// Lets the OSD game list add a game by browsing to its executable, without the
/// game having to be running first. Async so the modal dialog never blocks the
/// IPC worker thread.
#[tauri::command]
pub async fn pick_exe_files() -> Vec<String> {
    rfd::AsyncFileDialog::new()
        .set_title("选择游戏可执行文件")
        .add_filter("可执行文件", &["exe"])
        .pick_files()
        .await
        .map(|files| files.iter().map(|f| f.file_name().to_lowercase()).collect())
        .unwrap_or_default()
}

/// Scheduled-task name used for "开机自启动". A logon-triggered task with HIGHEST
/// privileges is the correct autostart mechanism for an elevated
/// (requireAdministrator) app: it launches CorePilot ELEVATED at logon with NO UAC
/// prompt. A plain `HKCU\…\Run` entry can't auto-elevate a requireAdministrator app,
/// so it would instead pop a UAC prompt (or be blocked) on every boot.
const AUTOSTART_TASK: &str = "CorePilotAutostart";

/// Whether "开机自启动" is currently enabled (i.e. the logon scheduled task exists).
#[tauri::command]
pub async fn get_autostart() -> bool {
    // Spawns `schtasks` and waits — run it on the blocking pool so the main thread
    // never stalls. A join failure degrades to `false`, matching the existing
    // fail-soft `unwrap_or(false)` contract.
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new(system_tool("schtasks"))
                .args(["/query", "/tn", AUTOSTART_TASK])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW — never flash a console
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(target_os = "windows"))]
        {
            false
        }
    })
    .await
    .unwrap_or(false)
}

/// Create (or overwrite) the autostart scheduled task, aimed at THIS executable.
///
/// Blocking — spawns `schtasks` and waits. Never call from the main thread.
#[cfg(target_os = "windows")]
fn create_autostart_task() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x0800_0000;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().to_string();
    // A real Windows path can't contain a double quote; refuse anything odd
    // so we never inject extra tokens into the schtasks command line.
    if exe.contains('"') {
        return Err("可执行文件路径包含非法字符".into());
    }
    // schtasks /tr needs the program path quoted (Program Files has spaces).
    // raw_arg writes the command line verbatim, so we emit `/tr "\"<exe>\""`
    // → schtasks stores the action as a quoted path. (Command's own arg
    // escaping of embedded quotes is version-fragile, hence raw_arg.)
    let mut cmd = std::process::Command::new(system_tool("schtasks"));
    cmd.raw_arg("/create")
        .raw_arg("/f")
        .raw_arg("/tn")
        .raw_arg(AUTOSTART_TASK)
        .raw_arg("/tr")
        .raw_arg(format!("\"\\\"{exe}\\\"\""))
        .raw_arg("/sc")
        .raw_arg("onlogon")
        .raw_arg("/rl")
        .raw_arg("highest")
        .creation_flags(NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| format!("创建开机自启动任务失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "创建开机自启动任务失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Re-aim the autostart task at the running executable if it points elsewhere.
///
/// An update can move the exe — an installer switching between per-user and
/// per-machine scope relocates it — and a logon task whose action path no longer
/// exists fails silently at boot: autostart just stops working, with nothing in
/// the UI to show for it (the toggle keeps reading "on", because the task does
/// still exist).
///
/// Only ever *repairs*: if the task is absent the user has autostart off and we
/// leave it that way. Fire-and-forget on its own thread — `schtasks` spawns a
/// child process and this is called from `setup`, which runs on the main thread.
pub fn repair_autostart_path() {
    #[cfg(target_os = "windows")]
    std::thread::spawn(|| {
        use std::os::windows::process::CommandExt;
        const NO_WINDOW: u32 = 0x0800_0000;

        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let exe = exe.to_string_lossy().to_string();

        let Ok(out) = std::process::Command::new(system_tool("schtasks"))
            .args(["/query", "/tn", AUTOSTART_TASK, "/fo", "LIST", "/v"])
            .creation_flags(NO_WINDOW)
            .output()
        else {
            return;
        };
        if !out.status.success() {
            return; // no task → autostart is off → nothing to repair
        }

        // The action line is locale-dependent ("Task To Run:" / "要运行的任务:"),
        // so match on the VALUE instead of the label: an exe path that appears
        // anywhere in the dump is the path the task runs. A non-ASCII install
        // path could be mangled by the console codepage and read as a mismatch —
        // the consequence is one redundant, idempotent re-create, which is why
        // this compares rather than parses.
        let dump = String::from_utf8_lossy(&out.stdout).to_lowercase();
        if dump.contains(&exe.to_lowercase()) {
            return;
        }

        tracing::warn!("autostart task points elsewhere; re-aiming it at {exe}");
        if let Err(e) = create_autostart_task() {
            tracing::warn!("autostart re-aim failed: {e}");
        }
    });
}

/// Enable/disable "开机自启动" by creating/deleting a logon-triggered, highest-
/// privileges scheduled task that runs THIS executable — so CorePilot launches
/// elevated at logon with no UAC prompt. Pairs with "关闭后保留到托盘" for a silent
/// background start.
#[tauri::command]
pub async fn set_autostart(enable: bool) -> Result<(), String> {
    // Spawns `schtasks /create` or `/delete` and waits — run it on the blocking
    // pool so the main thread's message pump never stalls.
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const NO_WINDOW: u32 = 0x0800_0000;
            if enable {
                create_autostart_task()?;
            } else {
                let out = std::process::Command::new(system_tool("schtasks"))
                    .args(["/delete", "/f", "/tn", AUTOSTART_TASK])
                    .creation_flags(NO_WINDOW)
                    .output()
                    .map_err(|e| format!("删除开机自启动任务失败: {e}"))?;
                // Deleting a task that doesn't exist is fine (idempotent "off").
                if !out.status.success() {
                    let err = String::from_utf8_lossy(&out.stderr);
                    let missing = err.contains("does not exist")
                        || err.contains("cannot find")
                        || err.contains("找不到")
                        || err.contains("不存在");
                    if !missing {
                        return Err(format!("删除开机自启动任务失败: {}", err.trim()));
                    }
                }
            }
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = enable;
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}
