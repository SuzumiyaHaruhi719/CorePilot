//! NVIDIA dGPU tuning / overclock backend via NVML (`nvml.dll`).
//!
//! Targets the primary NVIDIA GPU (index 0 — NVML only enumerates NVIDIA
//! adapters, so the RTX 4090 is index 0 even with an AMD iGPU present). The
//! AMD iGPU is invisible to NVML and unaffected.
//!
//! NVML is owned by one serialized state machine and sampled by one worker thread;
//! this prevents overlapping calls during driver replacement and permits recovery.
//! Nothing here may panic: NVML or device acquisition failures map to
//! `Err(String)` for the apply/reset commands, or to a struct with
//! `available: false` for the info command.
//!
//! SAFETY: NVML clamps requests to firmware-enforced limits and cannot
//! overvolt or otherwise damage hardware. We additionally clamp every value to
//! NVML-reported constraints before calling, so out-of-range values are never
//! passed to the driver.

use nvml_wrapper::enum_wrappers::device::{Clock, TemperatureSensor, TemperatureThreshold};
use nvml_wrapper::error::NvmlError;
use nvml_wrapper::{Device, Nvml};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Convert milliwatts (NVML's power unit) to watts.
fn mw_to_w(mw: u32) -> f64 {
    f64::from(mw) / 1000.0
}

/// Convert watts to milliwatts, saturating into `u32` (NVML's power unit).
fn w_to_mw(w: f64) -> u32 {
    // Guard against NaN / negatives / overflow before the cast.
    let mw = (w * 1000.0).round();
    if !mw.is_finite() || mw <= 0.0 {
        0
    } else if mw >= f64::from(u32::MAX) {
        u32::MAX
    } else {
        mw as u32
    }
}

/// Clamp `value` into `[min, max]` (handles min > max defensively).
fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    if min > max {
        return value;
    }
    value.clamp(min, max)
}

/// GPU tuning snapshot returned to the frontend. When `available` is false the
/// numeric fields are zeroed/defaulted and should be ignored by the UI.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuOcInfo {
    /// Whether an NVIDIA GPU was found and queried. If false, ignore the rest.
    pub available: bool,
    pub name: String,
    pub driver_version: String,
    /// Current core (graphics) clock, MHz.
    pub graphics_clock: u32,
    /// Current memory clock, MHz.
    pub mem_clock: u32,
    /// Current SM (streaming-multiprocessor) clock, MHz.
    pub sm_clock: u32,
    /// Core temperature, °C.
    pub temperature: i32,
    /// Instantaneous board power draw, watts.
    pub power_usage_w: f64,
    /// Currently enforced power limit, watts.
    pub power_limit_w: f64,
    /// Minimum settable power limit, watts.
    pub power_limit_min_w: f64,
    /// Maximum settable power limit, watts.
    pub power_limit_max_w: f64,
    /// Fan speed as a percentage of maximum, 0..=100 (fan 0).
    pub fan_speed_pct: u32,
    /// GPU core utilization, 0..=100 %.
    pub utilization_gpu: u32,
    /// Memory-controller utilization, 0..=100 %.
    pub utilization_mem: u32,
    /// VRAM in use, bytes.
    pub mem_used_bytes: u64,
    /// Total VRAM, bytes.
    pub mem_total_bytes: u64,
    /// Highest supported graphics clock (MHz) at the top memory clock; 0 if unknown.
    pub max_graphics_clock_mhz: u32,
    /// Current thermal target (GPU_MAX threshold), °C — the temperature the card
    /// throttles to hold. This is the "temp limit" knob.
    pub temp_limit_c: u32,
    /// Minimum settable temp limit, °C.
    pub temp_limit_min_c: u32,
    /// Maximum settable temp limit, °C (firmware slowdown ceiling).
    pub temp_limit_max_c: u32,
    /// Whether reading/setting the power-management limit is supported.
    pub supports_power_limit: bool,
    /// Whether locked GPU core clocks are supported.
    pub supports_locked_clocks: bool,
    /// Whether manual fan control is supported.
    pub supports_fan_control: bool,
    /// Whether setting the temperature limit (thermal target) is supported.
    pub supports_temp_limit: bool,
    /// Whether NVAPI clock-offset overclocking is available (Afterburner-style).
    pub supports_clock_offset: bool,
    /// Core clock offset bounds (MHz).
    pub core_offset_min_mhz: i32,
    pub core_offset_max_mhz: i32,
    /// Memory clock offset bounds (MHz).
    pub mem_offset_min_mhz: i32,
    pub mem_offset_max_mhz: i32,
    /// Whether `temperature` came from a *successful* NVML read. `available`
    /// only means the device was acquired; without this flag a failed
    /// temperature query was indistinguishable from a genuine 0 °C, and
    /// `sensors.rs` treats `Some(0.0)` as a real reading — permanently
    /// suppressing the LibreHardwareMonitor fallback (GPU stuck at 0 °C
    /// forever). `#[serde(skip)]` keeps the wire format the frontend sees
    /// byte-identical.
    #[serde(skip)]
    pub temp_valid: bool,
    /// Same guard for `power_usage_w` (0 W would suppress the sidecar too).
    #[serde(skip)]
    pub power_valid: bool,
}

