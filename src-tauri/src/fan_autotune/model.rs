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

/// Hard ceiling for the CURVE-ANCHORING effective target (°C). On a machine
/// whose model extrapolates an absurd achievable temp (weak cooler / tight
/// ceiling → 120 °C+), anchoring the curve there would let `fan.rs`'s
/// MAX_CURVE_TEMP_C=120 sanitizer collapse every point onto one 120 °C cliff —
/// fans would idle at the floor across the entire REAL temperature range.
/// 90 °C sits just above Zen5's TjMax (89), so an under-cooled CPU pinned at
/// its throttle point still lands near the top of the proportional band and
/// gets (near-)ceiling airflow. Warnings keep reporting the TRUE achievable
/// temperature — only the curve anchor is capped.
pub const MAX_EFFECTIVE_TARGET_C: f32 = 90.0;
/// Same idea for the GPU assist anchor (GPU cores throttle well below 95).
pub const MAX_EFFECTIVE_GPU_TARGET_C: f32 = 95.0;

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
    // Cap the ANCHOR (not the reported achievable temp): see
    // MAX_EFFECTIVE_TARGET_C — an uncapped 120 °C+ anchor would be flattened by
    // the engine's curve sanitizer into a useless cliff.
    let effective_target = effective_target.min(MAX_EFFECTIVE_TARGET_C);

    // 2. Full-load anchor (quietest combo pinning effective_target at P_design).
    let w_req = solve_iso(m, inp.p_design, effective_target, floor, ceil, inp.g, inp.has_case)
        .unwrap_or((ceil, ceil));

    // 2b. Degenerate-fit honesty (field lesson, 2026-06-10): when the measured
    // grid is nearly flat the fit truthfully reports tiny fan authority — say
    // so, because the resulting near-flat curve looks "lazy" without context.
    let fan_authority = m.predict(inp.p_design, floor, wx_of(floor))
        - m.predict(inp.p_design, 1.0, wx_of(1.0));
    if warning.is_none() && fan_authority < 3.0 {
        warning = Some(TuneWarning {
            kind: "fansBarelyMatter".into(),
            message_zh: format!(
                "实测风扇转速对 CPU 满载温度影响很小(底线→全速仅 ≈{fan_authority:.1}°C),曲线因此接近平坦 —— 这是测量数据的诚实结论(散热器强/功耗低/后台噪声大都会如此)。若与预期不符,建议空闲时重新调优"
            ),
            message_en: format!(
                "Measured fan authority over CPU temp is tiny (≈{fan_authority:.1}°C floor→full), so the curve is nearly flat — the honest reading of the data. Re-tune on an idle system if this seems wrong"
            ),
            achievable_c: None,
        });
    }

    // 3. Proportional band: needed only when the quiet floor canNOT hold the
    // target at design power. Anchoring this on the TARGET (not t_low) is what
    // keeps a strong-cooler/low-power machine on a flat, quiet curve instead
    // of a pointless ramp through its normal operating temperatures.
    let t_low = effective_target - band_c;
    let floor_holds = m.predict(inp.p_design, floor, wx_of(floor)) <= effective_target;

    let mut points: Vec<WPoint> = vec![WPoint { temp_c: 20.0, w_cpu: floor, w_case: floor }];
    points.push(WPoint { temp_c: t_low, w_cpu: floor, w_case: floor });

    if floor_holds {
        // Flat curve: hold the (≈floor) full-load solution at the target so
        // interpolation stays at the floor across the whole band.
        points.push(WPoint { temp_c: effective_target, w_cpu: w_req.0, w_case: w_req.1 });
    } else {
        let r_floor = m.r_at(floor, wx_of(floor));
        let p_knee = ((t_low - m.t_off) / r_floor).max(0.0).min(inp.p_design);
        // Power schedule across the band: equilibrium temps ease toward the
        // target as power approaches P_design (spec §5.4).
        let mut prev_t = t_low;
        for j in 1..=5 {
            let f = j as f32 / 5.0;
            let p_j = p_knee + (inp.p_design - p_knee) * f;
            let mut t_j = t_low + band_c * f.powf(1.5);
            // Lift the scheduled temp clear of the feasibility envelope (with a
            // real margin — hugging it forces near-max airflow), but never past
            // the (possibly capped) target.
            let t_env = (m.predict(p_j, ceil, wx_of(ceil)) + 1.0).min(effective_target);
            t_j = t_j.max(t_env).max(prev_t + 0.2);
            prev_t = t_j;
            let (wc, wx) =
                solve_iso(m, p_j, t_j, floor, ceil, inp.g, inp.has_case).unwrap_or(w_req);
            // A band point must never be louder than the full-load anchor —
            // otherwise monotonicity drags the whole curve up to one
            // pathological early point (the field "cliff at 60°C" bug).
            points.push(WPoint {
                temp_c: t_j,
                w_cpu: wc.min(w_req.0),
                w_case: wx.min(w_req.1),
            });
        }
    }

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
    // Cap the anchor like the CPU side (see MAX_EFFECTIVE_TARGET_C rationale).
    let effective = effective.min(MAX_EFFECTIVE_GPU_TARGET_C);
    // Analytic w_req: k_g·φ(w) = (t − t_off_g)/P − r_g.
    let s = (effective - m.t_off_g) / p_design_g - m.r_g;
    let w_req = if m.k_g <= 1e-6 || s <= 0.0 {
        ceil
    } else {
        phi_inv(s / m.k_g, GPU_ALPHA).clamp(floor, ceil)
    };
    // Degenerate-fit honesty: when case airflow measurably does almost nothing
    // for the GPU (its own cooler dominates completely), surging the case fans
    // above the target would be pure noise for no cooling — keep the assist
    // flat and say why.
    let assist_authority = m.predict(p_design_g, floor) - m.predict(p_design_g, ceil);
    if assist_authority < 2.0 {
        if warning.is_none() {
            warning = Some(TuneWarning {
                kind: "caseBarelyHelpsGpu".into(),
                message_zh: format!(
                    "实测机箱风量对 GPU 温度影响很小(≈{assist_authority:.1}°C),GPU 辅助曲线保持平坦(显卡自身风扇足以胜任)"
                ),
                message_en: format!(
                    "Measured case-airflow authority over the GPU is tiny (≈{assist_authority:.1}°C); the assist curve stays flat (the GPU's own cooler dominates)"
                ),
                achievable_c: None,
            });
        }
        let w_flat = w_req.min(floor.max(w_req));
        let points = vec![(20.0, floor), (effective + 6.0, w_flat.max(floor))];
        return GpuSynth { effective_target_g: effective, points, warning };
    }
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

