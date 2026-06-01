//! NVIDIA dGPU tuning / overclock backend via NVML (`nvml.dll`).
//!
//! Targets the primary NVIDIA GPU (index 0 — NVML only enumerates NVIDIA
//! adapters, so the RTX 4090 is index 0 even with an AMD iGPU present). The
//! AMD iGPU is invisible to NVML and unaffected.
//!
//! Every command initializes NVML per-call (`Nvml::init()`). This avoids the
//! `Send`/`Sync`/`'static` headaches of caching an `Nvml`/`Device` in a global
//! (the `Device` borrows the `Nvml`), and init is cheap enough for the
//! interactive cadence these commands run at. Nothing here may panic: NVML or
//! device acquisition failures map to `Err(String)` for the apply/reset
//! commands, or to a struct with `available: false` for the info command.
//!
//! SAFETY: NVML clamps requests to firmware-enforced limits and cannot
//! overvolt or otherwise damage hardware. We additionally clamp every value to
//! NVML-reported constraints before calling, so out-of-range values are never
//! passed to the driver.

use nvml_wrapper::enum_wrappers::device::{Clock, TemperatureSensor};
use nvml_wrapper::enums::device::GpuLockedClocksSetting;
use nvml_wrapper::error::NvmlError;
use nvml_wrapper::{Device, Nvml};
use serde::{Deserialize, Serialize};

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
#[derive(Serialize, Default)]
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
    /// Whether reading/setting the power-management limit is supported.
    pub supports_power_limit: bool,
    /// Whether locked GPU core clocks are supported.
    pub supports_locked_clocks: bool,
    /// Whether manual fan control is supported.
    pub supports_fan_control: bool,
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
}

/// `true` for `NvmlError::NotSupported`, used to distinguish "capability
/// absent" from a genuine failure when probing `supports_*` flags.
fn is_unsupported(err: &NvmlError) -> bool {
    matches!(err, NvmlError::NotSupported)
}

/// Acquire the primary NVIDIA device, owning the `Nvml` handle so the borrow
/// outlives the returned `Device`. Returns a human-readable error string.
fn init_device() -> Result<(Nvml, Device<'static>), String> {
    let nvml = Nvml::init().map_err(|e| format!("NVML init failed: {e}"))?;

    // SAFETY/lifetime note: `device_by_index` borrows `nvml`. We transmute the
    // borrow to `'static` and return it alongside the owning `Nvml` so the two
    // travel together; the `Device` is never used after the `Nvml` is dropped
    // because they are dropped together at the end of each command. This keeps
    // per-call init ergonomic without a self-referential struct crate.
    let device = nvml
        .device_by_index(0)
        .map_err(|e| format!("No NVIDIA GPU at index 0: {e}"))?;
    let device: Device<'static> = unsafe { std::mem::transmute(device) };
    Ok((nvml, device))
}

