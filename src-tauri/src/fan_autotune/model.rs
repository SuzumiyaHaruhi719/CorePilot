//! Pure math for fan auto-tune. No I/O, no statics — every function here is
//! deterministic and unit-tested. The temperature model (spec §4):
//!   T = T_off + P · [ R∞ + k_c·φ(w_cpu) + k_x·φ(w_case) ],  φ(w) = (w+0.1)^(−α)

use serde::{Deserialize, Serialize};

/// φ regularizer: keeps φ finite at w = 0 and bounds the model's low-air gain.
pub const W_EPS: f32 = 0.1;
/// Enumerated diminishing-returns exponents for the CPU fit (linear in the
/// remaining 4 params at fixed α, so each candidate is one least-squares solve).
pub const ALPHAS: [f32; 3] = [0.6, 0.8, 1.0];
/// GPU axis has only 4 samples — fix α instead of enumerating.
pub const GPU_ALPHA: f32 = 0.8;
/// Mirror of the store's MIN_SAFE_DUTY (a managed fan is never driven below).
pub const MIN_SAFE_DUTY: f32 = 20.0;

pub fn phi(w: f32, alpha: f32) -> f32 {
    (w.max(0.0) + W_EPS).powf(-alpha)
}

/// Inverse of φ: the w that yields φ-value `p` (clamped to w ≥ 0).
pub fn phi_inv(p: f32, alpha: f32) -> f32 {
    (p.max(1e-6).powf(-1.0 / alpha) - W_EPS).max(0.0)
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThermalModel {
    pub alpha: f32,
    pub t_off: f32,
    pub r_inf: f32,
    pub k_c: f32,
    pub k_x: f32,
    pub rmse: f32,
    /// How far `t_off` was raised post-fit so the model errs hot (spec §4).
    pub conservative_shift: f32,
}

impl ThermalModel {
    pub fn predict(&self, p: f32, w_cpu: f32, w_case: f32) -> f32 {
        self.t_off
            + p * (self.r_inf + self.k_c * phi(w_cpu, self.alpha) + self.k_x * phi(w_case, self.alpha))
    }
    /// Effective thermal resistance at a fixed airflow point.
    pub fn r_at(&self, w_cpu: f32, w_case: f32) -> f32 {
        self.r_inf + self.k_c * phi(w_cpu, self.alpha) + self.k_x * phi(w_case, self.alpha)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuModel {
    pub t_off_g: f32,
    pub r_g: f32,
    pub k_g: f32,
    pub rmse: f32,
    pub conservative_shift: f32,
}

impl GpuModel {
    pub fn predict(&self, p: f32, w_case: f32) -> f32 {
        self.t_off_g + p * (self.r_g + self.k_g * phi(w_case, GPU_ALPHA))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FitSample {
    pub p: f32,
    pub w_cpu: f32,
    pub w_case: f32,
    pub t: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct GpuFitSample {
    pub p: f32,
    pub w_case: f32,
    pub t: f32,
}

/// Solve `a·x = b` (n ≤ 4) by Gaussian elimination with partial pivoting.
/// Returns None on a singular system.
fn solve_linear(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for col in 0..n {
        let pivot = (col..n).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[pivot][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, pivot);
        b.swap(col, pivot);
        for row in (col + 1)..n {
            let f = a[row][col] / a[col][col];
            for k in col..n {
                a[row][k] -= f * a[col][k];
            }
            b[row] -= f * b[col];
        }
    }
    let mut x = vec![0.0; n];
    for row in (0..n).rev() {
        let mut s = b[row];
        for k in (row + 1)..n {
            s -= a[row][k] * x[k];
        }
        x[row] = s / a[row][row];
    }
    Some(x)
}

/// Ordinary least squares via normal equations: rows of `xs` are feature
/// vectors, `free[i]` marks columns still being solved (clamped columns are
/// excluded; their fixed contribution is pre-subtracted from `y` by the caller).
fn ols(xs: &[Vec<f64>], y: &[f64], free: &[bool]) -> Option<Vec<f64>> {
    let cols: Vec<usize> = (0..free.len()).filter(|&i| free[i]).collect();
    let n = cols.len();
    if n == 0 || xs.len() < n {
        return None;
    }
    let mut ata = vec![vec![0.0; n]; n];
    let mut aty = vec![0.0; n];
    for (row, &yv) in xs.iter().zip(y) {
        for (a, &ca) in cols.iter().enumerate() {
            aty[a] += row[ca] * yv;
            for (b, &cb) in cols.iter().enumerate() {
                ata[a][b] += row[ca] * row[cb];
            }
        }
    }
    let sol = solve_linear(ata, aty)?;
    let mut full = vec![0.0; free.len()];
    for (i, &c) in cols.iter().enumerate() {
        full[c] = sol[i];
    }
    Some(full)
}

/// p90 of a slice (by sort); 0.0 for empty input.
fn p90(values: &mut Vec<f32>) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f32::total_cmp);
    let idx = (((values.len() as f32) * 0.9).ceil() as usize).clamp(1, values.len()) - 1;
    values[idx]
}

/// Bounded linear solve shared by both fits: clamp-below-bound columns to the
/// bound and refit the rest (a tiny projected NNLS — ≤3 passes is plenty for
/// 3–4 well-conditioned parameters).
fn bounded_ols(xs: &[Vec<f64>], y0: &[f64], lo: &[f64]) -> Option<Vec<f64>> {
    let n_params = lo.len();
    let mut free = vec![true; n_params];
    let mut fixed = vec![0.0_f64; n_params];
    let mut theta: Option<Vec<f64>> = None;
    for _pass in 0..3 {
        let y: Vec<f64> = xs
            .iter()
            .zip(y0)
            .map(|(row, &yv)| {
                let mut v = yv;
                for c in 0..n_params {
                    if !free[c] {
                        v -= row[c] * fixed[c];
                    }
                }
                v
            })
            .collect();
        let sol = ols(xs, &y, &free)?;
        let mut clamped_any = false;
        for c in 0..n_params {
            if free[c] && sol[c] < lo[c] {
                free[c] = false;
                fixed[c] = lo[c];
                clamped_any = true;
            }
        }
        let merged: Vec<f64> = (0..n_params)
            .map(|c| if free[c] { sol[c] } else { fixed[c] })
            .collect();
        theta = Some(merged);
        if !clamped_any {
            break;
        }
    }
    theta
}

/// Fit the CPU thermal model (spec §4): enumerate α, bounded linear solve, pick
/// the min-RSS α, then raise `t_off` by max(0, P90(residuals)) so the model
/// errs on the hot side (a curve may be slightly loud, never under-cooled).
pub fn fit_cpu_model(samples: &[FitSample], has_case: bool) -> Option<ThermalModel> {
    let n_params = if has_case { 4 } else { 3 };
    if samples.len() < n_params + 1 {
        return None;
    }
    let mut best: Option<(f64, ThermalModel)> = None;

    for &alpha in &ALPHAS {
        // Columns: [t_off, r_inf, k_c, (k_x)] with features [1, P, P·φc, (P·φx)].
        let xs: Vec<Vec<f64>> = samples
            .iter()
            .map(|s| {
                let mut row = vec![1.0, s.p as f64, (s.p * phi(s.w_cpu, alpha)) as f64];
                if has_case {
                    row.push((s.p * phi(s.w_case, alpha)) as f64);
                }
                row
            })
            .collect();
        let y0: Vec<f64> = samples.iter().map(|s| s.t as f64).collect();
        // Bounds: t_off unclamped during solve (sanity-clamped after), r_inf ≥
        // 0.01, k_c ≥ 0, k_x ≥ 0.
        let lo = if has_case {
            vec![f64::NEG_INFINITY, 0.01, 0.0, 0.0]
        } else {
            vec![f64::NEG_INFINITY, 0.01, 0.0]
        };
        let Some(th) = bounded_ols(&xs, &y0, &lo) else {
            continue;
        };
        let m = ThermalModel {
            alpha,
            t_off: (th[0] as f32).clamp(10.0, 50.0),
            r_inf: th[1] as f32,
            k_c: th[2] as f32,
            k_x: if has_case { th[3] as f32 } else { 0.0 },
            rmse: 0.0,
            conservative_shift: 0.0,
        };
        let rss: f64 = samples
            .iter()
            .map(|s| {
                let e = (s.t - m.predict(s.p, s.w_cpu, s.w_case)) as f64;
                e * e
            })
            .sum();
        if best.as_ref().map(|(b, _)| rss < *b).unwrap_or(true) {
            best = Some((rss, m));
        }
    }

    let (rss, mut m) = best?;
    m.rmse = ((rss / samples.len() as f64).sqrt()) as f32;
    let mut residuals: Vec<f32> = samples
        .iter()
        .map(|s| s.t - m.predict(s.p, s.w_cpu, s.w_case))
        .collect();
    let shift = p90(&mut residuals).max(0.0);
    m.t_off += shift;
    m.conservative_shift = shift;
    Some(m)
}

/// Fit the 3-parameter GPU model at fixed α (spec §4). With only ~4 samples the
/// conservative shift uses max(0, max residual) instead of a percentile.
pub fn fit_gpu_model(samples: &[GpuFitSample]) -> Option<GpuModel> {
    if samples.len() < 4 {
        return None;
    }
    let xs: Vec<Vec<f64>> = samples
        .iter()
        .map(|s| vec![1.0, s.p as f64, (s.p * phi(s.w_case, GPU_ALPHA)) as f64])
        .collect();
    let y0: Vec<f64> = samples.iter().map(|s| s.t as f64).collect();
    let lo = vec![f64::NEG_INFINITY, 0.0, 0.0];
    let th = bounded_ols(&xs, &y0, &lo)?;
    let mut g = GpuModel {
        t_off_g: (th[0] as f32).clamp(10.0, 60.0),
        r_g: th[1] as f32,
        k_g: th[2] as f32,
        rmse: 0.0,
        conservative_shift: 0.0,
    };
    let residuals: Vec<f32> = samples.iter().map(|s| s.t - g.predict(s.p, s.w_case)).collect();
    let rss: f64 = residuals.iter().map(|&e| (e as f64) * (e as f64)).sum();
    g.rmse = ((rss / samples.len() as f64).sqrt()) as f32;
    let shift = residuals.iter().copied().fold(0.0_f32, f32::max).max(0.0);
    g.t_off_g += shift;
    g.conservative_shift = shift;
    Some(g)
}

// --- noise objective & iso-thermal solver (spec §4/§5) -----------------------------

/// Σ maxRpm per group — the noise weights (spec §4: N = Σ (w·maxRpm/1000)²).
#[derive(Clone, Copy, Debug)]
pub struct GroupRpm {
    pub cpu_max_rpm_sum: f32,
    pub case_max_rpm_sum: f32,
}

/// Quadratic noise proxy: penalizes high speeds so the optimizer spreads
/// airflow onto whichever group is still quiet instead of maxing one out.
pub fn noise(w_cpu: f32, w_case: f32, g: &GroupRpm) -> f32 {
    let a = w_cpu * g.cpu_max_rpm_sum / 1000.0;
    let b = w_case * g.case_max_rpm_sum / 1000.0;
    a * a + b * b
}

/// A user-facing feasibility warning (bilingual; `kind` is machine-readable:
/// "ceilingInsufficient" | "coolerInsufficient" | "caseCantHelpGpu" |
/// "gpuAxisSkipped" | "validationUnconverged" | "combinedOverTarget" |
/// "fanDisconnected").
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TuneWarning {
    pub kind: String,
    pub message_zh: String,
    pub message_en: String,
    /// Optional achievable temperature attached to infeasibility warnings.
    pub achievable_c: Option<f32>,
}

/// Quietest (w_cpu, w_case) holding `T_model(p, w) ≤ t` with equality where
/// possible, inside [floor, ceil]². 1-D scan over w_cpu (0.01 steps), w_case
/// solved analytically from the isotherm (spec §5 step 3). None ⇔ infeasible
/// even at (ceil, ceil).
pub fn solve_iso(
    m: &ThermalModel,
    p: f32,
    t: f32,
    floor: f32,
    ceil: f32,
    g: &GroupRpm,
    has_case: bool,
) -> Option<(f32, f32)> {
    if p <= 0.0 {
        return Some((floor, floor));
    }
    if m.predict(p, ceil, if has_case { ceil } else { 0.0 }) > t + 0.05 {
        return None; // infeasible even fully open within the ceiling
    }
    // Required total φ budget: s = (t − T_off)/P − R∞ = k_c·φc + k_x·φx.
    let s = (t - m.t_off) / p - m.r_inf;

    if !has_case || m.k_x <= 1e-6 {
        // 1-D: solve k_c·φ(w) = s.
        let w = if m.k_c <= 1e-6 {
            floor // airflow doesn't matter per the model — stay quiet
        } else if s <= 0.0 {
            return None; // even infinite airflow can't reach t (r_inf too big)
        } else {
            phi_inv(s / m.k_c, m.alpha)
        };
        let w = w.clamp(floor, ceil);
        return (m.predict(p, w, 0.0) <= t + 0.05).then_some((w, floor));
    }

    let mut best: Option<(f32, f32, f32)> = None; // (noise, wc, wx)
    let steps = ((ceil - floor) / 0.01).round() as i32;
    for i in 0..=steps.max(0) {
        let wc = floor + i as f32 * 0.01;
        let rem = s - m.k_c * phi(wc, m.alpha);
        let wx = if rem <= 0.0 {
            // This much CPU airflow alone overshoots the budget — case at floor.
            floor
        } else {
            let need = rem / m.k_x;
            let w = phi_inv(need, m.alpha);
            if w > ceil + 1e-4 {
                continue; // infeasible at this wc
            }
            w.clamp(floor, ceil)
        };
        if m.predict(p, wc, wx) > t + 0.05 {
            continue;
        }
        let n = noise(wc, wx, g);
        if best.map(|(bn, _, _)| n < bn).unwrap_or(true) {
            best = Some((n, wc, wx));
        }
    }
    best.map(|(_, wc, wx)| (wc, wx))
}

// --- curve synthesis (spec §5) ------------------------------------------------------

/// One point of a group-level airflow curve: at `temp_c`, run the CPU group at
/// `w_cpu` and the case group at `w_case` (fractions of each fan's max RPM).
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WPoint {
    pub temp_c: f32,
    pub w_cpu: f32,
    pub w_case: f32,
}

pub struct SynthInput<'a> {
    pub model: &'a ThermalModel,
    pub p_design: f32,
    pub target: f32,
    pub floor: f32,
    pub ceil: f32,
    pub g: &'a GroupRpm,
    pub has_case: bool,
}

#[derive(Clone, Debug)]
pub struct CpuSynth {
    pub effective_target: f32,
    pub points: Vec<WPoint>,
    pub warning: Option<TuneWarning>,
    pub band_c: f32,
}

/// Spec §5: feasibility verdict → proportional-band schedule → quietest combo
/// per scheduled equilibrium → emergency ramp. Output is strictly increasing in
/// temperature and non-decreasing in airflow, so the engine curve is single-
/// valued with finite slope (no oscillation-inducing vertical jump at target).
pub fn synthesize_cpu(inp: &SynthInput, band_c: f32) -> CpuSynth {
    let m = inp.model;
    let (floor, ceil) = (inp.floor, inp.ceil);
    let wx_of = |w: f32| if inp.has_case { w } else { 0.0 };

    // 1. Feasibility & effective target.
    let t_at_ceil = m.predict(inp.p_design, ceil, wx_of(ceil));
    let t_at_full = m.predict(inp.p_design, 1.0, wx_of(1.0));
    let mut warning = None;
    let effective_target = if t_at_ceil <= inp.target {
        inp.target
    } else if t_at_full > inp.target {
        let achievable = t_at_full;
        warning = Some(TuneWarning {
            kind: "coolerInsufficient".into(),
            message_zh: format!(
                "散热器能力不足:满载即使风扇全速也只能压到约 {achievable:.1}°C,曲线已锚定全速"
            ),
            message_en: format!(
                "Cooler insufficient: even at 100% fans full load only reaches ≈{achievable:.1}°C; curve anchored at full speed"
            ),
            achievable_c: Some(achievable),
        });
        achievable + 1.0
    } else {
        let achievable = t_at_ceil;
        warning = Some(TuneWarning {
            kind: "ceilingInsufficient".into(),
            message_zh: format!(
                "噪音上限 {:.0}% 内满载最低只能压到约 {achievable:.1}°C(目标 {:.0}°C)",
                ceil * 100.0,
                inp.target
            ),
            message_en: format!(
                "Within the {:.0}% noise ceiling full load only reaches ≈{achievable:.1}°C (target {:.0}°C)",
                ceil * 100.0,
                inp.target
            ),
            achievable_c: Some(achievable),
        });
        achievable + 0.5
    };

    // 2. Full-load anchor (quietest combo pinning effective_target at P_design).
    let w_req = solve_iso(m, inp.p_design, effective_target, floor, ceil, inp.g, inp.has_case)
        .unwrap_or((ceil, ceil));

    // 3. Proportional band: P_knee where floor airflow lands at target − B.
    let t_low = effective_target - band_c;
    let r_floor = m.r_at(floor, wx_of(floor));
    let p_knee = ((t_low - m.t_off) / r_floor).max(0.0);

    let mut points: Vec<WPoint> = vec![WPoint { temp_c: 20.0, w_cpu: floor, w_case: floor }];
    points.push(WPoint { temp_c: t_low, w_cpu: floor, w_case: floor });

    if p_knee < inp.p_design {
        // Power schedule across the band: equilibrium temps ease toward the
        // target as power approaches P_design (spec §5.4).
        let mut prev_t = t_low;
        for j in 1..=5 {
            let f = j as f32 / 5.0;
            let p_j = p_knee + (inp.p_design - p_knee) * f;
            let mut t_j = t_low + band_c * f.powf(1.5);
            // Clamp into the feasibility envelope, then keep strictly increasing.
            let t_env = m.predict(p_j, ceil, wx_of(ceil)) + 0.3;
            t_j = t_j.max(t_env).max(prev_t + 0.2);
            prev_t = t_j;
            let (wc, wx) =
                solve_iso(m, p_j, t_j, floor, ceil, inp.g, inp.has_case).unwrap_or(w_req);
            points.push(WPoint { temp_c: t_j, w_cpu: wc, w_case: wx });
        }
    }
    // else: the floor holds everything — flat curve + emergency ramp only.

    // 4. Emergency ramp above target: ceiling at +3, full (ignore ceiling) at +6.
    points.push(WPoint {
        temp_c: effective_target + 3.0,
        w_cpu: ceil,
        w_case: if inp.has_case { ceil } else { floor },
    });
    points.push(WPoint {
        temp_c: effective_target + 6.0,
        w_cpu: 1.0,
        w_case: if inp.has_case { 1.0 } else { floor },
    });

    // 5. Enforce monotonicity (strict temp, non-decreasing airflow).
    points.sort_by(|a, b| a.temp_c.total_cmp(&b.temp_c));
    points.dedup_by(|b, a| {
        if b.temp_c - a.temp_c < 0.15 {
            a.w_cpu = a.w_cpu.max(b.w_cpu);
            a.w_case = a.w_case.max(b.w_case);
            true
        } else {
            false
        }
    });
    for i in 1..points.len() {
        points[i].w_cpu = points[i].w_cpu.max(points[i - 1].w_cpu);
        points[i].w_case = points[i].w_case.max(points[i - 1].w_case);
    }

    CpuSynth { effective_target, points, warning, band_c }
}

#[derive(Clone, Debug)]
pub struct GpuSynth {
    pub effective_target_g: f32,
    /// (temp_c, w_case) — the case group's GPU-assist curve.
    pub points: Vec<(f32, f32)>,
    pub warning: Option<TuneWarning>,
}

/// Spec §5.7: 1-D assist curve for the case group keyed to GPU temperature.
/// Honest framing: the GPU's own cooler dominates; case airflow assists.
pub fn synthesize_gpu(m: &GpuModel, p_design_g: f32, target_g: f32, floor: f32, ceil: f32) -> GpuSynth {
    let t_at_ceil = m.predict(p_design_g, ceil);
    let mut warning = None;
    let effective = if t_at_ceil <= target_g {
        target_g
    } else {
        warning = Some(TuneWarning {
            kind: "caseCantHelpGpu".into(),
            message_zh: format!(
                "机箱风量帮不动 GPU:上限内 GPU 满载最低约 {t_at_ceil:.1}°C(显卡自身风扇为主,机箱只能辅助)"
            ),
            message_en: format!(
                "Case airflow can't hold the GPU: ≈{t_at_ceil:.1}°C minimum at full GPU load within the ceiling (the GPU's own cooler dominates)"
            ),
            achievable_c: Some(t_at_ceil),
        });
        t_at_ceil + 0.5
    };
    // Analytic w_req: k_g·φ(w) = (t − t_off_g)/P − r_g.
    let s = (effective - m.t_off_g) / p_design_g - m.r_g;
    let w_req = if m.k_g <= 1e-6 || s <= 0.0 {
        ceil
    } else {
        phi_inv(s / m.k_g, GPU_ALPHA).clamp(floor, ceil)
    };
    let mut points = vec![
        (20.0, floor),
        (effective - 6.0, floor),
        (effective, w_req),
        (effective + 3.0, ceil),
        (effective + 6.0, 1.0),
    ];
    points.sort_by(|a, b| a.0.total_cmp(&b.0));
    for i in 1..points.len() {
        points[i].1 = points[i].1.max(points[i - 1].1);
    }
    GpuSynth { effective_target_g: effective, points, warning }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate grid samples from a known model + noise; fit must recover it.
    fn synth_samples(m: &ThermalModel, noise: f32) -> Vec<FitSample> {
        let mut out = Vec::new();
        let mut sign = 1.0_f32;
        for (i, &wc) in [1.0_f32, 0.75, 0.5, 0.35].iter().enumerate() {
            for (j, &wx) in [1.0_f32, 0.6, 0.3].iter().enumerate() {
                let p = 195.0 + ((i * 3 + j) % 4) as f32;
                let t = m.predict(p, wc, wx) + sign * noise;
                sign = -sign;
                out.push(FitSample { p, w_cpu: wc, w_case: wx, t });
            }
        }
        // idle anchor
        out.push(FitSample { p: 38.0, w_cpu: 0.4, w_case: 0.4, t: m.predict(38.0, 0.4, 0.4) });
        out
    }

    fn truth() -> ThermalModel {
        ThermalModel { alpha: 0.8, t_off: 28.0, r_inf: 0.12, k_c: 0.10, k_x: 0.04, rmse: 0.0, conservative_shift: 0.0 }
    }

    #[test]
    fn fit_recovers_known_model_within_tolerance() {
        let m = fit_cpu_model(&synth_samples(&truth(), 0.3), true).expect("fit");
        assert_eq!(m.alpha, 0.8, "alpha enumeration picks the generating alpha");
        assert!((m.t_off - 28.0).abs() < 2.0, "t_off {}", m.t_off);
        // Prediction accuracy matters more than per-param identity:
        for s in synth_samples(&truth(), 0.0) {
            let pred = m.predict(s.p, s.w_cpu, s.w_case);
            assert!((pred - s.t).abs() < 1.2, "pred {pred} vs {t}", t = s.t);
        }
    }

    #[test]
    fn fit_is_conservative_never_cool_biased() {
        let m = fit_cpu_model(&synth_samples(&truth(), 0.8), true).expect("fit");
        assert!(m.conservative_shift >= 0.0);
        // With the shift applied, ≥ ~90% of samples must NOT be hotter than predicted.
        let hot = synth_samples(&truth(), 0.8)
            .iter()
            .filter(|s| s.t > m.predict(s.p, s.w_cpu, s.w_case) + 1e-3)
            .count();
        assert!(hot <= 2, "{hot} samples hotter than conservative prediction");
    }

    #[test]
    fn fit_clamps_negative_coefficients() {
        // Case axis carries no signal (k_x = 0) + noise pushing it negative.
        let base = ThermalModel { k_x: 0.0, ..truth() };
        let mut samples = synth_samples(&base, 0.2);
        for s in &mut samples {
            if s.w_case < 0.5 {
                s.t -= 0.3; // nudge toward negative k_x
            }
        }
        let m = fit_cpu_model(&samples, true).expect("fit");
        assert!(m.k_x >= 0.0 && m.k_c >= 0.0 && m.r_inf >= 0.01);
    }

    #[test]
    fn fit_without_case_group_uses_three_params() {
        let base = ThermalModel { k_x: 0.0, ..truth() };
        let samples: Vec<FitSample> = synth_samples(&base, 0.2)
            .into_iter()
            .map(|mut s| {
                s.w_case = 0.0;
                s
            })
            .collect();
        let m = fit_cpu_model(&samples, false).expect("fit");
        assert_eq!(m.k_x, 0.0);
    }

    #[test]
    fn gpu_fit_recovers_known_model() {
        let g = GpuModel { t_off_g: 30.0, r_g: 0.09, k_g: 0.03, rmse: 0.0, conservative_shift: 0.0 };
        let mk = |p: f32, w: f32| GpuFitSample { p, w_case: w, t: g.predict(p, w) };
        let samples = vec![mk(320.0, 1.0), mk(318.0, 0.6), mk(322.0, 0.3), mk(45.0, 0.4)];
        let f = fit_gpu_model(&samples).expect("fit");
        for s in &samples {
            assert!((f.predict(s.p, s.w_case) - s.t).abs() < 0.8);
        }
    }

    #[test]
    fn fit_rejects_degenerate_input() {
        assert!(fit_cpu_model(&[], true).is_none());
        let one = vec![FitSample { p: 100.0, w_cpu: 1.0, w_case: 1.0, t: 60.0 }];
        assert!(fit_cpu_model(&one, true).is_none());
    }

    fn rpm_groups() -> GroupRpm {
        GroupRpm { cpu_max_rpm_sum: 3600.0, case_max_rpm_sum: 5200.0 }
    }

    #[test]
    fn solve_iso_finds_quietest_combo_on_isotherm() {
        let m = truth();
        let g = rpm_groups();
        let (wc, wx) = solve_iso(&m, 200.0, 78.0, 0.25, 1.0, &g, true).expect("feasible");
        // On the isotherm (or overcooled at the floor) and within bounds:
        assert!(m.predict(200.0, wc, wx) <= 78.0 + 0.1);
        assert!((0.25..=1.0).contains(&wc) && (0.25..=1.0).contains(&wx));
        // It must beat the trivial "both maxed" solution on noise:
        assert!(noise(wc, wx, &g) <= noise(1.0, 1.0, &g));
    }

    #[test]
    fn solve_iso_respects_ceiling_infeasibility() {
        let m = truth();
        // Demand an impossible temp under a tight ceiling:
        assert!(solve_iso(&m, 220.0, 40.0, 0.25, 0.5, &rpm_groups(), true).is_none());
    }

    fn synth_input<'a>(m: &'a ThermalModel, g: &'a GroupRpm, target: f32, ceil: f32) -> SynthInput<'a> {
        SynthInput { model: m, p_design: 210.0, target, floor: 0.25, ceil, g, has_case: true }
    }

    #[test]
    fn synthesize_cpu_happy_path_monotone_and_anchored() {
        let m = truth();
        let g = rpm_groups();
        let s = synthesize_cpu(&synth_input(&m, &g, 85.0, 1.0), 8.0);
        assert!(s.warning.is_none());
        assert_eq!(s.effective_target, 85.0);
        let pts = &s.points;
        assert!(pts.len() >= 6 && pts.len() <= 9, "{}", pts.len());
        for w in pts.windows(2) {
            assert!(w[1].temp_c > w[0].temp_c, "temps strictly increase");
            assert!(w[1].w_cpu >= w[0].w_cpu && w[1].w_case >= w[0].w_case, "w non-decreasing");
        }
        assert_eq!(pts[0].w_cpu, 0.25, "starts at the quiet floor");
        let last = pts.last().unwrap();
        assert_eq!((last.w_cpu, last.w_case), (1.0, 1.0), "emergency tops at 100%");
        // The point AT the target must hold the design power at/below target:
        let at = pts.iter().find(|p| (p.temp_c - 85.0).abs() < 0.01).expect("target anchor");
        assert!(m.predict(210.0, at.w_cpu, at.w_case) <= 85.0 + 0.1);
    }

    #[test]
    fn synthesize_cpu_warns_when_ceiling_cannot_hold_target() {
        let m = truth();
        let g = rpm_groups();
        // truth() at P=210 W reaches ≈80.4°C at full airflow, ≈104°C at 40%.
        // Target 82°C is feasible at 100% but NOT inside a 40% ceiling → the
        // verdict must blame the ceiling, not the cooler.
        let s = synthesize_cpu(&synth_input(&m, &g, 82.0, 0.4), 8.0);
        let w = s.warning.expect("warning expected");
        assert_eq!(w.kind, "ceilingInsufficient");
        assert!(s.effective_target > 82.0);
    }

    #[test]
    fn synthesize_cpu_warns_when_cooler_is_insufficient() {
        // Hopeless cooler: huge residual resistance.
        let m = ThermalModel { r_inf: 0.5, ..truth() };
        let g = rpm_groups();
        let s = synthesize_cpu(&synth_input(&m, &g, 70.0, 1.0), 8.0);
        let w = s.warning.expect("warning expected");
        assert_eq!(w.kind, "coolerInsufficient");
        assert!(s.effective_target > 70.0);
        let last = s.points.last().unwrap();
        assert_eq!((last.w_cpu, last.w_case), (1.0, 1.0));
    }

    #[test]
    fn synthesize_cpu_flat_floor_when_floor_holds_everything() {
        // Monster cooler: floor airflow already pins design power below target.
        let m = ThermalModel { r_inf: 0.02, k_c: 0.02, k_x: 0.01, t_off: 25.0, ..truth() };
        let g = rpm_groups();
        let s = synthesize_cpu(&synth_input(&m, &g, 85.0, 1.0), 8.0);
        assert!(s.warning.is_none());
        // All pre-emergency points sit at the floor:
        for p in s.points.iter().filter(|p| p.temp_c < 85.0 + 2.9) {
            assert_eq!((p.w_cpu, p.w_case), (0.25, 0.25), "flat at floor, got {:?}", (p.w_cpu, p.w_case));
        }
    }

    #[test]
    fn synthesize_gpu_assist_anchors_and_warns() {
        let g = GpuModel { t_off_g: 30.0, r_g: 0.09, k_g: 0.03, rmse: 0.0, conservative_shift: 0.0 };
        let ok = synthesize_gpu(&g, 330.0, 80.0, 0.25, 1.0);
        assert!(ok.warning.is_none());
        for w in ok.points.windows(2) {
            assert!(w[1].0 > w[0].0 && w[1].1 >= w[0].1);
        }
        let anchor = ok
            .points
            .iter()
            .find(|p| (p.0 - ok.effective_target_g).abs() < 0.01)
            .expect("target anchor");
        assert!(g.predict(330.0, anchor.1) <= ok.effective_target_g + 0.1);
        // Case fans can't do much for a hot GPU → honest warning:
        let weak = GpuModel { r_g: 0.2, k_g: 0.005, ..g };
        let bad = synthesize_gpu(&weak, 330.0, 70.0, 0.25, 1.0);
        assert_eq!(bad.warning.expect("warn").kind, "caseCantHelpGpu");
        assert!(bad.effective_target_g > 70.0);
    }
}