// --- per-fan duty mapping (spec §5.6/§5.7) ------------------------------------------

use crate::fan::{CalibPoint, CurvePoint, FanCalibration};

/// Which sweep group a fan belongs to.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    Cpu,
    Case,
}

/// Port of the store's `dutyForRpmFraction` (fanProfiles.ts): the PWM duty that
/// achieves `frac` of `max_rpm`, by linear interpolation through the measured
/// (duty → RPM) samples; clamped to [max(MIN_SAFE_DUTY, min_start_duty), 100].
pub fn duty_for_rpm_fraction(points: &[CalibPoint], frac: f32, min_start_duty: f32, max_rpm: f32) -> f32 {
    let f = frac.clamp(0.0, 1.0);
    let lo = MIN_SAFE_DUTY.max(min_start_duty);
    if f <= 0.0 || max_rpm <= 0.0 {
        return lo;
    }
    let target = f * max_rpm;
    let mut usable: Vec<&CalibPoint> = points
        .iter()
        .filter(|p| p.duty.is_finite() && p.rpm.is_finite() && p.rpm > 0.0)
        .collect();
    usable.sort_by(|a, b| a.duty.total_cmp(&b.duty));
    if usable.is_empty() {
        return (f * 100.0).round().clamp(lo, 100.0);
    }
    if target <= usable[0].rpm {
        return usable[0].duty.round().max(lo);
    }
    let top = usable[usable.len() - 1];
    if target >= top.rpm {
        return 100.0;
    }
    for w in usable.windows(2) {
        let (a, b) = (w[0], w[1]);
        if target >= a.rpm && target <= b.rpm {
            let span = b.rpm - a.rpm;
            let duty = if span <= 0.0 {
                b.duty
            } else {
                a.duty + (target - a.rpm) / span * (b.duty - a.duty)
            };
            return duty.round().clamp(lo, 100.0);
        }
    }
    100.0
}

