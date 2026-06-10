//! Fan auto-tune: closed-loop thermal characterization → curve synthesis.
//! Spec: docs/superpowers/specs/2026-06-10-fan-autotune-design.md
//!
//! `run_tune` is a synchronous state machine living entirely behind `TuneIo`
//! (its only window to the world), which is what makes the closed-loop
//! simulation tests in `sim_tests.rs` possible.

pub mod io;
pub mod model;
pub mod passive;
#[cfg(test)]
mod sim_tests;

use std::collections::HashMap;

use crate::fan::{interp, FanCalibration};
use io::*;
use model::*;

/// RUNAWAY line for the CPU during measurement (°C). Real silicon throttles at
/// TjMax (89 on the 9950X3D), so genuinely hot grid points settle just above
/// 89 at reduced power — that is a VALID throttle-clamped (P, w, T) sample,
/// not an emergency. 91 only trips when the silicon guard is broken or a
/// sensor lies, and it is deliberately decoupled from the user's target so an
/// ambitious target + weak cooler still completes measurement and earns an
/// honest "cooler insufficient" warning instead of a mid-sweep abort.
const RUNAWAY_ABORT_C: f32 = 91.0;
/// GPU sweep line — only ever degrades the GPU axis, never aborts the tune.
const GPU_ABORT_C: f32 = 92.0;
/// Whole-tune wall-clock cap (spec §3).
const HARD_CAP_S: f32 = 45.0 * 60.0;
/// Grid axes (spec §3 阶段 3).
const GRID_WCPU: [f32; 4] = [1.0, 0.75, 0.5, 0.35];
const GRID_WCASE: [f32; 3] = [1.0, 0.6, 0.3];
/// Skip grid points the incremental fit predicts at/above this (time saver —
/// they'd just settle at the throttle plateau and teach the fit little).
const SKIP_PREDICT_C: f32 = RUNAWAY_ABORT_C - 2.0;
/// Never skip until this many points are actually measured: the 4-parameter
/// fit needs data more than the sweep needs minutes.
const MIN_MEASURED_BEFORE_SKIP: usize = 6;
/// Proportional band (spec §5.4) and validation drive ramp per 2 s tick.
pub(crate) const BAND_C: f32 = 8.0;
const DRIVE_RAMP_STEP: f32 = 8.0;

struct Abort {
    phase: &'static str,
    reason_zh: String,
    reason_en: String,
    /// Overtemp aborts pin every fan at 100% before returning.
    emergency: bool,
}

fn abort(phase: &'static str, zh: &str, en: &str) -> Abort {
    Abort { phase, reason_zh: zh.into(), reason_en: en.into(), emergency: false }
}

/// Everything the phases share.
struct Tune<'a> {
    io: &'a mut dyn TuneIo,
    params: AutoTuneParams,
    fans: Vec<(String, Group)>,
    calibs: Vec<FanCalibration>,
    warnings: Vec<TuneWarning>,
    floor: f32,
    ceil: f32,
    has_case: bool,
    gpu_axis: bool,
    phase: &'static str,
    step: u32,
    step_total: u32,
}

impl<'a> Tune<'a> {
    fn emit(&self, note: Option<String>, w_cpu: Option<f32>, w_case: Option<f32>) {
        self.io.emit_progress(&AutoTuneProgress {
            phase: self.phase.into(),
            step: self.step,
            step_total: self.step_total,
            cpu_temp: self.io.cpu_temp(),
            cpu_power: self.io.cpu_power(),
            gpu_temp: self.io.gpu_temp(),
            gpu_power: self.io.gpu_power(),
            w_cpu,
            w_case,
            eta_s: None,
            note,
        });
    }

    fn duty_for(&self, id: &str, w: f32) -> f32 {
        match self.calibs.iter().find(|c| c.control_id == id) {
            Some(c) => duty_for_rpm_fraction(&c.points, w, c.min_start_duty, c.max_rpm),
            None => (w * 100.0).clamp(MIN_SAFE_DUTY, 100.0),
        }
    }

    fn set_group_w(&mut self, w_cpu: f32, w_case: f32) {
        for (id, g) in self.fans.clone() {
            let w = if g == Group::Cpu { w_cpu } else { w_case };
            let duty = self.duty_for(&id, w);
            self.io.set_fan_duty(&id, duty);
        }
    }

    fn all_fans_full(&mut self) {
        for (id, _) in self.fans.clone() {
            self.io.set_fan_duty(&id, 100.0);
        }
    }

