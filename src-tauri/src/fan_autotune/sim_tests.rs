//! Closed-loop simulation tests: a first-order virtual plant behind TuneIo.
//! These are the spec §10 guarantees — convergence, honesty, degradation,
//! abort. The plant models TjMax throttling (power backs off above 89 °C, like
//! real silicon), so "hot" grid points settle into valid throttle-clamped
//! samples instead of runaway temps; the runaway-abort test disables it.

use std::collections::HashMap;

use crate::fan::{CalibPoint, FanCalibration};
use crate::fan_autotune::io::*;
use crate::fan_autotune::model::{phi, Group};
use crate::fan_autotune::run_tune;

/// Ground-truth plant — deliberately NOT constrained to the model family.
struct Plant {
    t_amb: f32,
    r_inf: f32,
    k_c: f32,
    k_x: f32,
    alpha: f32,
    tau_cpu: f32,
    p_idle: f32,
    p_load: f32,
    /// TjMax-style governor: above 89 °C the load power backs off so the die
    /// settles just over 89 instead of running away (real silicon behavior).
    throttle: bool,
    // GPU body + coupling into the CPU steady state (°C at full GPU load).
    gpu_t_amb: f32,
    gpu_r: f32,
    gpu_k: f32,
    gpu_tau: f32,
    p_gpu_idle: f32,
    p_gpu_load: f32,
    couple_c: f32,
}

impl Plant {
    fn desktop() -> Self {
        Self {
            t_amb: 28.0,
            r_inf: 0.12,
            k_c: 0.10,
            k_x: 0.04,
            alpha: 0.8,
            tau_cpu: 30.0,
            p_idle: 45.0,
            p_load: 210.0,
            throttle: true,
            gpu_t_amb: 30.0,
            gpu_r: 0.09,
            gpu_k: 0.03,
            gpu_tau: 40.0,
            p_gpu_idle: 25.0,
            p_gpu_load: 330.0,
            couple_c: 4.0,
        }
    }
    fn r_cpu(&self, w_cpu: f32, w_case: f32) -> f32 {
        self.r_inf + self.k_c * phi(w_cpu, self.alpha) + self.k_x * phi(w_case, self.alpha)
    }
    fn t_gpu_ss(&self, p: f32, w_case: f32) -> f32 {
        self.gpu_t_amb + p * (self.gpu_r + self.gpu_k * phi(w_case, 0.8))
    }
}

struct FakeIo {
    plant: Plant,
    time_s: f64,
    t_cpu: f32,
    t_gpu: f32,
    /// Live (possibly throttled) CPU power.
    p_cpu_now: f32,
    duties: HashMap<String, f32>,
    fans: Vec<(String, Group)>,
    cpu_on: bool,
    gpu_on: bool,
    gpu_start_ok: bool,
    /// Pretend a background hog keeps the system busy (precheck must fail).
    busy_background: bool,
    abort_after_s: Option<f64>,
}

impl FakeIo {
    fn new(plant: Plant) -> Self {
        let fans = vec![
            ("cpu0".to_string(), Group::Cpu),
            ("case0".to_string(), Group::Case),
            ("case1".to_string(), Group::Case),
        ];
        let t0 = plant.t_amb + plant.p_idle * plant.r_cpu(0.4, 0.4);
        let g0 = plant.t_gpu_ss(plant.p_gpu_idle, 0.4);
        let p0 = plant.p_idle;
        Self {
            plant,
            time_s: 0.0,
            t_cpu: t0,
            t_gpu: g0,
            p_cpu_now: p0,
            duties: HashMap::new(),
            fans,
            cpu_on: false,
            gpu_on: false,
            gpu_start_ok: true,
            busy_background: false,
            abort_after_s: None,
        }
    }

    fn group_w(&self, g: Group) -> f32 {
        let members: Vec<f32> = self
            .fans
            .iter()
            .filter(|(_, fg)| *fg == g)
            .map(|(id, _)| self.duties.get(id).copied().unwrap_or(40.0) / 100.0)
            .collect();
        if members.is_empty() {
            0.0
        } else {
            members.iter().sum::<f32>() / members.len() as f32
        }
    }

