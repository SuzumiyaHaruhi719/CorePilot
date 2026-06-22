//! Passive drift learning (spec §7): piggybacks on the fan engine's 2 s tick.
//! When the tuned curves are ACTIVE and the system sits in a steady high-load
//! state, compare observed temps against the stored model and apply slow,
//! bounded, safety-asymmetric t_off corrections, re-emitting fresh curves.

use std::collections::VecDeque;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::fan::FanCalibration;
use crate::fan_autotune::io::AutoTuneParams;
use crate::fan_autotune::model::{
    self, passive_correction, GpuModel, Group, Steady, SteadyDetector, ThermalModel,
};

/// A `SteadyDetector` here is fed the engine's tick samples forever, so its
/// internal sample Vec would grow without bound on a stream that never ends
/// (days of uptime). Recreate it once this many samples have accumulated; the
/// detector only ever looks at the last ~25 samples, so a periodic reset costs
/// nothing but the in-flight settle and frees the backlog.
const STEADY_RESET_AFTER: u32 = 4000;

/// Streak-plus-spacing gate: fires when `load ≥ threshold` has held for
/// `streak_s` and at least `spacing_s` passed since the last accepted sample.
pub struct SampleGate {
    threshold: f32,
    streak_s: f32,
    spacing_s: f32,
    streak_started: Option<f32>,
    last_fired: Option<f32>,
}

impl SampleGate {
    pub fn new(threshold: f32, streak_s: f32, spacing_s: f32) -> Self {
        Self {
            threshold,
            streak_s,
            spacing_s,
            streak_started: None,
            last_fired: None,
        }
    }
    /// Feed one (t_s, load%) observation; true = take a sample now.
    pub fn feed(&mut self, t_s: f32, load: Option<f32>) -> bool {
        match load {
            Some(l) if l >= self.threshold => {
                let started = *self.streak_started.get_or_insert(t_s);
                let spaced = self
                    .last_fired
                    .map(|f| t_s - f >= self.spacing_s)
                    .unwrap_or(true);
                if t_s - started >= self.streak_s && spaced {
                    self.last_fired = Some(t_s);
                    self.streak_started = Some(t_s); // restart the streak
                    return true;
                }
            }
            _ => self.streak_started = None,
        }
        false
    }
}

#[derive(Default)]
pub struct PassiveAxisState {
    pub residuals: VecDeque<f32>,
    pub accumulated_c: f32,
}

impl PassiveAxisState {
    pub fn push_residual(&mut self, r: f32) {
        self.residuals.push_back(r);
        while self.residuals.len() > 50 {
            self.residuals.pop_front();
        }
    }
}

/// Everything passive learning needs, handed over by the frontend after it
/// applies a tune (spec §8 `fan_passive_configure`).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PassiveConfig {
    pub enabled: bool,
    pub params: AutoTuneParams,
    pub model: ThermalModel,
    pub model_gpu: Option<GpuModel>,
    pub calibrations: Vec<FanCalibration>,
    pub p_design: f32,
    pub p_design_gpu: Option<f32>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PassiveStatus {
    pub enabled: bool,
    pub cpu_samples: usize,
    pub gpu_samples: usize,
    pub accumulated_cpu_c: f32,
    pub accumulated_gpu_c: f32,
}

struct PassiveState {
    cfg: PassiveConfig,
    cpu: PassiveAxisState,
    gpu: PassiveAxisState,
    cpu_gate: SampleGate,
    gpu_gate: SampleGate,
    cpu_steady: SteadyDetector,
    gpu_steady: SteadyDetector,
    /// Samples pushed into the matching detector since its last reset (guards the
    /// detector's internal Vec against unbounded growth on a never-ending stream).
    cpu_ticks: u32,
    gpu_ticks: u32,
    started_s: std::time::Instant,
    last_correction_s: f32,
    app: tauri::AppHandle,
}

static PASSIVE: Lazy<Mutex<Option<PassiveState>>> = Lazy::new(|| Mutex::new(None));