    /// One 1 Hz safety heartbeat. `cpu_line` None = skip the temp check.
    fn safety_tick(&mut self, cpu_line: Option<f32>, misses: &mut u32) -> Result<(), Abort> {
        if self.io.abort_requested() {
            return Err(abort(self.phase, "用户中止", "aborted by user"));
        }
        if self.io.now_s() > HARD_CAP_S {
            return Err(abort(self.phase, "总时长超过 45 分钟上限", "exceeded the 45-minute hard cap"));
        }
        if self.io.wall_jump_s() > 10.0 {
            return Err(abort(self.phase, "检测到系统休眠/恢复", "system suspend/resume detected"));
        }
        match self.io.cpu_temp() {
            Some(t) => {
                *misses = 0;
                if let Some(line) = cpu_line {
                    if t >= line {
                        return Err(Abort {
                            phase: self.phase,
                            reason_zh: format!("温度失控:CPU {t:.1}°C ≥ {line:.0}°C,已全速并中止"),
                            reason_en: format!(
                                "temperature runaway: CPU {t:.1}°C ≥ {line:.0}°C — fans forced to full, tune aborted"
                            ),
                            emergency: true,
                        });
                    }
                }
            }
            None => {
                *misses += 1;
                if *misses > 5 {
                    return Err(abort(self.phase, "CPU 温度读数丢失", "lost the CPU temperature reading"));
                }
            }
        }
        Ok(())
    }

    /// Settle the CPU temperature; returns (t_ss, saturated, p_mean).
    fn settle_cpu(&mut self, line: f32, min_dwell: f32, max_dwell: f32) -> Result<(f32, bool, f32), Abort> {
        let mut det = SteadyDetector::new(min_dwell, max_dwell);
        let (mut p_sum, mut p_n, mut misses) = (0.0_f32, 0u32, 0u32);
        let t0 = self.io.now_s();
        loop {
            self.io.sleep_s(1.0);
            self.safety_tick(Some(line), &mut misses)?;
            if let Some(p) = self.io.cpu_power() {
                p_sum += p;
                p_n += 1;
            }
            if let Some(t) = self.io.cpu_temp() {
                match det.push(self.io.now_s() - t0, t) {
                    Steady::Pending => {}
                    Steady::Steady(v) => return Ok((v, false, p_sum / p_n.max(1) as f32)),
                    Steady::Saturated(v) => return Ok((v, true, p_sum / p_n.max(1) as f32)),
                }
            }
        }
    }

    /// Settle the GPU temperature. Outer Err = tune abort (CPU safety stays
    /// armed); inner None = GPU trouble → caller skips the axis (degrade).
    fn settle_gpu(&mut self, min_dwell: f32, max_dwell: f32) -> Result<Option<(f32, bool, f32, f32)>, Abort> {
        let mut det = SteadyDetector::new(min_dwell, max_dwell);
        let (mut p_sum, mut p_n, mut misses) = (0.0_f32, 0u32, 0u32);
        let t0 = self.io.now_s();
        loop {
            self.io.sleep_s(1.0);
            self.safety_tick(Some(RUNAWAY_ABORT_C), &mut misses)?;
            let Some(tg) = self.io.gpu_temp() else { return Ok(None) };
            if tg >= GPU_ABORT_C {
                // Cool down hard for 30 s, then degrade the axis (spec §3 安全网).
                self.all_fans_full();
                self.io.stop_gpu_load();
                self.io.sleep_s(30.0);
                return Ok(None);
            }
            if let Some(p) = self.io.gpu_power() {
                p_sum += p;
                p_n += 1;
            }
            match det.push(self.io.now_s() - t0, tg) {
                Steady::Pending => {}
                Steady::Steady(v) => {
                    let t_cpu = self.io.cpu_temp().unwrap_or(0.0);
                    return Ok(Some((v, false, p_sum / p_n.max(1) as f32, t_cpu)));
                }
                Steady::Saturated(v) => {
                    let t_cpu = self.io.cpu_temp().unwrap_or(0.0);
                    return Ok(Some((v, true, p_sum / p_n.max(1) as f32, t_cpu)));
                }
            }
        }
    }

    /// Fans to full until the CPU drops below `t_below` (validation entry: the
    /// grid leaves the die hot with fans low; starting the drive from there
    /// would trip the safety line before the curve has any say).
    fn cooldown_below(&mut self, t_below: f32, max_s: f32) -> Result<(), Abort> {
        self.all_fans_full();
        let t0 = self.io.now_s();
        let mut misses = 0u32;
        while self.io.now_s() - t0 < max_s {
            self.io.sleep_s(2.0);
            self.safety_tick(Some(RUNAWAY_ABORT_C), &mut misses)?;
            if self.io.cpu_temp().map(|t| t < t_below).unwrap_or(false) {
                break;
            }
        }
        Ok(())
    }