    fn step(&mut self, dt: f32) {
        let w_cpu = self.group_w(Group::Cpu);
        let w_case = self.group_w(Group::Case);
        // TjMax governor: PROCHOT on real silicon is effectively instantaneous
        // and strong — power snaps down so the die settles just above 89.
        // A real background hog BURNS POWER, not just utilization: idle package
        // power sits far above quiet idle, while full load stays PPT-capped.
        // This is exactly the regime that broke the 1.5×p_idle verify gate in
        // the field (inflated idle ⇒ ratio unreachable under the power cap).
        let idle_p = if self.busy_background { 150.0 } else { self.plant.p_idle };
        let p_target = if self.cpu_on { self.plant.p_load } else { idle_p };
        self.p_cpu_now = if self.plant.throttle && self.t_cpu > 89.0 {
            (p_target * (1.0 - 0.25 * (self.t_cpu - 89.0))).max(0.3 * p_target)
        } else {
            p_target
        };

        let couple = if self.gpu_on { self.plant.couple_c } else { 0.0 };
        let cpu_ss = self.plant.t_amb + self.p_cpu_now * self.plant.r_cpu(w_cpu, w_case) + couple;
        let pg = if self.gpu_on { self.plant.p_gpu_load } else { self.plant.p_gpu_idle };
        let gpu_ss = self.plant.t_gpu_ss(pg, w_case);
        self.t_cpu += (cpu_ss - self.t_cpu) * (1.0 - (-dt / self.plant.tau_cpu).exp());
        self.t_gpu += (gpu_ss - self.t_gpu) * (1.0 - (-dt / self.plant.gpu_tau).exp());
    }

    fn linear_calib(id: &str) -> FanCalibration {
        let points = (0..=10)
            .map(|i| CalibPoint { duty: i as f32 * 10.0, rpm: 2000.0 * i as f32 / 10.0 })
            .collect();
        FanCalibration {
            control_id: id.into(),
            name: id.into(),
            min_start_duty: 10.0,
            max_rpm: 2000.0,
            saturation_duty: 100.0,
            points,
            disconnected: false,
        }
    }
}

impl TuneIo for FakeIo {
    fn now_s(&self) -> f32 {
        self.time_s as f32
    }
    fn sleep_s(&mut self, s: f32) {
        let mut left = s;
        while left > 0.0 {
            let dt = left.min(0.5);
            self.step(dt);
            self.time_s += dt as f64;
            left -= dt;
        }
    }
    fn cpu_temp(&self) -> Option<f32> {
        Some(self.t_cpu)
    }
    fn cpu_power(&self) -> Option<f32> {
        Some(self.p_cpu_now)
    }
    fn gpu_temp(&self) -> Option<f32> {
        Some(self.t_gpu)
    }
    fn gpu_power(&self) -> Option<f32> {
        Some(if self.gpu_on { self.plant.p_gpu_load } else { self.plant.p_gpu_idle })
    }
    fn cpu_load_pct(&self) -> Option<f32> {
        if self.busy_background {
            // A background hog eats 55% at idle; the synthetic load still
            // saturates the rest of the cores (realistic combined ≈ 99%).
            Some(if self.cpu_on { 99.0 } else { 55.0 })
        } else {
            Some(if self.cpu_on { 99.0 } else { 3.0 })
        }
    }
    fn set_fan_duty(&mut self, id: &str, pct: f32) {
        self.duties.insert(id.into(), pct);
    }
    fn start_cpu_load(&mut self) -> bool {
        self.cpu_on = true;
        true
    }
    fn stop_cpu_load(&mut self) {
        self.cpu_on = false;
    }
    fn start_gpu_load(&mut self) -> bool {
        if self.gpu_start_ok {
            self.gpu_on = true;
        }
        self.gpu_start_ok
    }
    fn stop_gpu_load(&mut self) {
        self.gpu_on = false;
    }
    fn calibrate(&mut self, ids: &[String]) -> Vec<FanCalibration> {
        ids.iter().map(|id| Self::linear_calib(id)).collect()
    }
    fn emit_progress(&self, _p: &AutoTuneProgress) {}
    fn abort_requested(&self) -> bool {
        self.abort_after_s.map(|t| self.time_s > t).unwrap_or(false)
    }
    fn wall_jump_s(&self) -> f32 {
        0.0
    }
}

fn params() -> AutoTuneParams {
    let mut groups = HashMap::new();
    groups.insert("cpu0".to_string(), Group::Cpu);
    groups.insert("case0".to_string(), Group::Case);
    groups.insert("case1".to_string(), Group::Case);
    AutoTuneParams {
        target_temp_c: 85.0,
        target_gpu_temp_c: 80.0,
        quiet_floor_pct: 25.0,
        noise_ceil_pct: 100.0,
        groups,
        reuse_calibration: None,
        allow_background_load: false,
    }
}

fn expect_done(outcome: AutoTuneOutcome) -> Box<AutoTuneResult> {
    match outcome {
        AutoTuneOutcome::Done(r) => r,
        AutoTuneOutcome::Aborted(a) => panic!("aborted in {}: {}", a.phase, a.reason_en),
    }
}