/// Requested tuning changes. Every field is optional; `None` means "leave as-is".
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuOcSettings {
    /// Target power limit in watts (clamped to NVML min/max constraints).
    pub power_limit_w: Option<f64>,
    /// Lower bound for locked core clock, MHz.
    pub core_clock_min_mhz: Option<u32>,
    /// Upper bound for locked core clock, MHz.
    pub core_clock_max_mhz: Option<u32>,
    /// Lower bound for locked memory clock, MHz.
    pub mem_clock_min_mhz: Option<u32>,
    /// Upper bound for locked memory clock, MHz.
    pub mem_clock_max_mhz: Option<u32>,
    /// Fan speed as a percentage, 0..=100 (applied to every fan).
    pub fan_speed_pct: Option<u32>,
    /// Temperature limit (thermal target), °C.
    pub temp_limit_c: Option<u32>,
    /// Core clock OFFSET in MHz (NVAPI, Afterburner-style; +/- shifts the curve).
    pub core_offset_mhz: Option<i32>,
    /// Memory clock OFFSET in MHz (NVAPI).
    pub mem_offset_mhz: Option<i32>,
}

/// Lowest temp limit we let the UI request, °C (sane floor).
const TEMP_LIMIT_FLOOR: u32 = 50;

/// Lowest *manual* fan speed we let the UI request, % of max. Auto fan control is
/// expressed as `fan_speed_pct == None` (the frontend omits the field), so any
/// value that reaches here is an explicit manual request — and a manual 0% would
/// pin the fans fully off and let the GPU overheat. We clamp the manual floor to
/// this value; restoring the automatic fan curve goes through `gpu_oc_reset`
/// (`set_default_fan_speed`), never through a 0% manual request.
const FAN_SPEED_FLOOR: u32 = 20;

/// Factory thermal target captured on first read, restored by reset.
static DEFAULT_TEMP_LIMIT: Lazy<Mutex<Option<u32>>> = Lazy::new(|| Mutex::new(None));
/// Cached one-time probe: is the GPU_MAX threshold settable on this GPU?
static TEMP_LIMIT_SETTABLE: Lazy<Mutex<Option<bool>>> = Lazy::new(|| Mutex::new(None));

/// `true` for `NvmlError::NotSupported`, used to distinguish "capability
/// absent" from a genuine failure when probing `supports_*` flags.
fn is_unsupported(err: &NvmlError) -> bool {
    matches!(err, NvmlError::NotSupported)
}

/// NVML is process-global and can be torn down while Windows replaces the driver.
/// Keep the handle and every device operation behind one mutex so no two callers
/// can enter nvml.dll during that teardown window.
enum NvmlState {
    Ready(Nvml),
    Lost {
        retry_at: Instant,
        backoff: Duration,
    },
    Absent {
        retry_at: Instant,
        backoff: Duration,
    },
}