    /// Drive fans by the synthesized curves until the CPU temp settles
    /// (validation loop). Returns (t_v, saturated, duty peak-to-peak over the
    /// last ~60 s of the CPU group's first fan, last GPU temp).
    fn drive_until_steady(
        &mut self,
        curves: &[TunedFanCurve],
        line: f32,
        max_s: f32,
    ) -> Result<(f32, bool, f32, Option<f32>), Abort> {
        let mut det = SteadyDetector::new(60.0, max_s);
        let mut applied: HashMap<String, f32> = HashMap::new();
        let mut history: Vec<f32> = Vec::new();
        let watch_id = self
            .fans
            .iter()
            .find(|(_, g)| *g == Group::Cpu)
            .map(|(id, _)| id.clone())
            .unwrap_or_default();
        let mut misses = 0u32;
        let t0 = self.io.now_s();
        loop {
            self.io.sleep_s(2.0);
            self.safety_tick(Some(line), &mut misses)?;
            let Some(t_cpu) = self.io.cpu_temp() else { continue };
            let t_gpu = self.io.gpu_temp();
            for c in curves {
                let mut target = interp(&c.curve, t_cpu);
                if !c.curve2.is_empty() {
                    if let Some(tg) = t_gpu {
                        target = target.max(interp(&c.curve2, tg));
                    }
                }
                let target = target.clamp(c.min_duty.max(MIN_SAFE_DUTY), 100.0);
                let cur = applied.get(&c.control_id).copied().unwrap_or(target);
                let next = if (target - cur).abs() <= DRIVE_RAMP_STEP {
                    target
                } else if target > cur {
                    cur + DRIVE_RAMP_STEP
                } else {
                    cur - DRIVE_RAMP_STEP
                };
                applied.insert(c.control_id.clone(), next);
                self.io.set_fan_duty(&c.control_id, next);
                if c.control_id == watch_id {
                    history.push(next);
                }
            }
            match det.push(self.io.now_s() - t0, t_cpu) {
                Steady::Pending => {}
                Steady::Steady(v) | Steady::Saturated(v) => {
                    let sat = self.io.now_s() - t0 >= max_s;
                    let tail = &history[history.len().saturating_sub(30)..];
                    let pp = tail.iter().copied().fold(f32::MIN, f32::max)
                        - tail.iter().copied().fold(f32::MAX, f32::min);
                    return Ok((v, sat, pp.max(0.0), t_gpu));
                }
            }
        }
    }
}

/// The whole tune, spec §3 state machine. Synchronous; call on a blocking
/// thread with engine exclusivity already held (or from tests with a FakeIo).
pub fn run_tune(io: &mut dyn TuneIo, raw: &AutoTuneParams) -> AutoTuneOutcome {
    let params = match raw.sanitized() {
        Ok(p) => p,
        Err(e) => {
            return AutoTuneOutcome::Aborted(AbortInfo {
                phase: "precheck".into(),
                reason_zh: format!("参数无效:{e}"),
                reason_en: format!("invalid parameters: {e}"),
            })
        }
    };
    let mut fans: Vec<(String, Group)> = params.groups.iter().map(|(k, v)| (k.clone(), *v)).collect();
    fans.sort_by(|a, b| a.0.cmp(&b.0));
    let mut t = Tune {
        floor: params.quiet_floor_pct / 100.0,
        ceil: params.noise_ceil_pct / 100.0,
        has_case: fans.iter().any(|(_, g)| *g == Group::Case),
        gpu_axis: false,
        io,
        params,
        fans,
        calibs: Vec::new(),
        warnings: Vec::new(),
        phase: "precheck",
        step: 0,
        step_total: 0,
    };

    match tune_body(&mut t) {
        Ok(result) => AutoTuneOutcome::Done(result),
        Err(a) => {
            if a.emergency {
                t.all_fans_full();
            }
            t.io.stop_cpu_load();
            t.io.stop_gpu_load();
            AutoTuneOutcome::Aborted(AbortInfo {
                phase: a.phase.into(),
                reason_zh: a.reason_zh,
                reason_en: a.reason_en,
            })
        }
    }
}

