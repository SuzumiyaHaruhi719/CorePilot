//! NVAPI-based GPU clock offsets — the real Afterburner-style overclock that
//! NVML can't do. NVML can only *lock/cap* clocks (and a range-lock cripples
//! GeForce to its minimum); NVAPI's pstate20 interface applies a clock OFFSET
//! (+/- MHz) to the voltage-frequency curve, raising (or lowering) the boost
//! ceiling while keeping dynamic boost + idle downclock.
//!
//! Loads `nvapi64.dll` (ships with the NVIDIA driver). Requires admin (the app
//! runs elevated). Everything degrades gracefully: if NVAPI is unavailable or
//! there's no NVIDIA GPU, calls return `Err`/false and never panic.

use once_cell::sync::Lazy;

/// NVAPI is initialized once per process (it's a global library).
static NVAPI_OK: Lazy<bool> = Lazy::new(|| nvapi::initialize().is_ok());

/// Safe-ish offset bounds (MHz). The GPU/driver clamps further; these keep the
/// UI sane. Negative = underclock (efficiency), positive = overclock.
pub const CORE_MIN: i32 = -500;
pub const CORE_MAX: i32 = 1000;
pub const MEM_MIN: i32 = -2000;
pub const MEM_MAX: i32 = 3000;

fn clamp(v: i32, lo: i32, hi: i32) -> i32 {
    v.clamp(lo, hi)
}

/// Whether NVAPI overclocking is available on this machine.
pub fn available() -> bool {
    *NVAPI_OK
}

/// `(core_min, core_max, mem_min, mem_max)` offset bounds in MHz.
pub fn ranges() -> (i32, i32, i32, i32) {
    (CORE_MIN, CORE_MAX, MEM_MIN, MEM_MAX)
}

fn first_gpu() -> Result<nvapi::PhysicalGpu, String> {
    if !*NVAPI_OK {
        return Err("NVAPI unavailable".into());
    }
    nvapi::PhysicalGpu::enumerate()
        .map_err(|e| format!("NVAPI enumerate failed: {e:?}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "no NVIDIA GPU".into())
}

/// Apply a core (graphics) clock offset in MHz on the P0 performance state.
pub fn set_core_offset(mhz: i32) -> Result<(), String> {
    let gpu = first_gpu()?;
    let delta = nvapi::KilohertzDelta(clamp(mhz, CORE_MIN, CORE_MAX) * 1000);
    gpu.set_pstates(std::iter::once((
        nvapi::PState::P0,
        nvapi::ClockDomain::Graphics,
        delta,
    )))
    .map_err(|e| format!("set core offset failed: {e:?}"))
}

/// Apply a memory clock offset in MHz on the P0 performance state.
pub fn set_mem_offset(mhz: i32) -> Result<(), String> {
    let gpu = first_gpu()?;
    let delta = nvapi::KilohertzDelta(clamp(mhz, MEM_MIN, MEM_MAX) * 1000);
    gpu.set_pstates(std::iter::once((
        nvapi::PState::P0,
        nvapi::ClockDomain::Memory,
        delta,
    )))
    .map_err(|e| format!("set mem offset failed: {e:?}"))
}