static NVML: Lazy<Mutex<NvmlState>> = Lazy::new(|| {
    Mutex::new(NvmlState::Absent {
        retry_at: Instant::now(),
        backoff: Duration::from_secs(5),
    })
});
static GPU_SNAPSHOT: Lazy<Mutex<Arc<GpuOcInfo>>> =
    Lazy::new(|| Mutex::new(Arc::new(GpuOcInfo::default())));
/// Demand stamp for the FULL snapshot (~20 NVML calls) — `gpu_oc_info_snapshot`
/// consumers only (GPU tab, overlay, recorder, taskbar plate).
static GPU_DEMAND_MS: AtomicU64 = AtomicU64::new(0);
/// Demand stamp for the two-call temperature/power read. Kept separate from
/// `GPU_DEMAND_MS` so the once-per-second `gpu_temp_power` telemetry caller
/// cannot pin the worker into running the full ~20-call snapshot forever.
static GPU_LIGHT_DEMAND_MS: AtomicU64 = AtomicU64::new(0);
static GPU_THREAD: std::sync::Once = std::sync::Once::new();

/// The two fields `gpu_temp_power` needs. `None` means the NVML read failed, so
/// the caller falls back to the sidecar instead of believing a fabricated 0.
#[derive(Clone, Copy, Default)]
struct GpuLight {
    temp_c: Option<f32>,
    power_w: Option<f32>,
}

static GPU_LIGHT: Lazy<Mutex<GpuLight>> = Lazy::new(|| Mutex::new(GpuLight::default()));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn is_gpu_lost(err: &NvmlError) -> bool {
    matches!(
        err,
        NvmlError::GpuLost
            | NvmlError::Uninitialized
            | NvmlError::DriverNotLoaded
            | NvmlError::Unknown
            | NvmlError::LibraryNotFound
    )
}

fn mark_failed(lost: bool, backoff: Duration) -> NvmlState {
    let next = (backoff * 2).min(Duration::from_secs(60));
    let retry_at = Instant::now() + backoff;
    if lost {
        NvmlState::Lost {
            retry_at,
            backoff: next,
        }
    } else {
        NvmlState::Absent {
            retry_at,
            backoff: next,
        }
    }
}