fn tune_body(t: &mut Tune) -> Result<Box<AutoTuneResult>, Abort> {
    // --- Precheck (spec §3) -------------------------------------------------
    t.phase = "precheck";
    t.emit(None, None, None);
    for _ in 0..10 {
        if t.io.cpu_temp().is_some() && t.io.cpu_power().is_some() {
            break;
        }
        t.io.sleep_s(1.0);
    }
    if t.io.cpu_temp().is_none() || t.io.cpu_power().is_none() {
        return Err(abort(
            "precheck",
            "传感器服务未就绪(无 CPU 温度/功耗)",
            "sensor service not ready (no CPU temp/power)",
        ));
    }
    t.gpu_axis = t.io.gpu_temp().is_some() && t.io.gpu_power().is_some();
    if !t.gpu_axis {
        t.warnings.push(TuneWarning {
            kind: "gpuAxisSkipped".into(),
            message_zh: "未检测到 GPU 温度/功耗,GPU 轴跳过(机箱风扇只按 CPU 温度驱动)".into(),
            message_en: "No GPU temp/power detected — GPU axis skipped (case fans follow CPU temp only)".into(),
            achievable_c: None,
        });
    }
    // Quiescence: 30 s of near-idle CPU (spec: avg < 10%, no sample > 25%).
    let (mut sum, mut n, mut peak, mut misses) = (0.0_f32, 0u32, 0.0_f32, 0u32);
    for _ in 0..30 {
        t.io.sleep_s(1.0);
        t.safety_tick(None, &mut misses)?;
        if let Some(l) = t.io.cpu_load_pct() {
            sum += l;
            n += 1;
            peak = peak.max(l);
        }
    }
    if n > 0 && (sum / n as f32 >= 10.0 || peak >= 25.0) {
        let (avg, pk) = (sum / n as f32, peak);
        if t.params.allow_background_load {
            // Settings override: proceed, but record the accuracy caveat. The
            // model uses MEASURED power so a steady background load mostly
            // self-corrects; a fluctuating one shows up as longer settling and
            // possibly an unconverged-validation warning — all honest outcomes.
            t.warnings.push(TuneWarning {
                kind: "busySystem".into(),
                message_zh: format!(
                    "标定期间系统有后台负载(均值 {avg:.0}%,峰值 {pk:.0}%),基线与精度可能受影响;若结果偏差大,建议在空闲时重新调优"
                ),
                message_en: format!(
                    "Background load present during tuning (avg {avg:.0}%, peak {pk:.0}%); baseline accuracy may suffer — re-tune on an idle system if results drift"
                ),
                achievable_c: None,
            });
        } else {
            return Err(abort(
                "precheck",
                "系统不空闲:请先关闭后台负载再开始调优(或在 设置 中开启「允许后台负载时调优」)",
                "system busy: close background workloads first (or enable \"tune with background load\" in Settings)",
            ));
        }
    }

    // --- FanCalib (spec §3 阶段 1) --------------------------------------------
    t.phase = "fanCalib";
    t.emit(None, None, None);
    let ids: Vec<String> = t.fans.iter().map(|(id, _)| id.clone()).collect();
    let reuse_ok = t
        .params
        .reuse_calibration
        .as_ref()
        .map(|cal| ids.iter().all(|id| cal.iter().any(|c| &c.control_id == id && !c.disconnected)))
        .unwrap_or(false);
    t.calibs = if reuse_ok {
        t.params.reuse_calibration.clone().unwrap()
    } else {
        t.io.calibrate(&ids)
    };
    for c in t.calibs.clone() {
        if c.disconnected {
            t.warnings.push(TuneWarning {
                kind: "fanDisconnected".into(),
                message_zh: format!("{}:校准时未检测到转速,已从调优中剔除", c.name),
                message_en: format!("{}: no RPM during calibration — excluded from tuning", c.name),
                achievable_c: None,
            });
            t.fans.retain(|(id, _)| id != &c.control_id);
        }
    }
    t.has_case = t.fans.iter().any(|(_, g)| *g == Group::Case);
    if !t.fans.iter().any(|(_, g)| *g == Group::Cpu) {
        return Err(abort("fanCalib", "CPU 组没有可用风扇", "no usable fan left in the CPU group"));
    }

    // --- Baseline (spec §3 阶段 2) --------------------------------------------
    t.phase = "baseline";
    let w0 = t.floor.max(0.4);
    t.set_group_w(w0, w0);
    t.emit(None, Some(w0), Some(w0));
    let (t_idle, _, p_idle) = t.settle_cpu(RUNAWAY_ABORT_C, 35.0, 120.0)?;
    let baseline = Baseline {
        t_idle,
        p_idle,
        t_gpu_idle: t.io.gpu_temp(),
        p_gpu_idle: t.io.gpu_power(),
    };

    // --- GridSweep (spec §3 阶段 3) -------------------------------------------
    t.phase = "gridSweep";
    if !t.io.start_cpu_load() {
        return Err(abort("gridSweep", "无法启动 CPU 负载", "failed to start the CPU load"));
    }
    let mut ok = false;
    let mut misses = 0u32;
    for _ in 0..15 {
        t.io.sleep_s(1.0);
        t.safety_tick(Some(RUNAWAY_ABORT_C), &mut misses)?;
        let load_ok = t.io.cpu_load_pct().map(|l| l >= 95.0).unwrap_or(false);
        let power_ok = t.io.cpu_power().map(|p| p >= 1.5 * baseline.p_idle).unwrap_or(false);
        if load_ok && power_ok {
            ok = true;
            break;
        }
    }
    if !ok {
        t.io.stop_cpu_load();
        return Err(abort("gridSweep", "负载未生效(占用或功耗未达标)", "the synthetic load did not take effect"));
    }

    let case_axis: &[f32] = if t.has_case { &GRID_WCASE } else { &[0.0] };
    t.step_total = (GRID_WCPU.len() * case_axis.len()) as u32;
    let mut grid: Vec<GridPoint> = Vec::new();
    for &wc in &GRID_WCPU {
        for &wx in case_axis {
            t.step += 1;
            // Incremental fit → skip points predicted to settle at the
            // throttle plateau (they teach the fit little and waste minutes).
            // Prediction uses the UNSHIFTED model — the conservative shift is
            // a curve-safety bias and would over-prune the grid.
            if grid.iter().filter(|p| !p.skipped).count() >= MIN_MEASURED_BEFORE_SKIP {
                let samples = fit_samples(&grid, &baseline, w0);
                if let Some(m) = fit_cpu_model(&samples, t.has_case) {
                    let p_hint = grid
                        .iter()
                        .filter(|p| !p.skipped)
                        .map(|p| p.p_avg)
                        .fold(0.0, f32::max);
                    if m.predict(p_hint, wc, wx) - m.conservative_shift >= SKIP_PREDICT_C {
                        grid.push(GridPoint {
                            w_cpu: wc,
                            w_case: wx,
                            t_ss: 0.0,
                            p_avg: 0.0,
                            saturated: false,
                            skipped: true,
                        });
                        t.emit(Some("skip (predicted too hot)".into()), Some(wc), Some(wx));
                        continue;
                    }
                }
            }
            t.set_group_w(wc, wx);
            t.emit(None, Some(wc), Some(wx));
            let (t_ss, saturated, p_avg) = t.settle_cpu(RUNAWAY_ABORT_C, 35.0, 120.0)?;
            grid.push(GridPoint { w_cpu: wc, w_case: wx, t_ss, p_avg, saturated, skipped: false });
        }
    }
    t.io.stop_cpu_load();

    // --- GpuSweep (spec §3 阶段 3b) -------------------------------------------
    t.phase = "gpuSweep";
    t.step = 0;
    t.step_total = GRID_WCASE.len() as u32;
    let mut gpu_grid: Vec<GpuGridPoint> = Vec::new();
    if t.gpu_axis && t.has_case {
        if !t.io.start_gpu_load() {
            t.gpu_axis = false;
            t.warnings.push(TuneWarning {
                kind: "gpuAxisSkipped".into(),
                message_zh: "GPU 负载启动失败,GPU 轴跳过".into(),
                message_en: "GPU load failed to start — GPU axis skipped".into(),
                achievable_c: None,
            });
        } else {
            // Verify the load took (gpuPower ≥ 1.5 × idle, fallback ≥ 60 W).
            let p_gate = baseline.p_gpu_idle.map(|p| 1.5 * p).unwrap_or(60.0);
            let mut ok = false;
            let mut misses = 0u32;
            for _ in 0..20 {
                t.io.sleep_s(1.0);
                t.safety_tick(Some(RUNAWAY_ABORT_C), &mut misses)?;
                if t.io.gpu_power().map(|p| p >= p_gate).unwrap_or(false) {
                    ok = true;
                    break;
                }
            }
            if !ok {
                t.io.stop_gpu_load();
                t.gpu_axis = false;
                t.warnings.push(TuneWarning {
                    kind: "gpuAxisSkipped".into(),
                    message_zh: "GPU 负载未生效,GPU 轴跳过".into(),
                    message_en: "GPU load did not take effect — GPU axis skipped".into(),
                    achievable_c: None,
                });
            } else {
                for &wx in &GRID_WCASE {
                    t.step += 1;
                    t.set_group_w(0.5, wx);
                    t.emit(None, Some(0.5), Some(wx));
                    match t.settle_gpu(35.0, 120.0)? {
                        Some((t_gpu_ss, _sat, p_gpu_avg, t_cpu)) => {
                            gpu_grid.push(GpuGridPoint { w_case: wx, t_gpu_ss, p_gpu_avg, t_cpu });
                        }
                        None => {
                            t.gpu_axis = false;
                            t.warnings.push(TuneWarning {
                                kind: "gpuAxisSkipped".into(),
                                message_zh: "GPU 阶段中断(温度/读数),GPU 轴跳过".into(),
                                message_en: "GPU phase interrupted (temp/reading) — GPU axis skipped".into(),
                                achievable_c: None,
                            });
                            break;
                        }
                    }
                }
                t.io.stop_gpu_load();
            }
        }
    } else if t.gpu_axis && !t.has_case {
        t.gpu_axis = false; // no case fans — nothing for a GPU curve to drive
    }

    // --- Fit (spec §4) --------------------------------------------------------
    t.phase = "fit";
    t.emit(None, None, None);
    let samples = fit_samples(&grid, &baseline, w0);
    let mut model = fit_cpu_model(&samples, t.has_case).ok_or_else(|| {
        abort("fit", "测量数据不足,模型拟合失败", "not enough measurements to fit the model")
    })?;
    let mut model_gpu: Option<GpuModel> = None;
    if t.gpu_axis && gpu_grid.len() >= 3 {
        let mut gs: Vec<GpuFitSample> = gpu_grid
            .iter()
            .map(|p| GpuFitSample { p: p.p_gpu_avg, w_case: p.w_case, t: p.t_gpu_ss })
            .collect();
        if let (Some(tg), Some(pg)) = (baseline.t_gpu_idle, baseline.p_gpu_idle) {
            gs.push(GpuFitSample { p: pg, w_case: w0, t: tg });
        }
        model_gpu = fit_gpu_model(&gs);
        if model_gpu.is_none() {
            t.gpu_axis = false;
            t.warnings.push(TuneWarning {
                kind: "gpuAxisSkipped".into(),
                message_zh: "GPU 模型拟合失败,GPU 轴跳过".into(),
                message_en: "GPU model fit failed — GPU axis skipped".into(),
                achievable_c: None,
            });
        }
    } else {
        t.gpu_axis = false;
    }

    // --- Synthesize (spec §5) ---------------------------------------------------
    t.phase = "synthesize";
    t.emit(None, None, None);
    let p_design = grid.iter().filter(|p| !p.skipped).map(|p| p.p_avg).fold(0.0, f32::max);
    let p_design_gpu = gpu_grid.iter().map(|p| p.p_gpu_avg).fold(0.0, f32::max);
    let g_rpm = group_rpm(&t.fans, &t.calibs);
    let mut band = BAND_C;
    let mut spin_down = 30.0_f32;

    let mut cpu_synth = synth_cpu(&model, band, p_design, &t.params, t.floor, t.ceil, &g_rpm, t.has_case);
    let mut gpu_synth = match (&model_gpu, t.gpu_axis) {
        (Some(mg), true) => Some(synthesize_gpu(
            mg,
            p_design_gpu,
            t.params.target_gpu_temp_c,
            t.floor,
            t.ceil,
        )),
        _ => None,
    };
    let mut curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);

    // --- Validate (spec §6) -------------------------------------------------------
    t.phase = "validate";
    t.emit(None, None, None);
    // The grid just ended hot with low airflow — cool below the band before
    // handing control to the curve, or the safety line trips immediately.
    t.cooldown_below(cpu_synth.effective_target - 2.0, 90.0)?;
    if !t.io.start_cpu_load() {
        return Err(abort("validate", "无法启动 CPU 负载", "failed to start the CPU load"));
    }
    let validate_started = t.io.now_s();
    let mut iterations = 0u32;
    let mut oscillation_fixed = false;
    let mut cold_done = false;
    let mut t_v;
    loop {
        let line = (cpu_synth.effective_target + 6.0).min(RUNAWAY_ABORT_C);
        let (v, _sat, osc_pp, _tg) = t.drive_until_steady(&curves, line, 240.0)?;
        t_v = v;
        let eff = cpu_synth.effective_target;
        let budget_left = t.io.now_s() - validate_started < 12.0 * 60.0 - 250.0;
        if osc_pp > 12.0 && !oscillation_fixed && budget_left {
            band += 2.0;
            spin_down -= 10.0;
            oscillation_fixed = true;
            cpu_synth = synth_cpu(&model, band, p_design, &t.params, t.floor, t.ceil, &g_rpm, t.has_case);
            curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);
            continue;
        }
        if t_v - eff > 1.5 && iterations < 2 && budget_left {
            // Newton-ish: ∂T/∂t_off = 1, so one bump per round converges fast.
            model.t_off += t_v - eff;
            iterations += 1;
            cpu_synth = synth_cpu(&model, band, p_design, &t.params, t.floor, t.ceil, &g_rpm, t.has_case);
            curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);
            continue;
        }
        if eff - t_v > 4.0 && !cold_done && budget_left {
            model.t_off -= (eff - t_v).min(4.0);
            cold_done = true;
            cpu_synth = synth_cpu(&model, band, p_design, &t.params, t.floor, t.ceil, &g_rpm, t.has_case);
            curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);
            continue;
        }
        break;
    }
    let converged = (t_v - cpu_synth.effective_target).abs() <= 1.5;
    if !converged {
        t.warnings.push(TuneWarning {
            kind: "validationUnconverged".into(),
            message_zh: format!(
                "验证未完全收敛:实测 {t_v:.1}°C(目标 {:.1}°C),被动学习会继续收口",
                cpu_synth.effective_target
            ),
            message_en: format!(
                "Validation not fully converged: measured {t_v:.1}°C (target {:.1}°C); passive learning will keep closing the gap",
                cpu_synth.effective_target
            ),
            achievable_c: Some(t_v),
        });
    }

    // --- CombinedValidate (spec §6) -------------------------------------------------
    let mut combined_t_cpu = None;
    let mut combined_t_gpu = None;
    if t.gpu_axis && gpu_synth.is_some() && t.io.start_gpu_load() {
        t.phase = "combinedValidate";
        t.emit(None, None, None);
        let line = (cpu_synth.effective_target + 6.0).min(RUNAWAY_ABORT_C);
        let (v0_cpu, _, _, v0_gpu) = t.drive_until_steady(&curves, line, 240.0)?;
        let (mut v_cpu, mut v_gpu) = (v0_cpu, v0_gpu);
        let eff = cpu_synth.effective_target;
        let eff_g = gpu_synth.as_ref().map(|g| g.effective_target_g).unwrap_or(0.0);
        let cpu_over = v_cpu - eff > 1.5;
        let gpu_over = v_gpu.map(|g| g - eff_g > 2.0).unwrap_or(false);
        if cpu_over || gpu_over {
            if cpu_over {
                model.t_off += v_cpu - eff;
                cpu_synth = synth_cpu(&model, band, p_design, &t.params, t.floor, t.ceil, &g_rpm, t.has_case);
            }
            if gpu_over {
                if let (Some(mg), Some(gs)) = (model_gpu.as_mut(), v_gpu) {
                    mg.t_off_g += gs - eff_g;
                    gpu_synth = Some(synthesize_gpu(
                        mg,
                        p_design_gpu,
                        t.params.target_gpu_temp_c,
                        t.floor,
                        t.ceil,
                    ));
                }
            }
            curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);
            let (rv_cpu, _, _, rv_gpu) = t.drive_until_steady(&curves, line, 240.0)?;
            v_cpu = rv_cpu;
            v_gpu = rv_gpu;
            let still_over = v_cpu - cpu_synth.effective_target > 1.5
                || v_gpu
                    .map(|g| {
                        gpu_synth
                            .as_ref()
                            .map(|s| g - s.effective_target_g > 2.0)
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
            if still_over {
                t.warnings.push(TuneWarning {
                    kind: "combinedOverTarget".into(),
                    message_zh: format!(
                        "双满载极端工况下实测 CPU {v_cpu:.1}°C / GPU {:.1}°C(单满载有保证)",
                        v_gpu.unwrap_or(0.0)
                    ),
                    message_en: format!(
                        "Under simultaneous CPU+GPU full load: CPU {v_cpu:.1}°C / GPU {:.1}°C (single-load targets are guaranteed)",
                        v_gpu.unwrap_or(0.0)
                    ),
                    achievable_c: Some(v_cpu),
                });
            }
        }
        combined_t_cpu = Some(v_cpu);
        combined_t_gpu = v_gpu;
        t.io.stop_gpu_load();
    }
    t.io.stop_cpu_load();

    // --- Assemble -------------------------------------------------------------------
    t.phase = "done";
    if let Some(w) = cpu_synth.warning.clone() {
        t.warnings.push(w);
    }
    if let Some(w) = gpu_synth.as_ref().and_then(|g| g.warning.clone()) {
        t.warnings.push(w);
    }
    let coupling_peak = gpu_grid.iter().map(|p| p.t_cpu).fold(f32::MIN, f32::max);
    let gpu_cpu_coupling_c =
        (!gpu_grid.is_empty()).then(|| (coupling_peak - baseline.t_idle).max(0.0));
    let result = AutoTuneResult {
        params: t.params.clone(),
        calibrations: t.calibs.clone(),
        baseline,
        grid,
        gpu_grid: gpu_grid.clone(),
        model,
        model_gpu,
        p_design,
        p_design_gpu: (p_design_gpu > 0.0).then_some(p_design_gpu),
        effective_target: cpu_synth.effective_target,
        effective_target_gpu: gpu_synth.as_ref().map(|g| g.effective_target_g),
        gpu_cpu_coupling_c,
        w_points: cpu_synth.points.clone(),
        gpu_w_points: gpu_synth.as_ref().map(|g| g.points.clone()),
        curves,
        cpu_source_id: None, // filled by the command wrapper (needs the live snapshot)
        gpu_source_id: None,
        validation: ValidationReport {
            t_v,
            iterations,
            oscillation_fixed,
            converged,
            combined_t_cpu,
            combined_t_gpu,
        },
        warnings: t.warnings.clone(),
        finished_at_ms: 0, // filled by the command wrapper (wall clock)
    };
    t.emit(None, None, None);
    Ok(Box::new(result))
}