#[test]
fn happy_path_converges_on_air_cooler() {
    let mut io = FakeIo::new(Plant::desktop());
    let r = expect_done(run_tune(&mut io, &params()));
    assert!(r.validation.converged, "t_v {}", r.validation.t_v);
    assert!((r.validation.t_v - r.effective_target).abs() <= 1.5);
    assert_eq!(r.effective_target, 85.0, "fully feasible — no relaxation");
    assert!(r
        .warnings
        .iter()
        .all(|w| w.kind != "coolerInsufficient" && w.kind != "ceilingInsufficient"));
    assert!(r.grid.iter().filter(|p| !p.skipped).count() >= 6);
    assert!(r.model_gpu.is_some() && r.effective_target_gpu.is_some());
    assert_eq!(r.curves.len(), 3);
    assert!(r
        .curves
        .iter()
        .filter(|c| c.group == Group::Case)
        .all(|c| !c.curve2.is_empty()));
    assert!(r.curves.iter().filter(|c| c.group == Group::Cpu).all(|c| c.curve2.is_empty()));
    assert!(r.gpu_cpu_coupling_c.unwrap_or(0.0) > 0.5, "GPU→CPU coupling should be visible");
}

#[test]
fn high_inertia_aio_still_converges() {
    let plant = Plant { tau_cpu: 150.0, ..Plant::desktop() };
    let mut io = FakeIo::new(plant);
    let r = expect_done(run_tune(&mut io, &params()));
    assert!((r.validation.t_v - r.effective_target).abs() <= 2.0, "t_v {}", r.validation.t_v);
}

#[test]
fn mismatched_plant_is_pulled_in_by_validation() {
    // α=1.4 is outside the fit family — model is wrong, validation must correct.
    let plant = Plant { alpha: 1.4, ..Plant::desktop() };
    let mut io = FakeIo::new(plant);
    let r = expect_done(run_tune(&mut io, &params()));
    assert!(
        (r.validation.t_v - r.effective_target).abs() <= 1.5,
        "t_v {} vs eff {}",
        r.validation.t_v,
        r.effective_target
    );
}

#[test]
fn weak_cooler_yields_honest_warning_not_abort() {
    // Throttle-governed weak cooler: every loaded point settles near TjMax.
    let plant = Plant { r_inf: 0.26, ..Plant::desktop() };
    let mut io = FakeIo::new(plant);
    let mut p = params();
    p.target_temp_c = 70.0;
    let r = expect_done(run_tune(&mut io, &p));
    assert!(r
        .warnings
        .iter()
        .any(|w| w.kind == "coolerInsufficient" || w.kind == "ceilingInsufficient"));
    assert!(r.effective_target > 70.0);
}

#[test]
fn gpu_axis_failure_degrades_without_killing_cpu_result() {
    let mut io = FakeIo::new(Plant::desktop());
    io.gpu_start_ok = false;
    let r = expect_done(run_tune(&mut io, &params()));
    assert!(r.model_gpu.is_none());
    assert!(r.warnings.iter().any(|w| w.kind == "gpuAxisSkipped"));
    assert!(r.curves.iter().all(|c| c.curve2.is_empty()));
    assert!(r.validation.converged);
}

#[test]
fn user_abort_is_clean() {
    let mut io = FakeIo::new(Plant::desktop());
    io.abort_after_s = Some(90.0);
    match run_tune(&mut io, &params()) {
        AutoTuneOutcome::Aborted(a) => assert!(!a.phase.is_empty()),
        AutoTuneOutcome::Done(_) => panic!("should have aborted"),
    }
}

#[test]
fn runaway_overtemp_aborts_with_fans_at_full() {
    // Throttle disabled = silicon's own guard is lying/broken; the 91 °C
    // runaway line must fire and pin every fan at 100% on the way out.
    let plant = Plant { t_amb: 45.0, r_inf: 0.30, throttle: false, ..Plant::desktop() };
    let mut io = FakeIo::new(plant);
    match run_tune(&mut io, &params()) {
        AutoTuneOutcome::Aborted(a) => {
            assert!(a.reason_en.to_lowercase().contains("temperature"), "{}", a.reason_en);
            for (id, _) in io.fans.clone() {
                assert_eq!(io.duties.get(&id).copied().unwrap_or(0.0), 100.0, "{id} not at full");
            }
        }
        AutoTuneOutcome::Done(_) => panic!("should have aborted"),
    }
}

#[test]
fn busy_system_fails_precheck() {
    let mut io = FakeIo::new(Plant::desktop());
    io.busy_background = true;
    match run_tune(&mut io, &params()) {
        AutoTuneOutcome::Aborted(a) => assert_eq!(a.phase, "precheck"),
        AutoTuneOutcome::Done(_) => panic!("should have aborted in precheck"),
    }
}

#[test]
fn busy_system_override_completes_with_warning() {
    // The user's settings toggle: a busy system may tune anyway — the
    // quiescence gate downgrades from abort to an honest accuracy warning,
    // while every safety net (runaway line, load verify, validation) stays.
    let mut io = FakeIo::new(Plant::desktop());
    io.busy_background = true;
    let mut p = params();
    p.allow_background_load = true;
    let r = expect_done(run_tune(&mut io, &p));
    assert!(
        r.warnings.iter().any(|w| w.kind == "busySystem"),
        "expected a busySystem accuracy warning"
    );
    assert!(r.validation.converged, "t_v {}", r.validation.t_v);
}
