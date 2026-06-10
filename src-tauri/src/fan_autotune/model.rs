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
}