/// `synthesize_cpu` with the call-site plumbing flattened (free function so the
/// validation loop can re-synthesize while `Tune` is mutably borrowed, and so
/// passive learning can re-solve from a corrected model — spec §7).
#[allow(clippy::too_many_arguments)]
pub(crate) fn synth_cpu(
    model: &ThermalModel,
    band: f32,
    p_design: f32,
    params: &AutoTuneParams,
    floor: f32,
    ceil: f32,
    g: &GroupRpm,
    has_case: bool,
) -> CpuSynth {
    synthesize_cpu(
        &SynthInput { model, p_design, target: params.target_temp_c, floor, ceil, g, has_case },
        band,
    )
}

/// Grid + baseline → fit samples (skipped points excluded).
fn fit_samples(grid: &[GridPoint], baseline: &Baseline, w0: f32) -> Vec<FitSample> {
    let mut out: Vec<FitSample> = grid
        .iter()
        .filter(|p| !p.skipped)
        .map(|p| FitSample { p: p.p_avg, w_cpu: p.w_cpu, w_case: p.w_case, t: p.t_ss })
        .collect();
    out.push(FitSample { p: baseline.p_idle, w_cpu: w0, w_case: w0, t: baseline.t_idle });
    out
}

pub(crate) fn group_rpm(fans: &[(String, Group)], calibs: &[FanCalibration]) -> GroupRpm {
    let sum = |g: Group| {
        fans.iter()
            .filter(|(_, fg)| *fg == g)
            .filter_map(|(id, _)| calibs.iter().find(|c| &c.control_id == id))
            .map(|c| c.max_rpm)
            .sum::<f32>()
    };
    GroupRpm {
        cpu_max_rpm_sum: sum(Group::Cpu).max(1.0),
        case_max_rpm_sum: sum(Group::Case).max(1.0),
    }
}