/// Highest supported graphics clock (MHz) at the top supported memory clock.
/// Returns 0 when the query is unsupported or yields nothing.
fn max_graphics_clock(device: &Device) -> u32 {
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

/// Query the current GPU tuning snapshot. Never fails: if NVML is unavailable
/// or no NVIDIA GPU exists, returns `GpuOcInfo { available: false, .. }`.
#[tauri::command]
pub fn gpu_oc_info() -> GpuOcInfo {
    let (_nvml, device) = match init_device() {
        Ok(pair) => pair,
        Err(_) => return GpuOcInfo::default(),
    };

    let mut info = GpuOcInfo {
        available: true,
        ..Default::default()
    };

    info.name = device.name().unwrap_or_default();
    info.driver_version = _nvml.sys_driver_version().unwrap_or_default();

    info.graphics_clock = device.clock_info(Clock::Graphics).unwrap_or(0);
    info.mem_clock = device.clock_info(Clock::Memory).unwrap_or(0);
    info.sm_clock = device.clock_info(Clock::SM).unwrap_or(0);

    info.temperature = device
        .temperature(TemperatureSensor::Gpu)
        .map(|t| t as i32)
        .unwrap_or(0);

    info.power_usage_w = device.power_usage().map(mw_to_w).unwrap_or(0.0);

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
    info.max_graphics_clock_mhz = max_graphics_clock(&device);
    info.supports_locked_clocks = info.max_graphics_clock_mhz > 0;

    info
}

/// Apply the requested tuning changes. Each control is attempted independently;
/// successes are kept even if other controls fail. Returns `Err` only when
/// *every* requested control failed (or NVML/device init failed). The app runs
/// elevated, which is required for these mutations.
#[tauri::command]
pub fn gpu_oc_apply(settings: GpuOcSettings) -> Result<(), String> {
    let (_nvml, mut device) = init_device()?;

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

    // --- Core locked clocks (clamp to supported graphics-clock range) ---
    if settings.core_clock_min_mhz.is_some() || settings.core_clock_max_mhz.is_some() {
        requested += 1;
        // Determine supported range from the top memory clock's graphics clocks.
        let (lo_bound, hi_bound) = supported_graphics_range(&device);
        // Default a missing side to the other side so a single value still locks.
        let raw_min = settings
            .core_clock_min_mhz
            .or(settings.core_clock_max_mhz)
            .unwrap_or(lo_bound);
        let raw_max = settings
            .core_clock_max_mhz
            .or(settings.core_clock_min_mhz)
            .unwrap_or(hi_bound);
        let mut min_mhz = clamp_u32(raw_min, lo_bound, hi_bound);
        let mut max_mhz = clamp_u32(raw_max, lo_bound, hi_bound);
        if min_mhz > max_mhz {
            std::mem::swap(&mut min_mhz, &mut max_mhz);
        }
        let setting = GpuLockedClocksSetting::Numeric {
            min_clock_mhz: min_mhz,
            max_clock_mhz: max_mhz,
        };
        if let Err(e) = device.set_gpu_locked_clocks(setting) {
            failures.push(format!("core locked clocks: {e}"));
        }
    }

    // --- Memory locked clocks ---
    if settings.mem_clock_min_mhz.is_some() || settings.mem_clock_max_mhz.is_some() {
        requested += 1;
        let supported = device.supported_memory_clocks().unwrap_or_default();
        let lo_bound = supported.iter().copied().min().unwrap_or(0);
        let hi_bound = supported.iter().copied().max().unwrap_or(u32::MAX);
        let raw_min = settings
            .mem_clock_min_mhz
            .or(settings.mem_clock_max_mhz)
            .unwrap_or(lo_bound);
        let raw_max = settings
            .mem_clock_max_mhz
            .or(settings.mem_clock_min_mhz)
            .unwrap_or(hi_bound);
        let mut min_mhz = clamp_u32(raw_min, lo_bound, hi_bound);
        let mut max_mhz = clamp_u32(raw_max, lo_bound, hi_bound);
        if min_mhz > max_mhz {
            std::mem::swap(&mut min_mhz, &mut max_mhz);
        }
        // NVML 0.12: memory locked clocks take (min, max) MHz directly (unlike
        // GPU locked clocks, which take a GpuLockedClocksSetting enum).
        if let Err(e) = device.set_mem_locked_clocks(min_mhz, max_mhz) {
            failures.push(format!("memory locked clocks: {e}"));
        }
    }

    // --- Fan speed (clamp 0..=100, apply to every fan) ---
    if let Some(pct) = settings.fan_speed_pct {
        requested += 1;
        let clamped = pct.min(100);
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

    finish(requested, failures)
}

/// Reset all tuning controls to stock. Each reset is attempted independently;
/// returns `Err` only when every attempted reset failed.
#[tauri::command]
pub fn gpu_oc_reset() -> Result<(), String> {
    let (_nvml, mut device) = init_device()?;

    let mut requested = 0usize;
    let mut failures: Vec<String> = Vec::new();

    // --- Reset core locked clocks ---
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

    finish(requested, failures)
}

/// Supported graphics-clock `(min, max)` MHz at the top memory clock. Falls
/// back to `(0, u32::MAX)` (i.e. no clamping) when the query is unsupported.
fn supported_graphics_range(device: &Device) -> (u32, u32) {
    let mem_clocks = match device.supported_memory_clocks() {
        Ok(v) => v,
        Err(_) => return (0, u32::MAX),
    };
    let Some(&top_mem) = mem_clocks.iter().max() else {
        return (0, u32::MAX);
    };
    match device.supported_graphics_clocks(top_mem) {
        Ok(gc) => {
            let lo = gc.iter().copied().min().unwrap_or(0);
            let hi = gc.iter().copied().max().unwrap_or(u32::MAX);
            (lo, hi)
        }
        Err(_) => (0, u32::MAX),
    }
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