/// Engine-tick hook (called from fan.rs every ~2 s). Cheap when disabled.
pub fn tick() {
    let mut guard = PASSIVE.lock();
    let Some(st) = guard.as_mut() else { return };
    if !st.cfg.enabled {
        return;
    }
    let now = st.started_s.elapsed().as_secs_f32();
    let (cpu_temp, cpu_power, gpu_temp, gpu_power) = crate::sensors::latest_readings();
    let load = crate::sensors::cpu_sensors()
        .iter()
        .find(|s| s.kind == "Load" && s.name.to_lowercase().contains("total"))
        .and_then(|s| s.value);

    // Group airflow from the engine's current duties via calibration inversion.
    let w_of = |group: Group| -> f32 {
        let mut sum = 0.0;
        let mut n = 0;
        for (id, g) in st.cfg.params.groups.iter() {
            if *g != group {
                continue;
            }
            if let Some(duty) = crate::fan::last_applied_duty(id) {
                if let Some(cal) = st.cfg.calibrations.iter().find(|c| &c.control_id == id) {
                    // duty → rpm (interp through calibration) → fraction of max.
                    let rpm = interp_duty_to_rpm(&cal.points, duty);
                    if cal.max_rpm > 0.0 {
                        sum += (rpm / cal.max_rpm).clamp(0.0, 1.0);
                        n += 1;
                    }
                }
            }
        }
        if n == 0 {
            0.0
        } else {
            sum / n as f32
        }
    };

    // CPU axis sample.
    if st.cpu_gate.feed(now, load) {
        if let (Some(t), Some(p)) = (cpu_temp, cpu_power) {
            st.cpu_ticks += 1;
            if let Steady::Steady(v) = st.cpu_steady.push(now, t) {
                let pred = st.cfg.model.predict(p, w_of(Group::Cpu), w_of(Group::Case));
                st.cpu.push_residual(v - pred);
            }
        }
    } else if let Some(t) = cpu_temp {
        st.cpu_ticks += 1;
        let _ = st.cpu_steady.push(now, t);
    }
    if st.cpu_ticks > STEADY_RESET_AFTER {
        st.cpu_steady = SteadyDetector::new(60.0, 100000.0);
        st.cpu_ticks = 0;
    }

    // GPU axis sample (gaming: high GPU power, modest CPU load — spec §7).
    if let (Some(mg), Some(pdg)) = (st.cfg.model_gpu.as_ref(), st.cfg.p_design_gpu) {
        let gpu_load_pct = gpu_power.map(|p| (p / pdg) * 100.0);
        if st.gpu_gate.feed(
            now,
            gpu_load_pct.map(|p| if p >= 70.0 { 95.0 } else { 0.0 }),
        ) {
            if let (Some(t), Some(p)) = (gpu_temp, gpu_power) {
                st.gpu_ticks += 1;
                if let Steady::Steady(v) = st.gpu_steady.push(now, t) {
                    let pred = mg.predict(p, w_of(Group::Case));
                    st.gpu.push_residual(v - pred);
                }
            }
        } else if let Some(t) = gpu_temp {
            st.gpu_ticks += 1;
            let _ = st.gpu_steady.push(now, t);
        }
        if st.gpu_ticks > STEADY_RESET_AFTER {
            st.gpu_steady = SteadyDetector::new(60.0, 100000.0);
            st.gpu_ticks = 0;
        }
    }

    // Correction cadence: the FIRST correction may fire as soon as 5 samples
    // exist (last_correction_s still 0); after that, at most once every 24 h
    // (spec §7: ±0.5/day).
    if now - st.last_correction_s >= 24.0 * 3600.0
        || (st.cpu.residuals.len() >= 5 && st.last_correction_s == 0.0)
    {
        try_correct(st, now);
    }
}