/// Synthesized per-fan output: plain engine curves (+ optional GPU assist).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TunedFanCurve {
    pub control_id: String,
    pub group: Group,
    pub curve: Vec<CurvePoint>,
    /// GPU-assist curve (case-group fans only; empty otherwise).
    pub curve2: Vec<CurvePoint>,
    pub min_duty: f32,
    pub spin_up_pct: f32,
    pub spin_down_pct: f32,
}

/// Map group-level airflow curves into per-fan duty curves through each fan's
/// own calibration. `gpu_points` is the case group's assist curve, None when
/// the GPU axis was skipped.
pub fn map_group_curves(
    groups: &[(String, Group)],
    calibs: &[FanCalibration],
    cpu_points: &[WPoint],
    gpu_points: Option<&[(f32, f32)]>,
) -> Vec<TunedFanCurve> {
    let mut out = Vec::with_capacity(groups.len());
    for (id, group) in groups {
        let Some(cal) = calibs.iter().find(|c| &c.control_id == id) else {
            continue;
        };
        let duty_at = |w: f32| duty_for_rpm_fraction(&cal.points, w, cal.min_start_duty, cal.max_rpm);
        let mut curve: Vec<CurvePoint> = cpu_points
            .iter()
            .map(|p| CurvePoint {
                temp_c: p.temp_c,
                duty: duty_at(if *group == Group::Cpu { p.w_cpu } else { p.w_case }),
            })
            .collect();
        for i in 1..curve.len() {
            curve[i].duty = curve[i].duty.max(curve[i - 1].duty);
        }
        let mut curve2: Vec<CurvePoint> = Vec::new();
        if *group == Group::Case {
            if let Some(gp) = gpu_points {
                curve2 = gp
                    .iter()
                    .map(|&(temp_c, w)| CurvePoint { temp_c, duty: duty_at(w) })
                    .collect();
                for i in 1..curve2.len() {
                    curve2[i].duty = curve2[i].duty.max(curve2[i - 1].duty);
                }
            }
        }
        let floor_w = cpu_points
            .first()
            .map(|p| if *group == Group::Cpu { p.w_cpu } else { p.w_case })
            .unwrap_or(0.25);
        out.push(TunedFanCurve {
            control_id: id.clone(),
            group: *group,
            curve,
            curve2,
            min_duty: duty_at(floor_w),
            // Responsive up, smooth down — damps hunting inside the band.
            spin_up_pct: 70.0,
            spin_down_pct: 30.0,
        });
    }
    out
}

// --- steady-state detection (spec §3 阶段 2) -----------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Steady {
    Pending,
    /// Settled: mean of the last 10 samples.
    Steady(f32),
    /// Max dwell reached while still moving: best current estimate.
    Saturated(f32),
}

/// Sliding-window steady detector: steady when the LSQ slope over the last 25
/// samples is < 0.05 °C/s AND their range < 0.8 °C, after `min_dwell_s`; gives
/// up (Saturated) at `max_dwell_s` — important for high-inertia AIO loops.
/// Feed ~1 Hz samples.
pub struct SteadyDetector {
    samples: Vec<(f32, f32)>, // (t_s, value)
    min_dwell_s: f32,
    max_dwell_s: f32,
}

impl SteadyDetector {
    pub fn new(min_dwell_s: f32, max_dwell_s: f32) -> Self {
        Self { samples: Vec::new(), min_dwell_s, max_dwell_s }
    }

    fn tail_mean(&self, n: usize) -> f32 {
        let k = self.samples.len().min(n).max(1);
        let s: f32 = self.samples[self.samples.len() - k..].iter().map(|&(_, v)| v).sum();
        s / k as f32
    }