/// Hold NVML's mutex for device acquisition and the entire closure. The old
/// shared handle allowed sampler and recorder calls to overlap in nvml.dll.
fn with_device<T>(f: impl FnOnce(&mut Device<'_>) -> T) -> Result<T, String> {
    let mut state = NVML.lock();
    if !matches!(*state, NvmlState::Ready(_)) {
        let (retry_at, backoff, was_lost) = match &*state {
            NvmlState::Lost { retry_at, backoff } => (*retry_at, *backoff, true),
            NvmlState::Absent { retry_at, backoff } => (*retry_at, *backoff, false),
            NvmlState::Ready(_) => unreachable!(),
        };
        if Instant::now() < retry_at {
            return Err("NVML不可用 / NVML unavailable".into());
        }
        match Nvml::init() {
            Ok(n) => *state = NvmlState::Ready(n),
            Err(e) => {
                *state = mark_failed(was_lost || is_gpu_lost(&e), backoff);
                return Err(format!("NVML不可用 / NVML unavailable: {e}"));
            }
        }
    }
    let nvml = match &mut *state {
        NvmlState::Ready(n) => n,
        _ => unreachable!(),
    };
    match nvml.device_by_index(0) {
        Ok(mut device) => Ok(f(&mut device)),
        Err(e) => {
            if is_gpu_lost(&e) {
                let old = std::mem::replace(
                    &mut *state,
                    NvmlState::Absent {
                        retry_at: Instant::now(),
                        backoff: Duration::from_secs(5),
                    },
                );
                drop(old);
                *state = mark_failed(true, Duration::from_secs(5));
            }
            Err(format!("No NVIDIA GPU at index 0: {e}"))
        }
    }
}

/// A demand stamp counts as live for 3 s after the last request.
fn demand_fresh(stamp: u64, now: u64) -> bool {
    stamp != 0 && now.saturating_sub(stamp) <= 3_000
}

/// Two NVML calls — the trimmed body behind [`gpu_temp_power`].
fn read_temp_power() -> GpuLight {
    with_device(|device| GpuLight {
        temp_c: device
            .temperature(TemperatureSensor::Gpu)
            .ok()
            .map(|t| t as f32),
        power_w: device.power_usage().ok().map(|mw| mw_to_w(mw) as f32),
    })
    .unwrap_or_default()
}

fn start_gpu_thread() {
    GPU_THREAD.call_once(|| {
        let spawned = thread::Builder::new()
            .name("corepilot-gpu-nvml".into())
            .spawn(|| loop {
                let now = now_ms();
                if demand_fresh(GPU_DEMAND_MS.load(Ordering::Relaxed), now) {
                    // Full snapshot (~20 NVML calls). It already contains the
                    // light fields, so a full consumer keeps telemetry fresh.
                    let info = build_gpu_info();
                    *GPU_LIGHT.lock() = GpuLight {
                        temp_c: info.temp_valid.then(|| info.temperature as f32),
                        power_w: info.power_valid.then(|| info.power_usage_w as f32),
                    };
                    *GPU_SNAPSHOT.lock() = Arc::new(info);
                } else if demand_fresh(GPU_LIGHT_DEMAND_MS.load(Ordering::Relaxed), now) {
                    // Telemetry-only demand: two NVML reads, not twenty.
                    *GPU_LIGHT.lock() = read_temp_power();
                }
                thread::sleep(Duration::from_millis(
                    if crate::perf_recorder::active_session_count() > 0 {
                        200
                    } else {
                        1000
                    },
                ));
            });
        // Panicking here (the old `.expect`) would kill the caller — now the
        // sampler thread, once per second — AND poison this `Once`, so every
        // later caller panics too and all telemetry dies. Warn instead and
        // leave the snapshots at their defaults (`available: false`).
        if let Err(e) = spawned {
            tracing::warn!("corepilot-gpu-nvml thread failed to spawn: {e}");
        }
    });
}

fn request_snapshot() {
    GPU_DEMAND_MS.store(now_ms(), Ordering::Relaxed);
    start_gpu_thread();
}

/// Lightweight telemetry reads use the published snapshot, never NVML directly.
/// `None` on either field means the NVML read failed (or the GPU is absent), so
/// `sensors.rs` can fall back to the LibreHardwareMonitor sidecar.
pub fn gpu_temp_power() -> (Option<f32>, Option<f32>) {
    // Stamp only the LIGHT demand: requesting the full snapshot here made the
    // worker run all ~20 NVML calls every second (200 ms while recording).
    GPU_LIGHT_DEMAND_MS.store(now_ms(), Ordering::Relaxed);
    start_gpu_thread();
    let light = *GPU_LIGHT.lock();
    (light.temp_c, light.power_w)
}

/// Highest attainable graphics clock (MHz). Prefers `max_clock_info`, which is
/// reliable on all NVIDIA GPUs including Ada (RTX 40-series) where the
/// `supported_graphics_clocks` enumeration returns `NotSupported`. Falls back to
/// the enumeration for older parts. Returns 0 only if both are unavailable.
fn max_graphics_clock(device: &Device) -> u32 {
    if let Ok(m) = device.max_clock_info(Clock::Graphics) {
        if m > 0 {
            return m;
        }
    }
    let mem_clocks = match device.supported_memory_clocks() {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let Some(&top_mem) = mem_clocks.iter().max() else {
        return 0;
    };
    device
        .supported_graphics_clocks(top_mem)
        .ok()
        .and_then(|gc| gc.into_iter().max())
        .unwrap_or(0)
}

/// Return the latest worker-published snapshot. Readers only clone an `Arc`;
/// NVML calls happen on `corepilot-gpu-nvml`, not on the UI or sampler thread.
#[tauri::command]
pub async fn gpu_oc_info() -> GpuOcInfo {
    crate::commands::run_blocking_default("gpu_oc_info", gpu_oc_info_snapshot).await
}

/// Synchronous body of [`gpu_oc_info`], for callers already off the main thread
/// (overlay sampler, perf recorder, CLI).
pub fn gpu_oc_info_snapshot() -> GpuOcInfo {
    request_snapshot();
    GPU_SNAPSHOT.lock().clone().as_ref().clone()
}

fn build_gpu_info() -> GpuOcInfo {
    // The whole snapshot is built inside `with_device` so the borrowed `Device`
    // never outlives its `Nvml`. Device-acquisition failure → `available: false`.
    with_device(|device| {
        let mut info = GpuOcInfo {
            available: true,
            ..Default::default()
        };

        info.name = device.name().unwrap_or_default();
        info.driver_version = device.nvml().sys_driver_version().unwrap_or_default();

        info.graphics_clock = device.clock_info(Clock::Graphics).unwrap_or(0);
        info.mem_clock = device.clock_info(Clock::Memory).unwrap_or(0);
        info.sm_clock = device.clock_info(Clock::SM).unwrap_or(0);

        // Keep the failure visible: a zeroed field is only trustworthy when the
        // matching `*_valid` flag is set (see `GpuOcInfo::temp_valid`).
        match device.temperature(TemperatureSensor::Gpu) {
            Ok(t) => {
                info.temperature = t as i32;
                info.temp_valid = true;
            }
            Err(_) => info.temperature = 0,
        }

        match device.power_usage() {
            Ok(mw) => {
                info.power_usage_w = mw_to_w(mw);
                info.power_valid = true;
            }
            Err(_) => info.power_usage_w = 0.0,
        }

        // Power limit + constraints. `supports_power_limit` is true only if both the
        // enforced limit and the constraints are readable (and not NotSupported).
        let enforced = device.enforced_power_limit();
        let constraints = device.power_management_limit_constraints();
        info.supports_power_limit = !matches!(&enforced, Err(e) if is_unsupported(e))
            && !matches!(&constraints, Err(e) if is_unsupported(e))
            && enforced.is_ok()
            && constraints.is_ok();
        if let Ok(limit) = enforced {
            info.power_limit_w = mw_to_w(limit);
        }
        if let Ok(c) = constraints {
            info.power_limit_min_w = mw_to_w(c.min_limit);
            info.power_limit_max_w = mw_to_w(c.max_limit);
        }

        // Fan: probe fan 0. NotSupported (or no fans) => manual control unavailable.
        let fan0 = device.fan_speed(0);
        info.supports_fan_control = fan0.is_ok();
        info.fan_speed_pct = fan0.unwrap_or(0);

        if let Ok(util) = device.utilization_rates() {
            info.utilization_gpu = util.gpu;
            info.utilization_mem = util.memory;
        }

        if let Ok(mem) = device.memory_info() {
            info.mem_used_bytes = mem.used;
            info.mem_total_bytes = mem.total;
        }

        // Locked-clocks support: presence of supported graphics clocks is the
        // proxy. A non-zero max also feeds the UI's slider range.
        info.max_graphics_clock_mhz = max_graphics_clock(device);
        // Core-clock locking (NVML) is replaced by NVAPI clock OFFSETS — the lock
        // crippled GeForce to its minimum; offsets are the real Afterburner control.
        info.supports_locked_clocks = false;
        info.supports_clock_offset = crate::nvapi_oc::available();
        let (c_lo, c_hi, m_lo, m_hi) = crate::nvapi_oc::ranges();
        info.core_offset_min_mhz = c_lo;
        info.core_offset_max_mhz = c_hi;
        info.mem_offset_min_mhz = m_lo;
        info.mem_offset_max_mhz = m_hi;

        // Temp limit (thermal target). On consumer GeForce the GPU_MAX threshold is
        // NOT settable via NVML, but the ACOUSTIC_CURR threshold IS — it's the
        // temperature the card tries to hold (what Afterburner calls "temp limit").
        // Read current, capture the factory default once, and probe set-ability a
        // single time with a no-op set, caching the result.
        if let Ok(cur) = device.temperature_threshold(TemperatureThreshold::AcousticCurr) {
            info.temp_limit_c = cur;
            info.temp_limit_min_c = device
                .temperature_threshold(TemperatureThreshold::AcousticMin)
                .unwrap_or(TEMP_LIMIT_FLOOR);
            info.temp_limit_max_c = device
                .temperature_threshold(TemperatureThreshold::AcousticMax)
                .unwrap_or(90);
            {
                let mut def = DEFAULT_TEMP_LIMIT.lock();
                if def.is_none() {
                    *def = Some(cur);
                }
            }
            let cached = *TEMP_LIMIT_SETTABLE.lock();
            let settable = match cached {
                Some(v) => v,
                None => {
                    let ok = device
                        .set_temperature_threshold(TemperatureThreshold::AcousticCurr, cur as i32)
                        .is_ok();
                    *TEMP_LIMIT_SETTABLE.lock() = Some(ok);
                    ok
                }
            };
            info.supports_temp_limit = settable;
        }

        info
    })
    .unwrap_or_default()
}

/// Debug probe: for every NVML temperature-threshold type, read it and attempt
/// a no-op set (current value back), reporting which are settable. Explains why
/// temp-limit is unsupported on consumer GeForce (and reveals any alternative
/// settable threshold). Not wired into the GUI — used by the CLI.
pub fn gpu_temp_probe() -> Vec<String> {
    let thresholds = [
        ("GpuMax", TemperatureThreshold::GpuMax),
        ("AcousticMin", TemperatureThreshold::AcousticMin),
        ("AcousticCurr", TemperatureThreshold::AcousticCurr),
        ("AcousticMax", TemperatureThreshold::AcousticMax),
        ("Slowdown", TemperatureThreshold::Slowdown),
        ("Shutdown", TemperatureThreshold::Shutdown),
    ];
    with_device(|device| {
        let mut out = Vec::new();
        for (name, t) in thresholds {
            match device.temperature_threshold(t) {
                Ok(cur) => match device.set_temperature_threshold(t, cur as i32) {
                    Ok(()) => out.push(format!("{name}: read={cur}C  SET=OK (SETTABLE)")),
                    Err(e) => out.push(format!("{name}: read={cur}C  SET=Err({e})")),
                },
                Err(e) => out.push(format!("{name}: read=Err({e})")),
            }
        }
        out
    })
    .unwrap_or_else(|e| vec![format!("init failed: {e}")])
}

/// Apply the requested tuning changes. Each control is attempted independently;
/// successes are kept even if other controls fail. Returns `Err` only when
/// *every* requested control failed (or NVML/device init failed). The app runs
/// elevated, which is required for these mutations.
/// Async wrapper: NVML writes can be slow under GPU-tool contention (Armoury Crate /
/// AURA) — keep them off the main thread.
#[tauri::command]
pub async fn gpu_oc_apply(settings: GpuOcSettings) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gpu_oc_apply_impl(settings))
        .await
        .map_err(|e| format!("gpu oc apply task failed: {e}"))?
}

