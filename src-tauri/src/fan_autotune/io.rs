//! TuneIo: the auto-tuner's only window to the world — clock, sensors, fans,
//! load generators, progress, abort. RealIo talks to the sidecar; sim tests
//! substitute a virtual plant. Also home of the IPC-shared tune types.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::fan::FanCalibration;
use crate::fan_autotune::model::{Group, GpuModel, ThermalModel, TunedFanCurve, TuneWarning, WPoint};

// --- user parameters (spec §2) ----------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoTuneParams {
    pub target_temp_c: f32,       // 60..=88, default 85
    pub target_gpu_temp_c: f32,   // 60..=87, default 80
    pub quiet_floor_pct: f32,     // 0..=60, default 25
    pub noise_ceil_pct: f32,      // 40..=100, default 100 (ceil ≥ floor + 15)
    /// controlId → group assignment. Excluded fans simply don't appear.
    pub groups: HashMap<String, Group>,
    /// Reuse a recent calibration instead of re-sweeping (spec §3 阶段 1).
    #[serde(default)]
    pub reuse_calibration: Option<Vec<FanCalibration>>,
    /// Settings toggle: tune even when the system has background load. The
    /// quiescence precheck downgrades from an abort to an accuracy warning;
    /// all safety nets stay armed. Defaults off (old callers unchanged).
    #[serde(default)]
    pub allow_background_load: bool,
}

impl AutoTuneParams {
    /// Clamp into spec ranges; returns Err for unsatisfiable combinations.
    pub fn sanitized(&self) -> Result<Self, String> {
        let mut p = self.clone();
        p.target_temp_c = p.target_temp_c.clamp(60.0, 88.0);
        p.target_gpu_temp_c = p.target_gpu_temp_c.clamp(60.0, 87.0);
        p.quiet_floor_pct = p.quiet_floor_pct.clamp(0.0, 60.0);
        p.noise_ceil_pct = p.noise_ceil_pct.clamp(40.0, 100.0);
        if p.noise_ceil_pct < p.quiet_floor_pct + 15.0 {
            return Err("noise ceiling must be ≥ quiet floor + 15%".into());
        }
        if !p.groups.values().any(|g| *g == Group::Cpu) {
            return Err("at least one fan must be in the CPU group".into());
        }
        Ok(p)
    }
}