    pub fn push(&mut self, t_s: f32, value: f32) -> Steady {
        self.samples.push((t_s, value));
        let elapsed = t_s - self.samples[0].0;
        if elapsed >= self.max_dwell_s {
            return Steady::Saturated(self.tail_mean(10));
        }
        if elapsed < self.min_dwell_s || self.samples.len() < 25 {
            return Steady::Pending;
        }
        let win = &self.samples[self.samples.len() - 25..];
        let (mut sx, mut sy, mut sxx, mut sxy) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
        for &(x, y) in win {
            let (x, y) = (x as f64, y as f64);
            sx += x;
            sy += y;
            sxx += x * x;
            sxy += x * y;
        }
        let n = win.len() as f64;
        let denom = n * sxx - sx * sx;
        let slope = if denom.abs() < 1e-9 { 0.0 } else { (n * sxy - sx * sy) / denom };
        let (min, max) = win
            .iter()
            .fold((f32::MAX, f32::MIN), |(lo, hi), &(_, v)| (lo.min(v), hi.max(v)));
        if slope.abs() < 0.05 && (max - min) < 0.8 {
            Steady::Steady(self.tail_mean(10))
        } else {
            Steady::Pending
        }
    }
}

// --- passive-learning math (spec §7) -------------------------------------------------