pub(crate) fn build_curves(
    fans: &[(String, Group)],
    calibs: &[FanCalibration],
    cpu: &CpuSynth,
    gpu: Option<&GpuSynth>,
    spin_down: f32,
) -> Vec<TunedFanCurve> {
    let mut curves = map_group_curves(fans, calibs, &cpu.points, gpu.map(|g| g.points.as_slice()));
    for c in &mut curves {
        c.spin_down_pct = spin_down.clamp(0.0, 100.0);
    }
    curves
}

// --- Tauri commands (spec §8) ------------------------------------------------------

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Abort flag for the currently-running tune (None = no tune running).
static TUNE_ABORT: Lazy<Mutex<Option<Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(None));

fn now_wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Run the full auto-tune. Takes engine exclusivity for the whole duration;
/// restores the previous fan config on abort, leaves the synthesized curves
/// to be applied by the frontend on success (spec §6).
#[tauri::command]
pub async fn fan_autotune_start(
    app: tauri::AppHandle,
    params: io::AutoTuneParams,
) -> crate::error::CoreResult<io::AutoTuneResult> {
    crate::sensors::ensure_sidecar();
    if !crate::fan::exclusive_begin() {
        return Err(crate::error::CoreError::from(
            "已有校准/调优在运行".to_string(),
        ));
    }
    let abort_flag = Arc::new(AtomicBool::new(false));
    *TUNE_ABORT.lock() = Some(Arc::clone(&abort_flag));
    let snapshot = crate::fan::config_snapshot();

    let outcome = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            let mut real = io::RealIo::new(app, abort_flag);
            run_tune(&mut real, &params)
        }
    })
    .await;

    *TUNE_ABORT.lock() = None;

    match outcome {
        Ok(io::AutoTuneOutcome::Done(mut result)) => {
            let (cpu_src, gpu_src) = crate::fan::resolve_source_ids();
            result.cpu_source_id = cpu_src;
            result.gpu_source_id = gpu_src;
            result.finished_at_ms = now_wall_ms();
            // Success: exclusivity ends; the engine re-applies the OLD config for
            // at most one tick until the frontend pushes the new curves (spec §6).
            crate::fan::exclusive_end();
            Ok(*result)
        }
        Ok(io::AutoTuneOutcome::Aborted(info)) => {
            crate::fan::config_restore(snapshot);
            crate::fan::exclusive_end();
            use tauri::Emitter;
            let _ = app.emit("fan-autotune-aborted", info.clone());
            Err(crate::error::CoreError::from(format!(
                "[{}] {} / {}",
                info.phase, info.reason_zh, info.reason_en
            )))
        }
        Err(e) => {
            crate::fan::config_restore(snapshot);
            crate::fan::exclusive_end();
            Err(crate::error::CoreError::from(format!("调优线程失败: {e}")))
        }
    }
}