// --- progress / result (spec §8 events, §6 result) ---------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoTuneProgress {
    /// "precheck" | "fanCalib" | "baseline" | "gridSweep" | "gpuSweep" | "fit"
    /// | "synthesize" | "validate" | "combinedValidate" | "done" | "aborted"
    pub phase: String,
    pub step: u32,
    pub step_total: u32,
    pub cpu_temp: Option<f32>,
    pub cpu_power: Option<f32>,
    pub gpu_temp: Option<f32>,
    pub gpu_power: Option<f32>,
    pub w_cpu: Option<f32>,
    pub w_case: Option<f32>,
    pub eta_s: Option<u32>,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GridPoint {
    pub w_cpu: f32,
    pub w_case: f32,
    pub t_ss: f32,
    pub p_avg: f32,
    pub saturated: bool,
    pub skipped: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuGridPoint {
    pub w_case: f32,
    pub t_gpu_ss: f32,
    pub p_gpu_avg: f32,
    pub t_cpu: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub t_idle: f32,
    pub p_idle: f32,
    pub t_gpu_idle: Option<f32>,
    pub p_gpu_idle: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub t_v: f32,
    pub iterations: u32,
    pub oscillation_fixed: bool,
    pub converged: bool,
    pub combined_t_cpu: Option<f32>,
    pub combined_t_gpu: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutoTuneResult {
    pub params: AutoTuneParams,
    pub calibrations: Vec<FanCalibration>,
    pub baseline: Baseline,
    pub grid: Vec<GridPoint>,
    pub gpu_grid: Vec<GpuGridPoint>,
    pub model: ThermalModel,
    pub model_gpu: Option<GpuModel>,
    pub p_design: f32,
    pub p_design_gpu: Option<f32>,
    pub effective_target: f32,
    pub effective_target_gpu: Option<f32>,
    /// CPU idle-temp rise caused by full GPU load (°C), from the GPU sweep.
    pub gpu_cpu_coupling_c: Option<f32>,
    pub w_points: Vec<WPoint>,
    pub gpu_w_points: Option<Vec<(f32, f32)>>,
    pub curves: Vec<TunedFanCurve>,
    pub cpu_source_id: Option<String>,
    pub gpu_source_id: Option<String>,
    pub validation: ValidationReport,
    pub warnings: Vec<TuneWarning>,
    pub finished_at_ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AbortInfo {
    pub phase: String,
    pub reason_zh: String,
    pub reason_en: String,
}

pub enum AutoTuneOutcome {
    Done(Box<AutoTuneResult>),
    Aborted(AbortInfo),
}

// --- the I/O trait -----------------------------------------------------------------

pub trait TuneIo: Send {
    /// Monotonic seconds since tune start (virtual in tests).
    fn now_s(&self) -> f32;
    /// Sleep (advances virtual time + steps the plant in tests).
    fn sleep_s(&mut self, s: f32);
    fn cpu_temp(&self) -> Option<f32>;
    fn cpu_power(&self) -> Option<f32>;
    fn gpu_temp(&self) -> Option<f32>;
    fn gpu_power(&self) -> Option<f32>;
    /// Whole-system CPU load %, 0..100 (sidecar "CPU Total" Load sensor).
    fn cpu_load_pct(&self) -> Option<f32>;
    fn set_fan_duty(&mut self, control_id: &str, pct: f32);
    fn start_cpu_load(&mut self) -> bool;
    fn stop_cpu_load(&mut self);
    fn start_gpu_load(&mut self) -> bool;
    fn stop_gpu_load(&mut self);
    /// Run the PWM↔RPM sweep for the given headers (engine already paused).
    fn calibrate(&mut self, ids: &[String]) -> Vec<FanCalibration>;
    fn emit_progress(&self, p: &AutoTuneProgress);
    fn abort_requested(&self) -> bool;
    /// Wall-clock suspend/resume detection support: monotonic vs wall delta.
    fn wall_jump_s(&self) -> f32;
}

// --- the real implementation --------------------------------------------------------

pub struct RealIo {
    app: tauri::AppHandle,
    start: std::time::Instant,
    start_wall_ms: u64,
    cpu_load: Option<crate::load_gen::CpuLoad>,
    gpu_load: Option<crate::gpu_load::GpuLoad>,
    pub abort_flag: Arc<AtomicBool>,
}

fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl RealIo {
    pub fn new(app: tauri::AppHandle, abort_flag: Arc<AtomicBool>) -> Self {
        Self { app, start: std::time::Instant::now(), start_wall_ms: wall_ms(), cpu_load: None, gpu_load: None, abort_flag }
    }
}

impl TuneIo for RealIo {
    fn now_s(&self) -> f32 {
        self.start.elapsed().as_secs_f32()
    }
    fn sleep_s(&mut self, s: f32) {
        std::thread::sleep(std::time::Duration::from_secs_f32(s));
    }
    fn cpu_temp(&self) -> Option<f32> {
        crate::sensors::latest_readings().0
    }
    fn cpu_power(&self) -> Option<f32> {
        crate::sensors::latest_readings().1
    }
    fn gpu_temp(&self) -> Option<f32> {
        crate::sensors::latest_readings().2
    }
    fn gpu_power(&self) -> Option<f32> {
        crate::sensors::latest_readings().3
    }
    fn cpu_load_pct(&self) -> Option<f32> {
        crate::sensors::cpu_sensors()
            .iter()
            .find(|s| s.kind == "Load" && s.name.to_lowercase().contains("total"))
            .and_then(|s| s.value)
    }
    fn set_fan_duty(&mut self, control_id: &str, pct: f32) {
        crate::fan::send_set(control_id, pct);
    }
    fn start_cpu_load(&mut self) -> bool {
        self.cpu_load = Some(crate::load_gen::CpuLoad::start());
        true
    }
    fn stop_cpu_load(&mut self) {
        self.cpu_load = None;
    }
    fn start_gpu_load(&mut self) -> bool {
        match crate::gpu_load::GpuLoad::start() {
            Ok(l) => {
                self.gpu_load = Some(l);
                true
            }
            Err(_) => false,
        }
    }
    fn stop_gpu_load(&mut self) {
        self.gpu_load = None;
    }
    fn calibrate(&mut self, ids: &[String]) -> Vec<FanCalibration> {
        crate::fan::calibrate_headers(&self.app, ids)
    }
    fn emit_progress(&self, p: &AutoTuneProgress) {
        use tauri::Emitter;
        let _ = self.app.emit("fan-autotune-progress", p.clone());
    }
    fn abort_requested(&self) -> bool {
        self.abort_flag.load(Ordering::SeqCst)
    }
    fn wall_jump_s(&self) -> f32 {
        let wall_elapsed = (wall_ms().saturating_sub(self.start_wall_ms)) as f32 / 1000.0;
        (wall_elapsed - self.now_s()).abs()
    }
}