/// Synchronous body of [`gpu_oc_apply`], also called directly by the CLI probe
/// (which has no async runtime), mirroring `gpu_engine_loads_now`.
pub fn gpu_oc_apply_impl(settings: GpuOcSettings) -> Result<(), String> {
    // All mutations run inside `with_device`; the closure returns the collapsed
    // per-control result, and `?` propagates a device-acquisition failure.
    with_device(|device| {
        // Count requested controls so we can return Err only if ALL of them failed.
        let mut requested = 0usize;
        let mut failures: Vec<String> = Vec::new();

        // --- Power limit (clamp to constraints, W -> mW) ---
        if let Some(target_w) = settings.power_limit_w {
            requested += 1;
            match device.power_management_limit_constraints() {
                Ok(c) => {
                    let target_mw = w_to_mw(target_w);
                    let clamped = clamp_u32(target_mw, c.min_limit, c.max_limit);
                    if let Err(e) = device.set_power_management_limit(clamped) {
                        failures.push(format!("power limit: {e}"));
                    }
                }
                Err(e) => failures.push(format!("power limit constraints unavailable: {e}")),
            }
        }

        // --- Core / memory clock OFFSET (NVAPI, Afterburner-style) ---
        // Shifts the voltage-frequency curve by +/- MHz: raises (or lowers) the
        // boost ceiling while keeping dynamic boost and idle downclock — unlike the
        // NVML lock, which pinned GeForce to its minimum under load.
        if let Some(off) = settings.core_offset_mhz {
            requested += 1;
            if let Err(e) = crate::nvapi_oc::set_core_offset(off) {
                failures.push(format!("core offset: {e}"));
            }
        }
        if let Some(off) = settings.mem_offset_mhz {
            requested += 1;
            if let Err(e) = crate::nvapi_oc::set_mem_offset(off) {
                failures.push(format!("mem offset: {e}"));
            }
        }

        // --- Fan speed (clamp to FAN_SPEED_FLOOR..=100, apply to every fan) ---
        // A manual request only ever arrives via `Some(pct)`; "auto" is `None` and is
        // restored through `gpu_oc_reset`. So we never honour a manual 0% (which would
        // stop the fans entirely) — clamp up to the safe floor and cap at 100.
        if let Some(pct) = settings.fan_speed_pct {
            requested += 1;
            let clamped = clamp_u32(pct, FAN_SPEED_FLOOR, 100);
            match device.num_fans() {
                Ok(n) if n > 0 => {
                    let mut any_ok = false;
                    let mut fan_errs: Vec<String> = Vec::new();
                    for idx in 0..n {
                        match device.set_fan_speed(idx, clamped) {
                            Ok(()) => any_ok = true,
                            Err(e) => fan_errs.push(format!("fan {idx}: {e}")),
                        }
                    }
                    // Only count fan control as failed if no fan accepted the value.
                    if !any_ok {
                        failures.push(format!("fan speed: {}", fan_errs.join("; ")));
                    }
                }
                Ok(_) => failures.push("fan speed: device reports no fans".into()),
                Err(e) => failures.push(format!("fan speed: num_fans failed: {e}")),
            }
        }

        // --- Temperature limit (thermal target = GPU_MAX threshold) ---
        if let Some(target_c) = settings.temp_limit_c {
            requested += 1;
            // Capture the factory thermal target BEFORE the first mutation so reset
            // can restore the true default. `gpu_oc_info` also seeds this, but on a
            // startup auto-apply path apply runs first — without this, reset would
            // have no baseline (or worse, a baseline equal to an already-applied
            // value). Read the live current threshold and store it once.
            if DEFAULT_TEMP_LIMIT.lock().is_none() {
                if let Ok(cur) = device.temperature_threshold(TemperatureThreshold::AcousticCurr) {
                    let mut def = DEFAULT_TEMP_LIMIT.lock();
                    if def.is_none() {
                        *def = Some(cur);
                    }
                }
            }
            let lo = device
                .temperature_threshold(TemperatureThreshold::AcousticMin)
                .unwrap_or(TEMP_LIMIT_FLOOR);
            let hi = device
                .temperature_threshold(TemperatureThreshold::AcousticMax)
                .unwrap_or(90);
            let clamped = clamp_u32(target_c, lo, hi);
            if let Err(e) =
                device.set_temperature_threshold(TemperatureThreshold::AcousticCurr, clamped as i32)
            {
                failures.push(format!("temp limit: {e}"));
            }
        }

        finish(requested, failures)
    })??;
    *GPU_SNAPSHOT.lock() = Arc::new(build_gpu_info());
    Ok(())
}