/// Ask the running tune to stop (it aborts at the next 1 Hz safety tick).
#[tauri::command]
pub fn fan_autotune_abort() -> bool {
    match TUNE_ABORT.lock().as_ref() {
        Some(flag) => {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Re-solve curves from a stored model with new user parameters — seconds, no
/// re-measurement (spec §5 / 成功标准). Pure: nothing is applied here.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResynthRequest {
    pub params: io::AutoTuneParams,
    pub model: ThermalModel,
    pub model_gpu: Option<GpuModel>,
    pub calibrations: Vec<crate::fan::FanCalibration>,
    pub p_design: f32,
    pub p_design_gpu: Option<f32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResynthResponse {
    pub curves: Vec<TunedFanCurve>,
    pub w_points: Vec<WPoint>,
    pub gpu_w_points: Option<Vec<(f32, f32)>>,
    pub effective_target: f32,
    pub effective_target_gpu: Option<f32>,
    pub warnings: Vec<TuneWarning>,
}

#[tauri::command]
pub fn fan_autotune_resynth(req: ResynthRequest) -> crate::error::CoreResult<ResynthResponse> {
    let params = req.params.sanitized().map_err(crate::error::CoreError::from)?;
    let fans: Vec<(String, Group)> = params.groups.iter().map(|(k, v)| (k.clone(), *v)).collect();
    let has_case = fans.iter().any(|(_, g)| *g == Group::Case);
    let g_rpm = group_rpm(&fans, &req.calibrations);
    let cpu = synth_cpu(
        &req.model,
        BAND_C,
        req.p_design,
        &params,
        params.quiet_floor_pct / 100.0,
        params.noise_ceil_pct / 100.0,
        &g_rpm,
        has_case,
    );
    let gpu = match (&req.model_gpu, req.p_design_gpu) {
        (Some(mg), Some(pg)) if has_case => Some(synthesize_gpu(
            mg,
            pg,
            params.target_gpu_temp_c,
            params.quiet_floor_pct / 100.0,
            params.noise_ceil_pct / 100.0,
        )),
        _ => None,
    };
    let curves = build_curves(&fans, &req.calibrations, &cpu, gpu.as_ref(), 30.0);
    let mut warnings = Vec::new();
    if let Some(w) = cpu.warning.clone() {
        warnings.push(w);
    }
    if let Some(w) = gpu.as_ref().and_then(|g| g.warning.clone()) {
        warnings.push(w);
    }
    Ok(ResynthResponse {
        curves,
        w_points: cpu.points.clone(),
        gpu_w_points: gpu.as_ref().map(|g| g.points.clone()),
        effective_target: cpu.effective_target,
        effective_target_gpu: gpu.as_ref().map(|g| g.effective_target_g),
        warnings,
    })
}