fn interp_duty_to_rpm(points: &[crate::fan::CalibPoint], duty: f32) -> f32 {
    let mut pts: Vec<&crate::fan::CalibPoint> = points.iter().collect();
    pts.sort_by(|a, b| a.duty.total_cmp(&b.duty));
    if pts.is_empty() {
        return 0.0;
    }
    if duty <= pts[0].duty {
        return pts[0].rpm;
    }
    if duty >= pts[pts.len() - 1].duty {
        return pts[pts.len() - 1].rpm;
    }
    for w in pts.windows(2) {
        if duty >= w[0].duty && duty <= w[1].duty {
            let span = w[1].duty - w[0].duty;
            if span <= 0.0 {
                return w[1].rpm;
            }
            return w[0].rpm + (duty - w[0].duty) / span * (w[1].rpm - w[0].rpm);
        }
    }
    pts[pts.len() - 1].rpm
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PassiveAdjustment {
    pub axis: String, // "cpu" | "gpu"
    pub delta_c: f32,
    pub median_residual_c: f32,
    pub curves: Vec<model::TunedFanCurve>,
}

fn try_correct(st: &mut PassiveState, now: f32) {
    use tauri::Emitter;
    let residuals: Vec<f32> = st.cpu.residuals.iter().copied().collect();
    if let Some(delta) = passive_correction(&residuals, st.cpu.accumulated_c) {
        st.cfg.model.t_off += delta;
        st.cpu.accumulated_c += delta;
        st.cpu.residuals.clear();
        st.last_correction_s = now;
        if let Ok(resp) = resynth_from_cfg(&st.cfg) {
            let median = median_of(&residuals);
            let _ = st.app.emit(
                "fan-autotune-passive",
                PassiveAdjustment {
                    axis: "cpu".into(),
                    delta_c: delta,
                    median_residual_c: median,
                    curves: resp,
                },
            );
        }
    }
    let gres: Vec<f32> = st.gpu.residuals.iter().copied().collect();
    if let Some(mg) = st.cfg.model_gpu.as_mut() {
        if let Some(delta) = passive_correction(&gres, st.gpu.accumulated_c) {
            mg.t_off_g += delta;
            st.gpu.accumulated_c += delta;
            st.gpu.residuals.clear();
            st.last_correction_s = now;
            if let Ok(resp) = resynth_from_cfg(&st.cfg) {
                let median = median_of(&gres);
                let _ = st.app.emit(
                    "fan-autotune-passive",
                    PassiveAdjustment {
                        axis: "gpu".into(),
                        delta_c: delta,
                        median_residual_c: median,
                        curves: resp,
                    },
                );
            }
        }
    }
}

fn median_of(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(f32::total_cmp);
    s[s.len() / 2]
}

/// Re-run synthesis from the passive config's (possibly corrected) models.
/// Reuses `super::synth_cpu` (the same flattened synthesis the tune + resynth
/// command use) so the curve math stays single-sourced.
fn resynth_from_cfg(cfg: &PassiveConfig) -> Result<Vec<model::TunedFanCurve>, String> {
    let params = cfg.params.sanitized()?;
    let fans: Vec<(String, Group)> = params.groups.iter().map(|(k, v)| (k.clone(), *v)).collect();
    let has_case = fans.iter().any(|(_, g)| *g == Group::Case);
    let g_rpm = super::group_rpm(&fans, &cfg.calibrations);
    let cpu = super::synth_cpu(
        &cfg.model,
        super::BAND_C,
        cfg.p_design,
        &params,
        params.quiet_floor_pct / 100.0,
        params.noise_ceil_pct / 100.0,
        &g_rpm,
        has_case,
    );
    let gpu = match (&cfg.model_gpu, cfg.p_design_gpu) {
        (Some(mg), Some(pg)) if has_case => Some(model::synthesize_gpu(
            mg,
            pg,
            params.target_gpu_temp_c,
            params.quiet_floor_pct / 100.0,
            params.noise_ceil_pct / 100.0,
        )),
        _ => None,
    };
    Ok(super::build_curves(
        &fans,
        &cfg.calibrations,
        &cpu,
        gpu.as_ref(),
        30.0,
    ))
}

// --- commands -----------------------------------------------------------------------

/// Frontend hands over the tuned model after applying curves (or pauses
/// learning by sending enabled=false / after a hand-edit).
#[tauri::command]
pub fn fan_passive_configure(app: tauri::AppHandle, config: Option<PassiveConfig>) {
    let mut guard = PASSIVE.lock();
    *guard = config.map(|cfg| PassiveState {
        cfg,
        cpu: PassiveAxisState::default(),
        gpu: PassiveAxisState::default(),
        cpu_gate: SampleGate::new(90.0, 120.0, 600.0),
        gpu_gate: SampleGate::new(90.0, 120.0, 600.0),
        cpu_steady: SteadyDetector::new(60.0, 100000.0),
        gpu_steady: SteadyDetector::new(60.0, 100000.0),
        cpu_ticks: 0,
        gpu_ticks: 0,
        started_s: std::time::Instant::now(),
        last_correction_s: 0.0,
        app,
    });
}

#[tauri::command]
pub fn fan_passive_status() -> PassiveStatus {
    let guard = PASSIVE.lock();
    match guard.as_ref() {
        Some(st) => PassiveStatus {
            enabled: st.cfg.enabled,
            cpu_samples: st.cpu.residuals.len(),
            gpu_samples: st.gpu.residuals.len(),
            accumulated_cpu_c: st.cpu.accumulated_c,
            accumulated_gpu_c: st.gpu.accumulated_c,
        },
        None => PassiveStatus::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_gate_requires_sustained_high_load_and_spacing() {
        let mut g = SampleGate::new(90.0, 120.0, 600.0);
        // 119 s of high load → not yet.
        for s in 0..119 {
            assert!(!g.feed(s as f32, Some(95.0)), "fired early at {s}s");
        }
        // 120th second → fires.
        assert!(g.feed(120.0, Some(95.0)));
        // Immediately again → blocked by 10-min spacing.
        for s in 121..240 {
            assert!(!g.feed(s as f32, Some(95.0)));
        }
        // A dip resets the streak.
        let mut g2 = SampleGate::new(90.0, 120.0, 600.0);
        for s in 0..60 {
            g2.feed(s as f32, Some(95.0));
        }
        g2.feed(60.0, Some(40.0)); // dip
        for s in 61..180 {
            assert!(!g2.feed(s as f32, Some(95.0)), "streak must restart");
        }
        assert!(g2.feed(181.0, Some(95.0)));
    }

    #[test]
    fn ring_buffer_caps_at_50() {
        let mut st = PassiveAxisState::default();
        for i in 0..60 {
            st.push_residual(i as f32);
        }
        assert_eq!(st.residuals.len(), 50);
        assert_eq!(st.residuals.front().copied(), Some(10.0));
    }
}