/// Bounded, safety-asymmetric drift correction from steady-state residuals
/// (observed − predicted, °C). Returns the t_off delta to apply, or None.
/// Hot (median > 1.5) corrects immediately; cold needs median < −2.5. The step
/// is capped at ±0.5 per invocation and the ACCUMULATED drift at ±6 total.
pub fn passive_correction(residuals: &[f32], accumulated: f32) -> Option<f32> {
    if residuals.len() < 5 {
        return None;
    }
    let mut v: Vec<f32> = residuals.to_vec();
    v.sort_by(f32::total_cmp);
    let median = v[v.len() / 2];
    let delta = if median > 1.5 {
        median.min(0.5)
    } else if median < -2.5 {
        median.max(-0.5)
    } else {
        return None;
    };
    let clamped = (accumulated + delta).clamp(-6.0, 6.0) - accumulated;
    (clamped.abs() > 1e-3).then_some(clamped)
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
    fn synthesize_cpu_infeasible_anchor_stays_in_real_temp_range() {
        // Pathological extrapolation: achievable ≈ 160 °C. The curve anchor
        // must be capped so the engine's 120 °C curve sanitizer can never
        // flatten the curve into a useless cliff, and (near-)ceiling airflow
        // must arrive by ~90 °C where real silicon actually operates.
        let m = ThermalModel { r_inf: 0.5, ..truth() };
        let g = rpm_groups();
        let s = synthesize_cpu(&synth_input(&m, &g, 70.0, 1.0), 8.0);
        assert!(s.effective_target <= MAX_EFFECTIVE_TARGET_C + 1e-3);
        let max_t = s.points.iter().map(|p| p.temp_c).fold(f32::MIN, f32::max);
        assert!(max_t <= 96.1, "max curve temp {max_t} must stay well below the 120 °C clamp");
        // Honesty: the warning still reports the TRUE achievable temperature.
        let w = s.warning.expect("cooler warning");
        assert!(w.achievable_c.unwrap() > 120.0, "true achievable must not be masked by the cap");
        // Airflow must be at/near ceiling by 90 °C (the real operating region).
        let at_90 = s
            .points
            .iter()
            .filter(|p| p.temp_c <= 90.0 + 1e-3)
            .map(|p| p.w_cpu)
            .fold(0.0_f32, f32::max);
        assert!(at_90 >= 0.99, "w_cpu by 90 °C = {at_90}, expected ≈ ceiling");
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

    use crate::fan::{CalibPoint, FanCalibration};

    fn calib(id: &str, max_rpm: f32, nonlinear: bool) -> FanCalibration {
        // Linear fan: rpm = duty/100 × max. Non-linear fan: rpm saturates early.
        let duties = [0.0, 8.0, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0];
        let points = duties
            .iter()
            .map(|&d| CalibPoint {
                duty: d,
                rpm: if nonlinear {
                    max_rpm * (d / 100.0).sqrt() // fast rise, early saturation
                } else {
                    max_rpm * d / 100.0
                },
            })
            .collect();
        FanCalibration {
            control_id: id.into(),
            name: id.into(),
            min_start_duty: 15.0,
            max_rpm,
            saturation_duty: 100.0,
            points,
            disconnected: false,
        }
    }

    #[test]
    fn duty_inversion_linear_fan_is_identity_ish() {
        let c = calib("f", 2000.0, false);
        let d = duty_for_rpm_fraction(&c.points, 0.5, c.min_start_duty, c.max_rpm);
        assert!((d - 50.0).abs() <= 1.5, "got {d}");
        // frac=0 → floor = max(MIN_SAFE_DUTY, start duty).
        assert_eq!(duty_for_rpm_fraction(&c.points, 0.0, c.min_start_duty, c.max_rpm), 20.0);
        assert_eq!(duty_for_rpm_fraction(&c.points, 1.0, c.min_start_duty, c.max_rpm), 100.0);
    }

    #[test]
    fn duty_inversion_nonlinear_fan_picks_lower_duty() {
        let c = calib("f", 2000.0, true);
        // 50% airflow on a √-curve fan needs only 25% duty.
        let d = duty_for_rpm_fraction(&c.points, 0.5, c.min_start_duty, c.max_rpm);
        assert!((d - 25.0).abs() <= 2.0, "got {d}");
    }

    #[test]
    fn map_group_curves_builds_dual_curves_for_case_fans() {
        let cpu_fan = calib("cpu0", 2200.0, false);
        let case_fan = calib("case0", 1400.0, true);
        let cpu_pts = vec![
            WPoint { temp_c: 20.0, w_cpu: 0.25, w_case: 0.25 },
            WPoint { temp_c: 77.0, w_cpu: 0.25, w_case: 0.25 },
            WPoint { temp_c: 85.0, w_cpu: 0.8, w_case: 0.5 },
            WPoint { temp_c: 91.0, w_cpu: 1.0, w_case: 1.0 },
        ];
        let gpu_pts = vec![(20.0_f32, 0.25_f32), (74.0, 0.25), (80.0, 0.6), (86.0, 1.0)];
        let curves = map_group_curves(
            &[("cpu0".to_string(), Group::Cpu), ("case0".to_string(), Group::Case)],
            &[cpu_fan, case_fan],
            &cpu_pts,
            Some(&gpu_pts),
        );
        assert_eq!(curves.len(), 2);
        let cpu = curves.iter().find(|c| c.control_id == "cpu0").unwrap();
        assert!(cpu.curve2.is_empty(), "CPU-group fans never get a GPU curve");
        assert_eq!(cpu.spin_up_pct, 70.0);
        assert_eq!(cpu.spin_down_pct, 30.0);
        let case = curves.iter().find(|c| c.control_id == "case0").unwrap();
        assert_eq!(case.curve2.len(), gpu_pts.len(), "case fans carry the GPU assist curve");
        // Curves are duty-valued, monotone non-decreasing, within [20,100]:
        for c in &curves {
            for w in c.curve.windows(2) {
                assert!(w[1].duty >= w[0].duty);
            }
            for p in c.curve.iter().chain(c.curve2.iter()) {
                assert!((MIN_SAFE_DUTY..=100.0).contains(&p.duty));
            }
            assert!(c.min_duty >= MIN_SAFE_DUTY);
        }
    }

    #[test]
    fn steady_detector_settles_on_exponential_approach() {
        // T(t) = 70 − 12·e^(−t/20): slope < 0.05 °C/s from t ≈ 50 s on.
        let mut det = SteadyDetector::new(35.0, 120.0);
        let mut result = None;
        for sec in 0..120 {
            let t = sec as f32;
            match det.push(t, 70.0 - 12.0 * (-t / 20.0).exp()) {
                Steady::Pending => {}
                other => {
                    result = Some((t, other));
                    break;
                }
            }
        }
        let (when, st) = result.expect("settles");
        assert!((35.0..=110.0).contains(&when), "settled at {when}s");
        match st {
            Steady::Steady(v) => assert!((v - 70.0).abs() < 1.0, "value {v}"),
            _ => panic!("expected Steady"),
        }
    }

    #[test]
    fn steady_detector_saturates_on_slow_drift() {
        // Linear 0.1 °C/s forever — never steady, must report Saturated at max dwell.
        let mut det = SteadyDetector::new(35.0, 120.0);
        let mut saw = None;
        for sec in 0..200 {
            let t = sec as f32;
            if let Steady::Saturated(_) = det.push(t, 50.0 + 0.1 * t) {
                saw = Some(t);
                break;
            }
        }
        let when = saw.expect("saturates");
        assert!((when - 120.0).abs() <= 2.0, "saturated at {when}s");
    }

    #[test]
    fn passive_correction_is_bounded_and_asymmetric() {
        // Hot residuals: apply, capped at +0.5.
        assert_eq!(passive_correction(&[2.1, 1.9, 2.4, 2.0, 2.2], 0.0), Some(0.5));
        // Mildly hot (≤1.5): no action.
        assert_eq!(passive_correction(&[1.2, 1.0, 1.4, 0.9, 1.3], 0.0), None);
        // Cold needs >2.5 evidence; −2.0 is ignored…
        assert_eq!(passive_correction(&[-2.0, -1.8, -2.2, -2.1, -1.9], 0.0), None);
        // …−3.0 acts, capped at −0.5.
        assert_eq!(passive_correction(&[-3.0, -3.2, -2.8, -3.1, -2.9], 0.0), Some(-0.5));
        // Total drift clamp ±6: already at +6 → hot correction suppressed.
        assert_eq!(passive_correction(&[2.1, 2.0, 2.2, 2.3, 2.1], 6.0), None);
        // Fewer than 5 samples → never act.
        assert_eq!(passive_correction(&[3.0, 3.0], 0.0), None);
    }

    #[test]
    fn degenerate_flat_fit_yields_flat_quiet_curve() {
        // REGRESSION — real field data (9950X3D, busy-system tune, 2026-06-10):
        // the grid was nearly flat (62-67°C across the whole airflow range), the
        // fit honestly said "fans barely matter" (k_c≈0.005), and the floor
        // already held the 69°C target at design power. The synthesizer instead
        // produced a 30%→100% cliff at 60°C (band scheduled BELOW idle temp,
        // solve_iso hugged the envelope, monotonicity dragged every later point
        // up). The honest optimum is a flat floor curve.
        let m = ThermalModel {
            alpha: 0.6,
            t_off: 48.58,
            r_inf: 0.1087,
            k_c: 0.00504,
            k_x: 0.01295,
            rmse: 1.4,
            conservative_shift: 2.1,
        };
        let g = GroupRpm { cpu_max_rpm_sum: 2922.0, case_max_rpm_sum: 9000.0 };
        let s = synthesize_cpu(
            &SynthInput { model: &m, p_design: 135.1, target: 69.0, floor: 0.30, ceil: 1.0, g: &g, has_case: true },
            8.0,
        );
        assert_eq!(s.effective_target, 69.0);
        // Every point at/below the target stays at the quiet floor:
        for p in s.points.iter().filter(|p| p.temp_c <= 69.0 + 0.01) {
            assert!(
                p.w_cpu <= 0.31 && p.w_case <= 0.31,
                "expected flat floor below target, got {:?} at {}°C",
                (p.w_cpu, p.w_case),
                p.temp_c
            );
        }
        // And the result says WHY it is flat:
        assert_eq!(s.warning.as_ref().map(|w| w.kind.as_str()), Some("fansBarelyMatter"));
        for w in s.points.windows(2) {
            assert!(w[1].temp_c > w[0].temp_c && w[1].w_cpu >= w[0].w_cpu);
        }
    }

    #[test]
    fn gpu_assist_flattens_when_case_barely_helps() {
        // Same field tune, GPU axis: r_g fitted to 0, k_g tiny — case airflow
        // moves the GPU well under 2°C end to end. Surging case fans above the
        // GPU target would be pure noise for nothing; the assist must stay flat.
        let g = GpuModel { t_off_g: 54.14, r_g: 0.0, k_g: 0.00646, rmse: 1.34, conservative_shift: 2.3 };
        let s = synthesize_gpu(&g, 104.0, 70.0, 0.30, 1.0);
        for &(temp, w) in &s.points {
            assert!(w <= 0.31, "expected flat assist, got {w} at {temp}°C");
        }
        assert_eq!(s.warning.as_ref().map(|w| w.kind.as_str()), Some("caseBarelyHelpsGpu"));
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