/// Async wrapper: NVML writes off the main thread (see gpu_oc_apply).
#[tauri::command]
pub async fn gpu_oc_reset() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(gpu_oc_reset_impl)
        .await
        .map_err(|e| format!("gpu oc reset task failed: {e}"))?
}

/// Reset all tuning controls to stock. Each reset is attempted independently;
/// returns `Err` only when every attempted reset failed.
/// Synchronous body of [`gpu_oc_reset`], also called directly by the CLI probe.
pub fn gpu_oc_reset_impl() -> Result<(), String> {
    with_device(|device| {
        let mut requested = 0usize;
        let mut failures: Vec<String> = Vec::new();

        // --- Reset NVAPI clock offsets (core + memory) to 0 ---
        if crate::nvapi_oc::available() {
            requested += 1;
            let core_off = crate::nvapi_oc::set_core_offset(0);
            let _ = crate::nvapi_oc::set_mem_offset(0);
            if let Err(e) = core_off {
                failures.push(format!("reset clock offset: {e}"));
            }
        }

        // --- Reset core locked clocks (clears any lock left by older builds) ---
        requested += 1;
        if let Err(e) = device.reset_gpu_locked_clocks() {
            failures.push(format!("reset core clocks: {e}"));
        }

        // --- Reset memory locked clocks (only count it if the GPU supports it) ---
        match device.reset_mem_locked_clocks() {
            Ok(()) => requested += 1,
            Err(NvmlError::NotSupported) => { /* not supported: not a failure */ }
            Err(e) => {
                requested += 1;
                failures.push(format!("reset memory clocks: {e}"));
            }
        }

        // --- Restore default power limit ---
        requested += 1;
        match device.power_management_limit_default() {
            Ok(default_mw) => {
                if let Err(e) = device.set_power_management_limit(default_mw) {
                    failures.push(format!("restore default power limit: {e}"));
                }
            }
            Err(NvmlError::NotSupported) => {
                // No settable power limit on this part: drop the count so a GPU
                // without power-limit support isn't reported as a failed reset.
                requested -= 1;
            }
            Err(e) => failures.push(format!("default power limit unavailable: {e}")),
        }

        // --- Restore default fan curve for every fan ---
        match device.num_fans() {
            Ok(n) if n > 0 => {
                requested += 1;
                let mut any_ok = false;
                let mut fan_errs: Vec<String> = Vec::new();
                for idx in 0..n {
                    match device.set_default_fan_speed(idx) {
                        Ok(()) => any_ok = true,
                        Err(e) => fan_errs.push(format!("fan {idx}: {e}")),
                    }
                }
                if !any_ok {
                    failures.push(format!("reset fans: {}", fan_errs.join("; ")));
                }
            }
            // No fans / not supported: nothing to reset, not counted.
            Ok(_) => {}
            Err(NvmlError::NotSupported) => {}
            Err(e) => {
                requested += 1;
                failures.push(format!("reset fans: num_fans failed: {e}"));
            }
        }

        // --- Restore factory thermal target ---
        let default_c = *DEFAULT_TEMP_LIMIT.lock();
        if let Some(default_c) = default_c {
            match device
                .set_temperature_threshold(TemperatureThreshold::AcousticCurr, default_c as i32)
            {
                Ok(()) => requested += 1,
                Err(NvmlError::NotSupported) => {}
                Err(e) => {
                    requested += 1;
                    failures.push(format!("reset temp limit: {e}"));
                }
            }
        }

        finish(requested, failures)
    })??;
    *GPU_SNAPSHOT.lock() = Arc::new(build_gpu_info());
    Ok(())
}

/// Collapse per-control outcomes into a single command result: `Ok` if nothing
/// was requested or at least one requested control succeeded; `Err` listing the
/// failures only when every requested control failed.
fn finish(requested: usize, failures: Vec<String>) -> Result<(), String> {
    if requested == 0 {
        return Ok(());
    }
    if failures.len() >= requested {
        Err(failures.join("; "))
    } else {
        Ok(())
    }
}
