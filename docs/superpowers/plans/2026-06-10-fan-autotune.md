# Fan Auto-Tune(风扇智能调优)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Closed-loop fan-curve auto-tuning: measure this machine's real "airflow → steady-state CPU/GPU temp" response under built-in synthetic load, fit a thermal-resistance model, and synthesize per-fan temp→duty curves that pin full-load CPU at the user's target temp (and case fans assist the GPU), within quiet-floor/noise-ceiling preferences, plus passive drift learning.

**Architecture:** A Rust state machine (`fan_autotune/`) drives the existing sensord sidecar through the existing `fan.rs` engine plumbing (reusing `CALIBRATING` exclusivity and `fan_calibrate`'s sweep). All math (fitting, iso-thermal solving, synthesis, steady detection) is pure functions in `model.rs`, unit- and simulation-tested against a virtual plant via a `TuneIo` trait. Output is plain temp→duty curves the existing engine executes; the only engine change is an optional second (GPU) curve per fan combined by `max()`. Frontend adds a wizard modal + zustand store; spec: `docs/superpowers/specs/2026-06-10-fan-autotune-design.md`.

**Tech Stack:** Rust (Tauri 2, parking_lot, once_cell, serde), windows crate D3D11 compute (GPU load), React 19 + zustand 5 + existing UI kit, vitest (new, TS unit tests).

---

## File Structure

**Rust (src-tauri/src/):**
| File | Status | Responsibility |
|---|---|---|
| `fan.rs` | modify | Dual-source curve support (`temp_source_id2`/`curve2`, max-combine); expose `calibrate_headers`, exclusivity helpers, config snapshot/restore, temp-source resolution, `paired_rpm`; call `fan_autotune::passive::tick()` in engine loop |
| `sensors.rs` | modify | Add `latest_readings()` getter (cpu/gpu temp+power) |
| `fan_autotune/model.rs` | create | Pure math: φ, linear solver, CPU/GPU model fit, noise, iso-thermal solve, synthesis, duty inversion, SteadyDetector, passive correction math |
| `fan_autotune/io.rs` | create | `TuneIo` trait + shared types (params/progress/result) + `RealIo` |
| `fan_autotune/mod.rs` | create | State machine `run_tune` (phases, safety net, validation) + Tauri commands |
| `fan_autotune/sim_tests.rs` | create | `#[cfg(test)]` closed-loop simulation tests (virtual plant FakeIo) |
| `fan_autotune/passive.rs` | create | Passive-learning sampler + correction job + commands |
| `load_gen.rs` | create | All-core CPU load generator (RAII) |
| `gpu_load.rs` | create | D3D11 compute-shader GPU load generator (RAII) |
| `lib.rs` | modify | `mod` declarations + command registration |
| `Cargo.toml` | modify | Add D3D11 windows features |

**Frontend (src/):**
| File | Status | Responsibility |
|---|---|---|
| `lib/ipc.ts` | modify | New types + api wrappers; `FanChannelConfig` dual-source fields |
| `lib/autotuneUtils.ts` | create | Pure helpers: fan group classification, param clamps, hand-edit divergence check |
| `lib/autotuneUtils.test.ts` | create | vitest unit tests |
| `store/fanProfiles.ts` | modify | `FanConfig` gains `tempSourceId2`/`curve2`; `toBackend` passes them |
| `store/fanAutotune.ts` | create | Persisted tune result/params/passive log + apply actions |
| `components/fans/AutoTuneWizard.tsx` | create | 3-step wizard modal |
| `tabs/FanControl.tsx` | modify | Wizard entry button, status strip, dual-curve toggle on case-fan cards |
| `package.json` | modify | Add vitest |

**Verification commands used throughout** (run from repo root `C:/Users/Thomas/Documents/Projects/CorePilot`):
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- Rust compile check: `cargo check --manifest-path src-tauri/Cargo.toml`
  - NOTE: a plain first-ever `cargo check`/`build` needs the overlay DLL built once: `cargo build -p corepilot-overlay --release --manifest-path src-tauri/Cargo.toml` (see Cargo.toml header comment). If `target/release/corepilot_overlay.dll` already exists, skip.
- TS typecheck+build: `npm run build` (runs `tsc && vite build`)
- TS unit tests: `npx vitest run`
- NEVER ship via bare `cargo build` — final app builds go through `npx tauri build` (project rule).

---

### Task 1: Engine dual-source curve support (`fan.rs`)

**Files:**
- Modify: `src-tauri/src/fan.rs`

The engine's curve mode gains an optional second (temp source, curve) pair; applied target = `max(primary, secondary)`. Old configs deserialize identically (serde defaults). Primary-source loss keeps today's BIOS fail-safe; secondary loss silently degrades to primary.

- [ ] **Step 1: Write the failing tests**

Append at the end of `src-tauri/src/fan.rs`:

```rust
// --- tests ----------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(curve: Vec<CurvePoint>, curve2: Vec<CurvePoint>) -> FanChannelConfig {
        FanChannelConfig {
            control_id: "lpc/nct/0/control/0".into(),
            mode: "curve".into(),
            manual_pct: 0.0,
            temp_source_id: Some("t1".into()),
            curve,
            min_duty: 0.0,
            spin_up_pct: 100.0,
            spin_down_pct: 100.0,
            temp_source_id2: Some("t2".into()),
            curve2,
        }
    }

    fn pts(v: &[(f32, f32)]) -> Vec<CurvePoint> {
        v.iter().map(|&(temp_c, duty)| CurvePoint { temp_c, duty }).collect()
    }

    #[test]
    fn combined_target_takes_max_of_both_curves() {
        let c = cfg(pts(&[(30.0, 20.0), (80.0, 100.0)]), pts(&[(30.0, 30.0), (80.0, 90.0)]));
        // Primary says 20% at 30°C; secondary at 60°C → 66% — secondary wins.
        assert_eq!(combined_target(&c, 30.0, Some(60.0)).round(), 66.0);
        // Secondary reading missing → primary alone.
        assert_eq!(combined_target(&c, 30.0, None).round(), 20.0);
    }

    #[test]
    fn combined_target_without_curve2_matches_primary_exactly() {
        let mut c = cfg(pts(&[(30.0, 20.0), (80.0, 100.0)]), Vec::new());
        c.temp_source_id2 = None;
        for t in [25.0_f32, 42.5, 80.0, 95.0] {
            assert_eq!(combined_target(&c, t, Some(70.0)), interp(&c.curve, t));
        }
    }

    #[test]
    fn sanitize_clamps_curve2_like_curve() {
        let mut c = cfg(
            pts(&[(30.0, 20.0)]),
            pts(&[(f32::NAN, 250.0), (200.0, -5.0)]),
        );
        c.curve2.extend((0..40).map(|i| CurvePoint { temp_c: i as f32, duty: 50.0 }));
        let s = sanitize_config(&c).expect("curve mode is valid");
        assert!(s.curve2.len() <= MAX_CURVE_POINTS);
        for p in &s.curve2 {
            assert!((0.0..=MAX_CURVE_TEMP_C).contains(&p.temp_c));
            assert!((0.0..=100.0).contains(&p.duty));
        }
    }

    #[test]
    fn legacy_config_json_without_dual_source_fields_deserializes() {
        let j = r#"{"controlId":"a/control/0","mode":"curve","curve":[{"tempC":30,"duty":20}]}"#;
        let c: FanChannelConfig = serde_json::from_str(j).expect("legacy shape parses");
        assert!(c.temp_source_id2.is_none());
        assert!(c.curve2.is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan::tests`
Expected: COMPILE ERROR — `temp_source_id2`, `curve2`, `combined_target` not defined.

- [ ] **Step 3: Implement dual-source support**

In `src-tauri/src/fan.rs`, make three edits:

3a. Extend `FanChannelConfig` (after the `spin_down_pct` field):

```rust
    /// Optional SECOND temperature source (e.g. GPU core) for dual-source curves.
    /// The applied duty is max(curve@source, curve2@source2). Defaults keep old
    /// configs byte-identical in behavior.
    #[serde(default)]
    pub temp_source_id2: Option<String>,
    #[serde(default)]
    pub curve2: Vec<CurvePoint>,
```

3b. Add the pure combinator right after `fn interp(...)`:

```rust
/// Curve-mode duty target: primary curve at `t1`, optionally raised by the
/// secondary curve at `t2` (dual-source, e.g. case fans assisting the GPU).
/// A missing secondary reading silently degrades to the primary alone — a
/// sleeping/removed GPU must never destabilize a case fan.
fn combined_target(c: &FanChannelConfig, t1: f32, t2: Option<f32>) -> f32 {
    let base = interp(&c.curve, t1);
    match (c.curve2.is_empty(), t2) {
        (false, Some(t)) => base.max(interp(&c.curve2, t)),
        _ => base,
    }
}
```

3c. In `apply_once()`'s `"curve"` arm, replace the line
`let target = interp(&c.curve, t).clamp(floor, 100.0);` with:

```rust
                let t2 = c
                    .temp_source_id2
                    .as_ref()
                    .and_then(|src| temps.get(src).copied());
                let target = combined_target(c, t, t2).clamp(floor, 100.0);
```

3d. In `sanitize_config`, after the `curve` binding add:

```rust
    let curve2: Vec<CurvePoint> = c
        .curve2
        .iter()
        .take(MAX_CURVE_POINTS)
        .map(|p| CurvePoint {
            temp_c: clamp_finite(p.temp_c, 0.0, MAX_CURVE_TEMP_C),
            duty: clamp_finite(p.duty, 0.0, 100.0),
        })
        .collect();
```

and extend the returned struct literal with:

```rust
        temp_source_id2: c.temp_source_id2.clone(),
        curve2,
```

3e. `CurvePoint` is about to cross IPC in both directions (results carry synthesized curves). Change its derive to:

```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurvePoint {
```

and give `CalibPoint` + `FanCalibration` round-trip derives (passive learning re-ingests them):

```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalibPoint {
```

```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FanCalibration {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan::tests`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fan.rs
git commit -m "feat(fan): dual-source curve support — optional GPU-driven curve2, max-combined"
```

---

### Task 2: Engine seams for the auto-tuner (`fan.rs`, `sensors.rs`)

**Files:**
- Modify: `src-tauri/src/fan.rs`
- Modify: `src-tauri/src/sensors.rs`

Behavior-neutral refactor: expose what the tuner needs — in-process calibration, exclusivity, config snapshot/restore, temp snapshot, source-id resolution, paired RPM.

- [ ] **Step 1: Extract `calibrate_headers` and add crate-visible helpers in `fan.rs`**

2a. In `fan_calibrate`, replace the `spawn_blocking` closure body

```rust
        let total = targets.len();
        let mut out = Vec::with_capacity(total);
        for (i, id) in targets.iter().enumerate() {
            out.push(calibrate_one(&app, id, i, total));
        }
        out
```

with `calibrate_headers(&app, &targets)` and add above `fan_calibrate`:

```rust
/// Sweep the given headers in sequence (caller must already hold calibration
/// exclusivity — i.e. `CALIBRATING` is true). Shared by the `fan_calibrate`
/// command and the auto-tune state machine.
pub(crate) fn calibrate_headers(app: &tauri::AppHandle, targets: &[String]) -> Vec<FanCalibration> {
    let total = targets.len();
    let mut out = Vec::with_capacity(total);
    for (i, id) in targets.iter().enumerate() {
        out.push(calibrate_one(app, id, i, total));
    }
    out
}
```

2b. Add next to the `CALIBRATING` static:

```rust
/// Try to take exclusive manual control of the fans (pauses the engine).
/// Returns false if a calibration/tune already holds it.
pub(crate) fn exclusive_begin() -> bool {
    !CALIBRATING.swap(true, Ordering::SeqCst)
}

/// Release exclusivity and force the engine to re-apply the user's config
/// (mirrors the tail of `fan_calibrate`).
pub(crate) fn exclusive_end() {
    CALIBRATING.store(false, Ordering::SeqCst);
    LAST.lock().clear();
    CURVE_DUTY.lock().clear();
    apply_once();
}

/// Snapshot / restore the engine's per-fan configuration (tune abort path).
pub(crate) fn config_snapshot() -> Vec<FanChannelConfig> {
    FAN_CONFIG.lock().clone()
}
pub(crate) fn config_restore(cfgs: Vec<FanChannelConfig>) {
    *FAN_CONFIG.lock() = cfgs;
}

/// Latest temperature readings by sensor id (curve sources).
pub(crate) fn temps_by_id() -> HashMap<String, f32> {
    SNAP.lock()
        .temps
        .iter()
        .filter_map(|(id, _, v)| v.map(|x| (id.clone(), x)))
        .collect()
}

/// Resolve the preferred CPU (Tctl/Tdie-ish) and GPU temperature sensor ids
/// from the live snapshot, for binding synthesized curves.
pub(crate) fn resolve_source_ids() -> (Option<String>, Option<String>) {
    let raw = SNAP.lock();
    let find = |pats: &[&str]| -> Option<String> {
        for pat in pats {
            if let Some((id, _, _)) = raw
                .temps
                .iter()
                .find(|(_, name, v)| v.is_some() && name.to_lowercase().contains(pat))
            {
                return Some(id.clone());
            }
        }
        None
    };
    let cpu = find(&["tctl", "tdie", "cpu package", "package", "cpu"]);
    let gpu = find(&["gpu core", "gpu"]);
    (cpu, gpu)
}
```

2c. Change `fn paired_rpm` and `fn controllable_ids` from private to `pub(crate) fn` (same bodies). Also make `send_set` crate-visible: `pub(crate) fn send_set(id: &str, pct: f32)`.

2d. `apply_once` recomputes `temps` itself — replace its inline temps construction with a call to the new helper so there is one source of truth:

```rust
    let temps: HashMap<String, f32> = temps_by_id();
```

- [ ] **Step 2: Add `latest_readings()` to `sensors.rs`**

After `pub fn cpu_sensors()` (line ~310) add:

```rust
/// Latest sidecar power/temperature readings as (cpu_temp, cpu_power, gpu_temp,
/// gpu_power). All `None` until the sidecar produces them.
pub fn latest_readings() -> (Option<f32>, Option<f32>, Option<f32>, Option<f32>) {
    let s = SIDECAR.lock();
    (s.cpu_temp, s.cpu_power, s.gpu_temp, s.gpu_power)
}
```

- [ ] **Step 3: Verify it still compiles and existing tests pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan::tests`
Expected: 4 passed (refactor is behavior-neutral; `cargo check` clean, only possibly `dead_code` warnings for not-yet-used helpers).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/fan.rs src-tauri/src/sensors.rs
git commit -m "refactor(fan): expose calibration/exclusivity/temp seams for auto-tune"
```

---

### Task 3: Math module — fitting (`fan_autotune/model.rs`)

**Files:**
- Create: `src-tauri/src/fan_autotune/mod.rs` (stub)
- Create: `src-tauri/src/fan_autotune/model.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create module scaffolding**

Create `src-tauri/src/fan_autotune/mod.rs` containing (for now):

```rust
//! Fan auto-tune: closed-loop thermal characterization → curve synthesis.
//! Spec: docs/superpowers/specs/2026-06-10-fan-autotune-design.md

pub mod model;
```

In `src-tauri/src/lib.rs`, next to the other `mod` items (`mod fan;` etc.) add:

```rust
mod fan_autotune;
mod load_gen;
mod gpu_load;
```

…but since `load_gen.rs`/`gpu_load.rs` don't exist yet, add only `mod fan_autotune;` now; the other two arrive in Tasks 8–9.

- [ ] **Step 2: Write the failing fit tests**

Create `src-tauri/src/fan_autotune/model.rs` with the test module first (implementation lands in Step 4 — paste the tests at the bottom of the file; the `use super::*;` items don't exist yet):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Generate grid samples from a known model + noise; fit must recover it.
    fn synth_samples(m: &ThermalModel, noise: f32) -> Vec<FitSample> {
        let mut out = Vec::new();
        let mut sign = 1.0_f32;
        for (i, &wc) in [1.0_f32, 0.75, 0.5, 0.35].iter().enumerate() {
            for (j, &wx) in [1.0_f32, 0.6, 0.3].iter().enumerate() {
                let p = 195.0 + ((i * 3 + j) as f32 % 4.0_f32 as usize as f32);
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
            if s.w_case < 0.5 { s.t -= 0.3; } // nudge toward negative k_x
        }
        let m = fit_cpu_model(&samples, true).expect("fit");
        assert!(m.k_x >= 0.0 && m.k_c >= 0.0 && m.r_inf >= 0.01);
    }

    #[test]
    fn fit_without_case_group_uses_three_params() {
        let base = ThermalModel { k_x: 0.0, ..truth() };
        let samples: Vec<FitSample> = synth_samples(&base, 0.2)
            .into_iter()
            .map(|mut s| { s.w_case = 0.0; s })
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan_autotune::model`
Expected: COMPILE ERROR — types/functions not defined.

- [ ] **Step 4: Implement types, φ, solver, and the two fits**

Fill the top of `src-tauri/src/fan_autotune/model.rs` (above the test module):

```rust
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
        self.t_off + p * (self.r_inf + self.k_c * phi(w_cpu, self.alpha) + self.k_x * phi(w_case, self.alpha))
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
/// excluded and their fixed contribution pre-subtracted from `y` by the caller).
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

/// Fit the CPU thermal model (spec §4): enumerate α, linear NNLS-style solve
/// (clamp negatives to bound + refit, ≤3 passes), pick min-RSS α, then raise
/// `t_off` by max(0, P90(residuals)) so the model errs on the hot side.
pub fn fit_cpu_model(samples: &[FitSample], has_case: bool) -> Option<ThermalModel> {
    let n_params = if has_case { 4 } else { 3 };
    if samples.len() < n_params + 1 {
        return None;
    }
    let mut best: Option<(f64, ThermalModel)> = None;

    for &alpha in &ALPHAS {
        // Columns: [t_off, r_inf, k_c, (k_x)] with features [1, P, P·φc, P·φx].
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

        // Bounds: t_off ∈ [10,50] (not clamped during solve; sanity-checked
        // after), r_inf ≥ 0.01, k_c ≥ 0, k_x ≥ 0.
        let lo = if has_case {
            vec![f64::NEG_INFINITY, 0.01, 0.0, 0.0]
        } else {
            vec![f64::NEG_INFINITY, 0.01, 0.0]
        };
        let mut free = vec![true; n_params];
        let mut fixed = vec![0.0_f64; n_params];
        let mut theta: Option<Vec<f64>> = None;
        for _pass in 0..3 {
            // Subtract fixed columns' contribution.
            let y: Vec<f64> = xs
                .iter()
                .zip(&y0)
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
            let sol = ols(&xs, &y, &free)?;
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
        let th = theta?;
        let t_off = (th[0] as f32).clamp(10.0, 50.0);
        let m = ThermalModel {
            alpha,
            t_off,
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
    let lo = [f64::NEG_INFINITY, 0.0, 0.0];
    let mut free = vec![true; 3];
    let mut fixed = vec![0.0_f64; 3];
    let mut theta: Option<Vec<f64>> = None;
    for _ in 0..3 {
        let y: Vec<f64> = xs
            .iter()
            .zip(&y0)
            .map(|(row, &yv)| {
                let mut v = yv;
                for c in 0..3 {
                    if !free[c] {
                        v -= row[c] * fixed[c];
                    }
                }
                v
            })
            .collect();
        let sol = ols(&xs, &y, &free)?;
        let mut clamped = false;
        for c in 0..3 {
            if free[c] && sol[c] < lo[c] {
                free[c] = false;
                fixed[c] = lo[c];
                clamped = true;
            }
        }
        theta = Some((0..3).map(|c| if free[c] { sol[c] } else { fixed[c] }).collect());
        if !clamped {
            break;
        }
    }
    let th = theta?;
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan_autotune::model`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/fan_autotune/ src-tauri/src/lib.rs
git commit -m "feat(autotune): thermal-model types + CPU/GPU least-squares fitting"
```

---

### Task 4: Math module — iso-thermal solver, feasibility, synthesis

**Files:**
- Modify: `src-tauri/src/fan_autotune/model.rs`

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `model.rs`:

```rust
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
        // Tight ceiling 40% + ambitious 70°C target → infeasible under ceiling
        // but feasible at 100% (cooler itself is fine).
        let s = synthesize_cpu(&synth_input(&m, &g, 70.0, 0.4), 8.0);
        let w = s.warning.expect("warning expected");
        assert_eq!(w.kind, "ceilingInsufficient");
        assert!(s.effective_target > 70.0);
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
        assert!(g.predict(330.0, ok.points.iter().find(|p| (p.0 - ok.effective_target_g).abs() < 0.01).unwrap().1) <= ok.effective_target_g + 0.1);
        // Case fans can't do much for a hot GPU → honest warning:
        let weak = GpuModel { r_g: 0.2, k_g: 0.005, ..g };
        let bad = synthesize_gpu(&weak, 330.0, 70.0, 0.25, 1.0);
        assert_eq!(bad.warning.expect("warn").kind, "caseCantHelpGpu");
        assert!(bad.effective_target_g > 70.0);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan_autotune::model`
Expected: COMPILE ERROR — `GroupRpm`, `noise`, `solve_iso`, `SynthInput`, `synthesize_cpu`, `synthesize_gpu`, `TuneWarning` undefined.

- [ ] **Step 3: Implement solver + synthesis**

Add to `model.rs` (above the tests):

```rust
/// Σ maxRpm per group — the noise weights (spec §4: N = Σ (w·maxRpm/1000)²).
#[derive(Clone, Copy, Debug)]
pub struct GroupRpm {
    pub cpu_max_rpm_sum: f32,
    pub case_max_rpm_sum: f32,
}

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
/// temperature and non-decreasing in airflow.
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
            message_zh: format!("散热器能力不足:满载即使风扇全速也只能压到约 {achievable:.1}°C,曲线已锚定全速"),
            message_en: format!("Cooler insufficient: even at 100% fans full load only reaches ≈{achievable:.1}°C; curve anchored at full speed"),
            achievable_c: Some(achievable),
        });
        achievable + 1.0
    } else {
        let achievable = t_at_ceil;
        warning = Some(TuneWarning {
            kind: "ceilingInsufficient".into(),
            message_zh: format!("噪音上限 {:.0}% 内满载最低只能压到约 {achievable:.1}°C(目标 {:.0}°C)", ceil * 100.0, inp.target),
            message_en: format!("Within the {:.0}% noise ceiling full load only reaches ≈{achievable:.1}°C (target {:.0}°C)", ceil * 100.0, inp.target),
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

    if p_knee >= inp.p_design {
        // Floor holds everything: flat curve + emergency ramp (spec §5.4).
        points.push(WPoint { temp_c: t_low, w_cpu: floor, w_case: floor });
    } else {
        points.push(WPoint { temp_c: t_low, w_cpu: floor, w_case: floor });
        let mut prev_t = t_low;
        for j in 1..=5 {
            let f = j as f32 / 5.0;
            let p_j = p_knee + (inp.p_design - p_knee) * f;
            let mut t_j = t_low + band_c * f.powf(1.5);
            // Clamp into the feasibility envelope, then keep strictly increasing.
            let t_env = m.predict(p_j, ceil, wx_of(ceil)) + 0.3;
            t_j = t_j.max(t_env).max(prev_t + 0.2);
            prev_t = t_j;
            let (wc, wx) = solve_iso(m, p_j, t_j, floor, ceil, inp.g, inp.has_case)
                .unwrap_or(w_req);
            points.push(WPoint { temp_c: t_j, w_cpu: wc, w_case: wx });
        }
    }

    // 4. Emergency ramp above target: ceiling at +3, full (ignore ceiling) at +6.
    points.push(WPoint { temp_c: effective_target + 3.0, w_cpu: ceil, w_case: if inp.has_case { ceil } else { floor } });
    points.push(WPoint { temp_c: effective_target + 6.0, w_cpu: 1.0, w_case: if inp.has_case { 1.0 } else { floor } });

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
pub fn synthesize_gpu(m: &GpuModel, p_design_g: f32, target_g: f32, floor: f32, ceil: f32) -> GpuSynth {
    let t_at_ceil = m.predict(p_design_g, ceil);
    let mut warning = None;
    let effective = if t_at_ceil <= target_g {
        target_g
    } else {
        warning = Some(TuneWarning {
            kind: "caseCantHelpGpu".into(),
            message_zh: format!("机箱风量帮不动 GPU:上限内 GPU 满载最低约 {t_at_ceil:.1}°C(显卡自身风扇为主,机箱只能辅助)"),
            message_en: format!("Case airflow can't hold the GPU: ≈{t_at_ceil:.1}°C minimum at full GPU load within the ceiling (the GPU's own cooler dominates)"),
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan_autotune::model`
Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fan_autotune/model.rs
git commit -m "feat(autotune): iso-thermal solver + CPU/GPU curve synthesis with feasibility warnings"
```

---

### Task 5: Math module — duty inversion, per-fan mapping, steady detector, passive math

**Files:**
- Modify: `src-tauri/src/fan_autotune/model.rs`

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests`:

```rust
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
        assert_eq!(duty_for_rpm_fraction(&c.points, 0.0, c.min_start_duty, c.max_rpm), 20.0); // floor = max(MIN_SAFE_DUTY, start)
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
        // T(t) = 70 − 12·e^(−t/20): slope < 0.05 °C/s from t ≈ 20·ln(0.6/0.05) ≈ 50 s.
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
        assert!(when >= 35.0 && when <= 110.0, "settled at {when}s");
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
            if let Steady::Saturated(v) = det.push(t, 50.0 + 0.1 * t) {
                saw = Some((t, v));
                break;
            }
        }
        let (when, _) = saw.expect("saturates");
        assert!((when - 120.0).abs() <= 2.0);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan_autotune::model`
Expected: COMPILE ERROR — `duty_for_rpm_fraction`, `Group`, `TunedFanCurve`, `map_group_curves`, `SteadyDetector`, `Steady`, `passive_correction` undefined.

- [ ] **Step 3: Implement**

Add to `model.rs` (above the tests):

```rust
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
            let duty = if span <= 0.0 { b.duty } else { a.duty + (target - a.rpm) / span * (b.duty - a.duty) };
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
/// own calibration (spec §5.6/§5.7). `gpu_points` is the case group's assist
/// curve, None when the GPU axis was skipped.
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
        let floor_w = cpu_points.first().map(|p| if *group == Group::Cpu { p.w_cpu } else { p.w_case }).unwrap_or(0.25);
        out.push(TunedFanCurve {
            control_id: id.clone(),
            group: *group,
            curve,
            curve2,
            min_duty: duty_at(floor_w),
            spin_up_pct: 70.0,
            spin_down_pct: 30.0,
        });
    }
    out
}

// --- steady-state detection (spec §3 阶段 2) -------------------------------------

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
/// up (Saturated) at `max_dwell_s`. Feed ~1 Hz samples.
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
        let (min, max) = win.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &(_, v)| (lo.min(v), hi.max(v)));
        if slope.abs() < 0.05 && (max - min) < 0.8 {
            Steady::Steady(self.tail_mean(10))
        } else {
            Steady::Pending
        }
    }
}

// --- passive-learning math (spec §7) ---------------------------------------------

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan_autotune::model`
Expected: 19 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fan_autotune/model.rs
git commit -m "feat(autotune): duty inversion, per-fan curve mapping, steady detector, passive math"
```

---

### Task 6: CPU load generator (`load_gen.rs`)

**Files:**
- Create: `src-tauri/src/load_gen.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/load_gen.rs`:

```rust
//! All-core synthetic CPU load for thermal characterization (spec §3 阶段 3):
//! one BELOW_NORMAL-priority thread per logical core running a register-only
//! integer mul-add loop (CPU-Z style — no memory traffic, no AVX power-virus).
//! RAII: dropping the handle stops and joins every worker, so a panicking tune
//! thread can never leave the CPU pinned.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

pub struct CpuLoad {
    stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
}

impl CpuLoad {
    pub fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
        let handles = (0..n)
            .map(|i| {
                let stop = Arc::clone(&stop);
                std::thread::Builder::new()
                    .name(format!("cpu-load-{i}"))
                    .spawn(move || {
                        lower_thread_priority();
                        let mut acc: u64 = 0x9e37_79b9_7f4a_7c15 ^ i as u64;
                        while !stop.load(Ordering::Relaxed) {
                            // Register-only integer chain; black_box defeats
                            // the optimizer without touching memory.
                            for _ in 0..4096 {
                                acc = acc.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                                acc ^= acc >> 33;
                            }
                            std::hint::black_box(acc);
                        }
                    })
                    .expect("spawn cpu-load worker")
            })
            .collect();
        Self { stop, handles }
    }
}

impl Drop for CpuLoad {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
    }
}

/// Below-normal priority: workers saturate idle cores but yield instantly to
/// the UI, the sidecar, and the tune thread itself.
fn lower_thread_priority() {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn cpu_load_starts_and_stops_promptly() {
        let load = CpuLoad::start();
        std::thread::sleep(Duration::from_millis(150));
        let begin = Instant::now();
        drop(load); // must join every worker quickly
        assert!(begin.elapsed() < Duration::from_secs(2), "drop hung");
    }
}
```

In `src-tauri/src/lib.rs` add `mod load_gen;` next to `mod fan_autotune;`.

- [ ] **Step 2: Run the test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib load_gen`
Expected: 1 passed (implementation and test land together here; the RAII join IS the behavior under test).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/load_gen.rs src-tauri/src/lib.rs
git commit -m "feat(autotune): all-core CPU load generator with RAII guard"
```

---

### Task 7: GPU load generator (`gpu_load.rs`)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/gpu_load.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add D3D11 windows features**

In `src-tauri/Cargo.toml`, extend the `windows` dependency's `features` array with:

```toml
"Win32_Graphics_Direct3D", "Win32_Graphics_Direct3D11", "Win32_Graphics_Direct3D_Fxc",
```

- [ ] **Step 2: Implement the generator**

Create `src-tauri/src/gpu_load.rs`:

```rust
//! Synthetic GPU load for the GPU thermal axis (spec §3 阶段 3b): a D3D11
//! compute shader doing long fma chains, dispatched in a loop on the adapter
//! with the most dedicated VRAM (skips iGPU / Microsoft Basic Render).
//! Start returns Err on any failure — the tuner then SKIPS the GPU axis
//! (degrade, never abort). RAII: drop stops and joins the dispatch thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use windows::core::PCSTR;
use windows::Win32::Foundation::FALSE;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{ID3DBlob, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Buffer, ID3D11ComputeShader, ID3D11Device, ID3D11DeviceContext,
    ID3D11UnorderedAccessView, D3D11_BIND_UNORDERED_ACCESS, D3D11_BUFFER_DESC,
    D3D11_BUFFER_UAV, D3D11_CREATE_DEVICE_FLAG, D3D11_RESOURCE_MISC_BUFFER_STRUCTURED,
    D3D11_SDK_VERSION, D3D11_UAV_DIMENSION_BUFFER, D3D11_UNORDERED_ACCESS_VIEW_DESC,
    D3D11_UNORDERED_ACCESS_VIEW_DESC_0, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1};

const SHADER: &str = r#"
RWStructuredBuffer<float> buf : register(u0);
[numthreads(256, 1, 1)]
void main(uint3 id : SV_DispatchThreadID) {
    float a = buf[id.x % 1048576] + 1.0001f;
    [loop] for (uint i = 0; i < 4096; i++) {
        a = a * 1.0000001f + 0.5f;
        a = a * 0.9999999f - 0.4999f;
    }
    buf[id.x % 1048576] = a;
}
"#;

pub struct GpuLoad {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl GpuLoad {
    /// Spin up the dispatch thread. Err = no usable discrete adapter / device /
    /// shader — caller treats it as "skip the GPU axis".
    pub fn start() -> Result<Self, String> {
        // Probe synchronously so failure is immediate and typed…
        let adapter = pick_adapter()?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = Arc::clone(&stop);
        let handle = std::thread::Builder::new()
            .name("gpu-load".into())
            .spawn(move || {
                if let Ok((_device, ctx)) = build_pipeline(&adapter) {
                    while !stop2.load(Ordering::Relaxed) {
                        unsafe {
                            ctx.Dispatch(4096, 1, 1);
                            ctx.Flush();
                        }
                        // Brief yield so the queue stays deep but we can stop fast.
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                }
            })
            .map_err(|e| format!("spawn gpu-load thread: {e}"))?;
        Ok(Self { stop, handle: Some(handle) })
    }
}

impl Drop for GpuLoad {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Adapter with the most dedicated VRAM (the discrete GPU on a desktop).
fn pick_adapter() -> Result<IDXGIAdapter1, String> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| format!("dxgi factory: {e}"))?;
        let mut best: Option<(usize, IDXGIAdapter1)> = None;
        let mut i = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            let desc = adapter.GetDesc1().map_err(|e| format!("adapter desc: {e}"))?;
            let name = String::from_utf16_lossy(&desc.Description)
                .trim_end_matches('\0')
                .to_string();
            if name.to_lowercase().contains("microsoft basic render") {
                continue;
            }
            let vram = desc.DedicatedVideoMemory;
            if best.as_ref().map(|(v, _)| vram > *v).unwrap_or(true) {
                best = Some((vram, adapter));
            }
        }
        let (vram, adapter) = best.ok_or("no DXGI adapter")?;
        if vram < 512 * 1024 * 1024 {
            return Err("no discrete GPU (max dedicated VRAM < 512 MB)".into());
        }
        Ok(adapter)
    }
}

/// Device + compiled compute shader + bound UAV buffer, ready to Dispatch.
fn build_pipeline(adapter: &IDXGIAdapter1) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    unsafe {
        let mut device: Option<ID3D11Device> = None;
        let mut ctx: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            None,
            D3D11_CREATE_DEVICE_FLAG(0),
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )
        .map_err(|e| format!("create device: {e}"))?;
        let device = device.ok_or("device is None")?;
        let ctx = ctx.ok_or("context is None")?;

        let mut blob: Option<ID3DBlob> = None;
        let mut errs: Option<ID3DBlob> = None;
        D3DCompile(
            SHADER.as_ptr() as *const _,
            SHADER.len(),
            None,
            None,
            None,
            PCSTR(b"main\0".as_ptr()),
            PCSTR(b"cs_5_0\0".as_ptr()),
            0,
            0,
            &mut blob,
            Some(&mut errs),
        )
        .map_err(|e| format!("compile cs: {e}"))?;
        let blob = blob.ok_or("no shader blob")?;
        let bytecode = std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize());

        let mut shader: Option<ID3D11ComputeShader> = None;
        device
            .CreateComputeShader(bytecode, None, Some(&mut shader))
            .map_err(|e| format!("create cs: {e}"))?;
        let shader = shader.ok_or("no compute shader")?;

        const ELEMS: u32 = 1 << 20; // 1M floats = 4 MB scratch
        let desc = D3D11_BUFFER_DESC {
            ByteWidth: ELEMS * 4,
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_UNORDERED_ACCESS.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: D3D11_RESOURCE_MISC_BUFFER_STRUCTURED.0 as u32,
            StructureByteStride: 4,
        };
        let mut buffer: Option<ID3D11Buffer> = None;
        device
            .CreateBuffer(&desc, None, Some(&mut buffer))
            .map_err(|e| format!("create buffer: {e}"))?;
        let buffer = buffer.ok_or("no buffer")?;

        let uav_desc = D3D11_UNORDERED_ACCESS_VIEW_DESC {
            Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_UNKNOWN,
            ViewDimension: D3D11_UAV_DIMENSION_BUFFER,
            Anonymous: D3D11_UNORDERED_ACCESS_VIEW_DESC_0 {
                Buffer: D3D11_BUFFER_UAV { FirstElement: 0, NumElements: ELEMS, Flags: 0 },
            },
        };
        let mut uav: Option<ID3D11UnorderedAccessView> = None;
        device
            .CreateUnorderedAccessView(&buffer, Some(&uav_desc), Some(&mut uav))
            .map_err(|e| format!("create uav: {e}"))?;
        let uav = uav.ok_or("no uav")?;

        ctx.CSSetShader(&shader, None);
        ctx.CSSetUnorderedAccessViews(0, 1, Some(&Some(uav)), None);
        let _ = FALSE; // (keep the import used on all toolchains)
        Ok((device, ctx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hardware smoke test — needs a discrete GPU, so it is ignored by default.
    /// Run manually: cargo test --lib gpu_load -- --ignored
    #[test]
    #[ignore]
    fn gpu_load_runs_and_stops_on_real_hardware() {
        let load = GpuLoad::start().expect("discrete GPU present");
        std::thread::sleep(std::time::Duration::from_secs(3));
        drop(load);
    }
}
```

In `src-tauri/src/lib.rs` add `mod gpu_load;`.

NOTE for the implementer: the `windows` 0.62 D3D11 signatures occasionally differ in `Option`/reference wrapping — if `cargo check` complains, adjust the call-site wrapping only; keep the semantics (adapter pick by VRAM → device → cs_5_0 compile → structured UAV → Dispatch loop) exactly as written.

- [ ] **Step 3: Verify it compiles (and existing tests still pass)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: all previous tests pass; `gpu_load` test is ignored. Optionally on this 9950X3D + dGPU machine: `cargo test --manifest-path src-tauri/Cargo.toml --lib gpu_load -- --ignored` → 1 passed.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/gpu_load.rs src-tauri/src/lib.rs
git commit -m "feat(autotune): D3D11 compute-shader GPU load generator"
```

---

### Task 8: Tune I/O abstraction + shared IPC types (`fan_autotune/io.rs`)

**Files:**
- Create: `src-tauri/src/fan_autotune/io.rs`
- Modify: `src-tauri/src/fan_autotune/mod.rs`

The `TuneIo` trait is the test seam (spec §8): the state machine only talks to the world through it. `RealIo` reads the sidecar snapshots and drives fans via `fan::send_set`; the sim tests (Task 9) implement a virtual plant.

- [ ] **Step 1: Create `io.rs`**

```rust
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
```

In `fan_autotune/mod.rs` add `pub mod io;` under `pub mod model;`.

- [ ] **Step 2: Verify it compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: clean (warnings about unused items are fine until Task 9 consumes them).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/fan_autotune/
git commit -m "feat(autotune): TuneIo seam, RealIo, and shared tune IPC types"
```

---

### Task 9: State machine + closed-loop simulation tests

**Files:**
- Modify: `src-tauri/src/fan.rs` (one-line visibility change)
- Modify: `src-tauri/src/fan_autotune/mod.rs`
- Create: `src-tauri/src/fan_autotune/sim_tests.rs`

- [ ] **Step 1: Make `fan::interp` crate-visible**

In `src-tauri/src/fan.rs` change `fn interp(` to `pub(crate) fn interp(` (the tuner's validation drive reuses the exact engine interpolation — no duplicate math).

- [ ] **Step 2: Write the failing simulation tests**

Create `src-tauri/src/fan_autotune/sim_tests.rs`:

```rust
//! Closed-loop simulation tests: a first-order virtual plant behind TuneIo.
//! These are the spec §10 guarantees — convergence, honesty, degradation, abort.

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
            t_amb: 28.0, r_inf: 0.12, k_c: 0.10, k_x: 0.04, alpha: 0.8, tau_cpu: 30.0,
            p_idle: 45.0, p_load: 210.0,
            gpu_t_amb: 30.0, gpu_r: 0.09, gpu_k: 0.03, gpu_tau: 40.0,
            p_gpu_idle: 25.0, p_gpu_load: 330.0, couple_c: 4.0,
        }
    }
    fn t_cpu_ss(&self, p: f32, w_cpu: f32, w_case: f32, gpu_w: f32) -> f32 {
        self.t_amb
            + p * (self.r_inf + self.k_c * phi(w_cpu, self.alpha) + self.k_x * phi(w_case, self.alpha))
            + self.couple_c * (gpu_w / self.p_gpu_load)
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
    duties: HashMap<String, f32>,
    fans: Vec<(String, Group)>,
    cpu_on: bool,
    gpu_on: bool,
    gpu_start_ok: bool,
    abort_after_s: Option<f64>,
    progress: Vec<AutoTuneProgress>,
}

impl FakeIo {
    fn new(plant: Plant) -> Self {
        let fans = vec![
            ("cpu0".to_string(), Group::Cpu),
            ("case0".to_string(), Group::Case),
            ("case1".to_string(), Group::Case),
        ];
        let t0 = plant.t_cpu_ss(plant.p_idle, 0.4, 0.4, 0.0);
        let g0 = plant.t_gpu_ss(plant.p_gpu_idle, 0.4);
        Self {
            plant, time_s: 0.0, t_cpu: t0, t_gpu: g0,
            duties: HashMap::new(), fans,
            cpu_on: false, gpu_on: false, gpu_start_ok: true,
            abort_after_s: None, progress: Vec::new(),
        }
    }

    fn group_w(&self, g: Group) -> f32 {
        let members: Vec<f32> = self
            .fans
            .iter()
            .filter(|(_, fg)| *fg == g)
            .map(|(id, _)| self.duties.get(id).copied().unwrap_or(40.0) / 100.0)
            .collect();
        if members.is_empty() { 0.0 } else { members.iter().sum::<f32>() / members.len() as f32 }
    }

    fn step(&mut self, dt: f32) {
        let w_cpu = self.group_w(Group::Cpu);
        let w_case = self.group_w(Group::Case);
        let p = if self.cpu_on { self.plant.p_load } else { self.plant.p_idle };
        let pg = if self.gpu_on { self.plant.p_gpu_load } else { self.plant.p_gpu_idle };
        let cpu_ss = self.plant.t_cpu_ss(p, w_cpu, w_case, if self.gpu_on { self.plant.p_gpu_load } else { 0.0 });
        let gpu_ss = self.plant.t_gpu_ss(pg, w_case);
        self.t_cpu += (cpu_ss - self.t_cpu) * (1.0 - (-dt / self.plant.tau_cpu).exp());
        self.t_gpu += (gpu_ss - self.t_gpu) * (1.0 - (-dt / self.plant.gpu_tau).exp());
    }

    fn linear_calib(id: &str) -> FanCalibration {
        let points = (0..=10)
            .map(|i| CalibPoint { duty: i as f32 * 10.0, rpm: 2000.0 * i as f32 / 10.0 })
            .collect();
        FanCalibration {
            control_id: id.into(), name: id.into(),
            min_start_duty: 10.0, max_rpm: 2000.0, saturation_duty: 100.0,
            points, disconnected: false,
        }
    }
}

impl TuneIo for FakeIo {
    fn now_s(&self) -> f32 { self.time_s as f32 }
    fn sleep_s(&mut self, s: f32) {
        let mut left = s;
        while left > 0.0 {
            let dt = left.min(0.5);
            self.step(dt);
            self.time_s += dt as f64;
            left -= dt;
        }
    }
    fn cpu_temp(&self) -> Option<f32> { Some(self.t_cpu) }
    fn cpu_power(&self) -> Option<f32> {
        Some(if self.cpu_on { self.plant.p_load } else { self.plant.p_idle })
    }
    fn gpu_temp(&self) -> Option<f32> { Some(self.t_gpu) }
    fn gpu_power(&self) -> Option<f32> {
        Some(if self.gpu_on { self.plant.p_gpu_load } else { self.plant.p_gpu_idle })
    }
    fn cpu_load_pct(&self) -> Option<f32> { Some(if self.cpu_on { 99.0 } else { 3.0 }) }
    fn set_fan_duty(&mut self, id: &str, pct: f32) { self.duties.insert(id.into(), pct); }
    fn start_cpu_load(&mut self) -> bool { self.cpu_on = true; true }
    fn stop_cpu_load(&mut self) { self.cpu_on = false; }
    fn start_gpu_load(&mut self) -> bool {
        if self.gpu_start_ok { self.gpu_on = true; }
        self.gpu_start_ok
    }
    fn stop_gpu_load(&mut self) { self.gpu_on = false; }
    fn calibrate(&mut self, ids: &[String]) -> Vec<FanCalibration> {
        ids.iter().map(|id| Self::linear_calib(id)).collect()
    }
    fn emit_progress(&self, _p: &AutoTuneProgress) {}
    fn abort_requested(&self) -> bool {
        self.abort_after_s.map(|t| self.time_s > t).unwrap_or(false)
    }
    fn wall_jump_s(&self) -> f32 { 0.0 }
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
    assert!(r.warnings.iter().all(|w| w.kind != "coolerInsufficient" && w.kind != "ceilingInsufficient"));
    assert!(r.grid.iter().filter(|p| !p.skipped).count() >= 8);
    assert!(r.model_gpu.is_some() && r.effective_target_gpu.is_some());
    assert_eq!(r.curves.len(), 3);
    assert!(r.curves.iter().filter(|c| c.group == Group::Case).all(|c| !c.curve2.is_empty()));
    assert!(r.curves.iter().filter(|c| c.group == Group::Cpu).all(|c| c.curve2.is_empty()));
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
    assert!((r.validation.t_v - r.effective_target).abs() <= 1.5, "t_v {} vs eff {}", r.validation.t_v, r.effective_target);
}

#[test]
fn weak_cooler_yields_honest_warning_not_abort() {
    let plant = Plant { r_inf: 0.26, ..Plant::desktop() };
    let mut io = FakeIo::new(plant);
    let mut p = params();
    p.target_temp_c = 70.0;
    let r = expect_done(run_tune(&mut io, &p));
    assert!(r.warnings.iter().any(|w| w.kind == "coolerInsufficient" || w.kind == "ceilingInsufficient"));
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
fn overtemp_aborts_with_fans_at_full() {
    // Pathological plant: even (1,1) at load exceeds the 88°C sweep line.
    let plant = Plant { t_amb: 45.0, r_inf: 0.30, ..Plant::desktop() };
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
    struct BusyIo(FakeIo);
    impl TuneIo for BusyIo {
        fn now_s(&self) -> f32 { self.0.now_s() }
        fn sleep_s(&mut self, s: f32) { self.0.sleep_s(s) }
        fn cpu_temp(&self) -> Option<f32> { self.0.cpu_temp() }
        fn cpu_power(&self) -> Option<f32> { self.0.cpu_power() }
        fn gpu_temp(&self) -> Option<f32> { self.0.gpu_temp() }
        fn gpu_power(&self) -> Option<f32> { self.0.gpu_power() }
        fn cpu_load_pct(&self) -> Option<f32> { Some(55.0) } // background hog
        fn set_fan_duty(&mut self, id: &str, pct: f32) { self.0.set_fan_duty(id, pct) }
        fn start_cpu_load(&mut self) -> bool { self.0.start_cpu_load() }
        fn stop_cpu_load(&mut self) { self.0.stop_cpu_load() }
        fn start_gpu_load(&mut self) -> bool { self.0.start_gpu_load() }
        fn stop_gpu_load(&mut self) { self.0.stop_gpu_load() }
        fn calibrate(&mut self, ids: &[String]) -> Vec<FanCalibration> { self.0.calibrate(ids) }
        fn emit_progress(&self, p: &AutoTuneProgress) { self.0.emit_progress(p) }
        fn abort_requested(&self) -> bool { self.0.abort_requested() }
        fn wall_jump_s(&self) -> f32 { self.0.wall_jump_s() }
    }
    let mut io = BusyIo(FakeIo::new(Plant::desktop()));
    match run_tune(&mut io, &params()) {
        AutoTuneOutcome::Aborted(a) => assert_eq!(a.phase, "precheck"),
        AutoTuneOutcome::Done(_) => panic!("should have aborted in precheck"),
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan_autotune::sim_tests`
Expected: COMPILE ERROR — `run_tune` undefined.

- [ ] **Step 4: Implement the state machine in `fan_autotune/mod.rs`**

Replace `fan_autotune/mod.rs` with:

```rust
//! Fan auto-tune: closed-loop thermal characterization → curve synthesis.
//! Spec: docs/superpowers/specs/2026-06-10-fan-autotune-design.md
//!
//! `run_tune` is a synchronous state machine living entirely behind `TuneIo`
//! (its only window to the world), which is what makes the closed-loop
//! simulation tests in `sim_tests.rs` possible.

pub mod io;
pub mod model;
#[cfg(test)]
mod sim_tests;

use std::collections::HashMap;

use crate::fan::{interp, FanCalibration};
use io::*;
use model::*;

/// Measurement-phase CPU abort line — fixed BELOW user targets on purpose
/// (spec §3 安全网): an ambitious target + weak cooler must finish measuring
/// and produce an honest warning instead of a mid-sweep abort. 88 °C sits
/// under Zen5's lowest TjMax (89 on the 9950X3D).
const SWEEP_ABORT_C: f32 = 88.0;
/// GPU sweep line — only ever degrades the GPU axis, never aborts the tune.
const GPU_ABORT_C: f32 = 92.0;
/// Whole-tune wall-clock cap (spec §3).
const HARD_CAP_S: f32 = 45.0 * 60.0;
/// Grid axes (spec §3 阶段 3).
const GRID_WCPU: [f32; 4] = [1.0, 0.75, 0.5, 0.35];
const GRID_WCASE: [f32; 3] = [1.0, 0.6, 0.3];
/// Proportional band (spec §5.4) and validation drive ramp per 2 s tick.
const BAND_C: f32 = 8.0;
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
                            reason_zh: format!("温度超限:CPU {t:.1}°C ≥ {line:.0}°C,已全速并中止"),
                            reason_en: format!("temperature limit: CPU {t:.1}°C ≥ {line:.0}°C — fans forced to full, tune aborted"),
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

    /// Settle the GPU temperature. Outer Err = tune abort (CPU safety still
    /// armed); inner None = GPU trouble → caller skips the axis.
    fn settle_gpu(&mut self, min_dwell: f32, max_dwell: f32) -> Result<Option<(f32, bool, f32, f32)>, Abort> {
        let mut det = SteadyDetector::new(min_dwell, max_dwell);
        let (mut p_sum, mut p_n, mut misses) = (0.0_f32, 0u32, 0u32);
        let t0 = self.io.now_s();
        loop {
            self.io.sleep_s(1.0);
            self.safety_tick(Some(SWEEP_ABORT_C), &mut misses)?;
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
                Steady::Steady(v) | Steady::Saturated(v) => {
                    let t_cpu = self.io.cpu_temp().unwrap_or(0.0);
                    let sat = matches!(det.push(self.io.now_s() - t0, tg), Steady::Saturated(_));
                    return Ok(Some((v, sat, p_sum / p_n.max(1) as f32, t_cpu)));
                }
            }
        }
    }

    /// Drive fans by the synthesized curves until the CPU temp settles
    /// (validation loop). Returns (t_v, saturated, duty peak-to-peak over the
    /// last 60 s of the CPU group's first fan, last GPU temp).
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
        return Err(abort("precheck", "传感器服务未就绪(无 CPU 温度/功耗)", "sensor service not ready (no CPU temp/power)"));
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
        return Err(abort("precheck", "系统不空闲:请先关闭后台负载再开始调优", "system busy: close background workloads before tuning"));
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
    let (t_idle, _, p_idle) = t.settle_cpu(SWEEP_ABORT_C, 35.0, 120.0)?;
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
        t.safety_tick(Some(SWEEP_ABORT_C), &mut misses)?;
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
            // Incremental fit → skip points predicted at/over the line − 2.
            if grid.iter().filter(|p| !p.skipped).count() >= 4 {
                let samples = fit_samples(&grid, &baseline, w0);
                if let Some(m) = fit_cpu_model(&samples, t.has_case) {
                    let pred = m.predict(grid.iter().filter(|p| !p.skipped).map(|p| p.p_avg).fold(0.0, f32::max), wc, wx);
                    if pred >= SWEEP_ABORT_C - 2.0 {
                        grid.push(GridPoint { w_cpu: wc, w_case: wx, t_ss: 0.0, p_avg: 0.0, saturated: false, skipped: true });
                        t.emit(Some("skip (predicted too hot)".into()), Some(wc), Some(wx));
                        continue;
                    }
                }
            }
            t.set_group_w(wc, wx);
            t.emit(None, Some(wc), Some(wx));
            let (t_ss, saturated, p_avg) = t.settle_cpu(SWEEP_ABORT_C, 35.0, 120.0)?;
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
                t.safety_tick(Some(SWEEP_ABORT_C), &mut misses)?;
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
    let mut model = fit_cpu_model(&samples, t.has_case)
        .ok_or_else(|| abort("fit", "测量数据不足,模型拟合失败", "not enough measurements to fit the model"))?;
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

    let synth = |model: &ThermalModel, band: f32| {
        synthesize_cpu(
            &SynthInput {
                model,
                p_design,
                target: t.params.target_temp_c,
                floor: t.floor,
                ceil: t.ceil,
                g: &g_rpm,
                has_case: t.has_case,
            },
            band,
        )
    };
    let mut cpu_synth = synth(&model, band);
    let mut gpu_synth = (t.gpu_axis && model_gpu.is_some()).then(|| {
        synthesize_gpu(model_gpu.as_ref().unwrap(), p_design_gpu, t.params.target_gpu_temp_c, t.floor, t.ceil)
    });
    let mut curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);

    // --- Validate (spec §6) -------------------------------------------------------
    t.phase = "validate";
    t.emit(None, None, None);
    if !t.io.start_cpu_load() {
        return Err(abort("validate", "无法启动 CPU 负载", "failed to start the CPU load"));
    }
    let validate_started = t.io.now_s();
    let mut iterations = 0u32;
    let mut oscillation_fixed = false;
    let mut cold_done = false;
    let mut t_v;
    loop {
        let line = (cpu_synth.effective_target + 4.0).min(SWEEP_ABORT_C);
        let (v, _sat, osc_pp, _tg) = t.drive_until_steady(&curves, line, 240.0)?;
        t_v = v;
        let eff = cpu_synth.effective_target;
        let budget_left = t.io.now_s() - validate_started < 12.0 * 60.0 - 250.0;
        if osc_pp > 12.0 && !oscillation_fixed && budget_left {
            band += 2.0;
            spin_down -= 10.0;
            oscillation_fixed = true;
            cpu_synth = synth(&model, band);
            curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);
            continue;
        }
        if t_v - eff > 1.5 && iterations < 2 && budget_left {
            model.t_off += t_v - eff;
            iterations += 1;
            cpu_synth = synth(&model, band);
            curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);
            continue;
        }
        if eff - t_v > 4.0 && !cold_done && budget_left {
            model.t_off -= (eff - t_v).min(4.0);
            cold_done = true;
            cpu_synth = synth(&model, band);
            curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);
            continue;
        }
        break;
    }
    let converged = (t_v - cpu_synth.effective_target).abs() <= 1.5;
    if !converged {
        t.warnings.push(TuneWarning {
            kind: "validationUnconverged".into(),
            message_zh: format!("验证未完全收敛:实测 {t_v:.1}°C(目标 {:.1}°C),被动学习会继续收口", cpu_synth.effective_target),
            message_en: format!("Validation not fully converged: measured {t_v:.1}°C (target {:.1}°C); passive learning will keep closing the gap", cpu_synth.effective_target),
            achievable_c: Some(t_v),
        });
    }

    // --- CombinedValidate (spec §6) -------------------------------------------------
    let mut combined_t_cpu = None;
    let mut combined_t_gpu = None;
    if t.gpu_axis && gpu_synth.is_some() && t.io.start_gpu_load() {
        t.phase = "combinedValidate";
        t.emit(None, None, None);
        let line = (cpu_synth.effective_target + 4.0).min(SWEEP_ABORT_C);
        let (v_cpu, _, _, v_gpu) = t.drive_until_steady(&curves, line, 240.0)?;
        let (mut v_cpu, mut v_gpu) = (v_cpu, v_gpu);
        let eff = cpu_synth.effective_target;
        let eff_g = gpu_synth.as_ref().unwrap().effective_target_g;
        let cpu_over = v_cpu - eff > 1.5;
        let gpu_over = v_gpu.map(|g| g - eff_g > 2.0).unwrap_or(false);
        if cpu_over || gpu_over {
            if cpu_over {
                model.t_off += v_cpu - eff;
                cpu_synth = synth(&model, band);
            }
            if gpu_over {
                if let (Some(mg), Some(gs)) = (model_gpu.as_mut(), v_gpu) {
                    mg.t_off_g += gs - eff_g;
                    gpu_synth = Some(synthesize_gpu(mg, p_design_gpu, t.params.target_gpu_temp_c, t.floor, t.ceil));
                }
            }
            curves = build_curves(&t.fans, &t.calibs, &cpu_synth, gpu_synth.as_ref(), spin_down);
            let (rv_cpu, _, _, rv_gpu) = t.drive_until_steady(&curves, line, 240.0)?;
            v_cpu = rv_cpu;
            v_gpu = rv_gpu;
            let still_over = v_cpu - cpu_synth.effective_target > 1.5
                || v_gpu.map(|g| g - gpu_synth.as_ref().unwrap().effective_target_g > 2.0).unwrap_or(false);
            if still_over {
                t.warnings.push(TuneWarning {
                    kind: "combinedOverTarget".into(),
                    message_zh: format!("双满载极端工况下实测 CPU {v_cpu:.1}°C / GPU {:.1}°C(单满载有保证)", v_gpu.unwrap_or(0.0)),
                    message_en: format!("Under simultaneous CPU+GPU full load: CPU {v_cpu:.1}°C / GPU {:.1}°C (single-load targets are guaranteed)", v_gpu.unwrap_or(0.0)),
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
    let coupling = gpu_grid
        .iter()
        .map(|p| p.t_cpu)
        .fold(f32::MIN, f32::max);
    let result = AutoTuneResult {
        params: t.params.clone(),
        calibrations: t.calibs.clone(),
        grid,
        gpu_grid: gpu_grid.clone(),
        model,
        model_gpu,
        p_design,
        p_design_gpu: (p_design_gpu > 0.0).then_some(p_design_gpu),
        effective_target: cpu_synth.effective_target,
        effective_target_gpu: gpu_synth.as_ref().map(|g| g.effective_target_g),
        gpu_cpu_coupling_c: (!gpu_grid.is_empty()).then(|| (coupling - baseline.t_idle).max(0.0)),
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
        baseline,
        finished_at_ms: 0, // filled by the command wrapper (wall clock)
    };
    t.emit(None, None, None);
    Ok(Box::new(result))
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

fn group_rpm(fans: &[(String, Group)], calibs: &[FanCalibration]) -> GroupRpm {
    let sum = |g: Group| {
        fans.iter()
            .filter(|(_, fg)| *fg == g)
            .filter_map(|(id, _)| calibs.iter().find(|c| &c.control_id == id))
            .map(|c| c.max_rpm)
            .sum::<f32>()
    };
    GroupRpm { cpu_max_rpm_sum: sum(Group::Cpu).max(1.0), case_max_rpm_sum: sum(Group::Case).max(1.0) }
}

fn build_curves(
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
```

NOTE for the implementer: `AutoTuneResult` field order in the struct literal must match the declaration from Task 8 — adjust freely; the semantics above are what counts. If borrowck complains about the `synth` closure capturing `t` while `t.io` is borrowed, convert `synth` into a plain function taking `(&ThermalModel, f32, p_design, target, floor, ceil, &GroupRpm, has_case)` — keep the call sites identical in meaning.

- [ ] **Step 5: Run the simulation tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan_autotune`
Expected: all 8 sim tests + 19 model tests pass. These sim tests ARE the spec's correctness gate — if `happy_path_converges_on_air_cooler` or `mismatched_plant_is_pulled_in_by_validation` fail, fix `run_tune`/synthesis (NOT the test thresholds).

- [ ] **Step 6: Run the full Rust suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: everything passes.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/fan.rs src-tauri/src/fan_autotune/
git commit -m "feat(autotune): tune state machine with closed-loop simulation tests"
```

---

### Task 10: Tauri commands + engine wiring

**Files:**
- Modify: `src-tauri/src/fan_autotune/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the command layer to `fan_autotune/mod.rs`**

Append:

```rust
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
    pub model: model::ThermalModel,
    pub model_gpu: Option<model::GpuModel>,
    pub calibrations: Vec<crate::fan::FanCalibration>,
    pub p_design: f32,
    pub p_design_gpu: Option<f32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResynthResponse {
    pub curves: Vec<model::TunedFanCurve>,
    pub w_points: Vec<model::WPoint>,
    pub gpu_w_points: Option<Vec<(f32, f32)>>,
    pub effective_target: f32,
    pub effective_target_gpu: Option<f32>,
    pub warnings: Vec<model::TuneWarning>,
}

#[tauri::command]
pub fn fan_autotune_resynth(req: ResynthRequest) -> crate::error::CoreResult<ResynthResponse> {
    let params = req.params.sanitized().map_err(crate::error::CoreError::from)?;
    let fans: Vec<(String, model::Group)> = params.groups.iter().map(|(k, v)| (k.clone(), *v)).collect();
    let has_case = fans.iter().any(|(_, g)| *g == model::Group::Case);
    let g_rpm = group_rpm(&fans, &req.calibrations);
    let cpu = model::synthesize_cpu(
        &model::SynthInput {
            model: &req.model,
            p_design: req.p_design,
            target: params.target_temp_c,
            floor: params.quiet_floor_pct / 100.0,
            ceil: params.noise_ceil_pct / 100.0,
            g: &g_rpm,
            has_case,
        },
        BAND_C,
    );
    let gpu = match (&req.model_gpu, req.p_design_gpu) {
        (Some(mg), Some(pg)) if has_case => Some(model::synthesize_gpu(
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
```

- [ ] **Step 2: Register the commands**

In `src-tauri/src/lib.rs`, inside `generate_handler![...]` after `fan::fan_calibrate,` add:

```rust
            fan_autotune::fan_autotune_start,
            fan_autotune::fan_autotune_abort,
            fan_autotune::fan_autotune_resynth,
```

- [ ] **Step 3: Verify compile + tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: all pass; `cargo check` clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/fan_autotune/mod.rs src-tauri/src/lib.rs
git commit -m "feat(autotune): start/abort/resynth Tauri commands with snapshot-restore safety"
```

---

### Task 11: Passive learning backend (`fan_autotune/passive.rs`)

**Files:**
- Create: `src-tauri/src/fan_autotune/passive.rs`
- Modify: `src-tauri/src/fan_autotune/mod.rs`
- Modify: `src-tauri/src/fan.rs` (one hook line)
- Modify: `src-tauri/src/lib.rs` (register commands)

- [ ] **Step 1: Write the failing gating tests**

Create `src-tauri/src/fan_autotune/passive.rs` with tests first at the bottom:

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib fan_autotune::passive`
Expected: COMPILE ERROR.

- [ ] **Step 3: Implement passive learning**

Fill `passive.rs` above the tests:

```rust
//! Passive drift learning (spec §7): piggybacks on the fan engine's 2 s tick.
//! When the tuned curves are ACTIVE and the system sits in a steady high-load
//! state, compare observed temps against the stored model and apply slow,
//! bounded, safety-asymmetric t_off corrections, re-emitting fresh curves.

use std::collections::{HashMap, VecDeque};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::fan::FanCalibration;
use crate::fan_autotune::io::AutoTuneParams;
use crate::fan_autotune::model::{
    self, passive_correction, Group, GpuModel, SteadyDetector, Steady, ThermalModel,
};

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
        Self { threshold, streak_s, spacing_s, streak_started: None, last_fired: None }
    }
    /// Feed one (t_s, load%) observation; true = take a sample now.
    pub fn feed(&mut self, t_s: f32, load: Option<f32>) -> bool {
        match load {
            Some(l) if l >= self.threshold => {
                let started = *self.streak_started.get_or_insert(t_s);
                let spaced = self.last_fired.map(|f| t_s - f >= self.spacing_s).unwrap_or(true);
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
        let temps_unused = (); // duties come from the engine's last-applied map
        let _ = temps_unused;
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
        if n == 0 { 0.0 } else { sum / n as f32 }
    };

    // CPU axis sample.
    if st.cpu_gate.feed(now, load) {
        if let (Some(t), Some(p)) = (cpu_temp, cpu_power) {
            if let Steady::Steady(v) = st.cpu_steady.push(now, t) {
                let pred = st.cfg.model.predict(p, w_of(Group::Cpu), w_of(Group::Case));
                st.cpu.push_residual(v - pred);
            }
        }
    } else if let Some(t) = cpu_temp {
        let _ = st.cpu_steady.push(now, t);
    }

    // GPU axis sample (gaming: high GPU power, modest CPU load — spec §7).
    if let (Some(mg), Some(pdg)) = (st.cfg.model_gpu.as_ref(), st.cfg.p_design_gpu) {
        let gpu_load_pct = gpu_power.map(|p| (p / pdg) * 100.0);
        if st.gpu_gate.feed(now, gpu_load_pct.map(|p| if p >= 70.0 { 95.0 } else { 0.0 })) {
            if let (Some(t), Some(p)) = (gpu_temp, gpu_power) {
                if let Steady::Steady(v) = st.gpu_steady.push(now, t) {
                    let pred = mg.predict(p, w_of(Group::Case));
                    st.gpu.push_residual(v - pred);
                }
            }
        } else if let Some(t) = gpu_temp {
            let _ = st.gpu_steady.push(now, t);
        }
    }

    // Correction at most every 24 h (spec §7: ±0.5/day) or per 5 fresh samples.
    if now - st.last_correction_s >= 24.0 * 3600.0 || (st.cpu.residuals.len() >= 5 && st.last_correction_s == 0.0) {
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
                PassiveAdjustment { axis: "cpu".into(), delta_c: delta, median_residual_c: median, curves: resp },
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
                    PassiveAdjustment { axis: "gpu".into(), delta_c: delta, median_residual_c: median, curves: resp },
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
fn resynth_from_cfg(cfg: &PassiveConfig) -> Result<Vec<model::TunedFanCurve>, String> {
    let params = cfg.params.sanitized()?;
    let fans: Vec<(String, Group)> = params.groups.iter().map(|(k, v)| (k.clone(), *v)).collect();
    let has_case = fans.iter().any(|(_, g)| *g == Group::Case);
    let g_rpm = super::group_rpm(&fans, &cfg.calibrations);
    let cpu = model::synthesize_cpu(
        &model::SynthInput {
            model: &cfg.model,
            p_design: cfg.p_design,
            target: params.target_temp_c,
            floor: params.quiet_floor_pct / 100.0,
            ceil: params.noise_ceil_pct / 100.0,
            g: &g_rpm,
            has_case,
        },
        super::BAND_C,
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
    Ok(super::build_curves(&fans, &cfg.calibrations, &cpu, gpu.as_ref(), 30.0))
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
```

- [ ] **Step 4: Wire the hook + helpers**

4a. `fan_autotune/mod.rs`: add `pub mod passive;` and make `group_rpm`, `build_curves`, `BAND_C` visible to it (`pub(crate) fn group_rpm…`, `pub(crate) fn build_curves…`, `pub(crate) const BAND_C…`).

4b. `fan.rs`: passive needs the engine's last-applied duty. Add near `exclusive_end`:

```rust
/// Last duty the engine applied to a control (manual or curve), if any.
pub(crate) fn last_applied_duty(control_id: &str) -> Option<f32> {
    LAST.lock().get(control_id).map(|(_, d)| *d as f32)
}
```

4c. `fan.rs` `start_engine` loop — add the hook after `apply_once();`:

```rust
            apply_once();
            crate::fan_autotune::passive::tick();
```

4d. `lib.rs` `generate_handler![...]`: add

```rust
            fan_autotune::passive::fan_passive_configure,
            fan_autotune::passive::fan_passive_status,
```

- [ ] **Step 5: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: all pass (2 new passive tests included).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/fan_autotune/ src-tauri/src/fan.rs src-tauri/src/lib.rs
git commit -m "feat(autotune): passive drift learning — gated sampling, bounded asymmetric correction"
```

---

### Task 12: Frontend IPC types + `fanProfiles` dual-source plumbing

**Files:**
- Modify: `src/lib/ipc.ts`
- Modify: `src/store/fanProfiles.ts`

- [ ] **Step 1: Extend `FanChannelConfig` and add tune types in `ipc.ts`**

1a. In `FanChannelConfig` (after `spinDownPct`):

```ts
  /** Optional SECOND temp source + curve (GPU assist); duty = max(curve, curve2). */
  tempSourceId2?: string | null;
  curve2?: FanCurvePoint[];
```

1b. After the `FanCalibProgress` interface add:

```ts
// --- fan auto-tune (spec: docs/superpowers/specs/2026-06-10-fan-autotune-design.md) ---

export type FanGroup = "cpu" | "case";

export interface AutoTuneParams {
  targetTempC: number;
  targetGpuTempC: number;
  quietFloorPct: number;
  noiseCeilPct: number;
  groups: Record<string, FanGroup>;
  reuseCalibration?: FanCalibration[] | null;
}

export interface ThermalModel {
  alpha: number;
  tOff: number;
  rInf: number;
  kC: number;
  kX: number;
  rmse: number;
  conservativeShift: number;
}

export interface GpuModel {
  tOffG: number;
  rG: number;
  kG: number;
  rmse: number;
  conservativeShift: number;
}

export interface TuneWarning {
  kind: string;
  messageZh: string;
  messageEn: string;
  achievableC?: number | null;
}

export interface WPoint {
  tempC: number;
  wCpu: number;
  wCase: number;
}

export interface TunedFanCurve {
  controlId: string;
  group: FanGroup;
  curve: FanCurvePoint[];
  curve2: FanCurvePoint[];
  minDuty: number;
  spinUpPct: number;
  spinDownPct: number;
}

export interface AutoTuneProgress {
  phase: string;
  step: number;
  stepTotal: number;
  cpuTemp?: number | null;
  cpuPower?: number | null;
  gpuTemp?: number | null;
  gpuPower?: number | null;
  wCpu?: number | null;
  wCase?: number | null;
  etaS?: number | null;
  note?: string | null;
}

export interface TuneGridPoint {
  wCpu: number;
  wCase: number;
  tSs: number;
  pAvg: number;
  saturated: boolean;
  skipped: boolean;
}

export interface TuneGpuGridPoint {
  wCase: number;
  tGpuSs: number;
  pGpuAvg: number;
  tCpu: number;
}

export interface TuneBaseline {
  tIdle: number;
  pIdle: number;
  tGpuIdle?: number | null;
  pGpuIdle?: number | null;
}

export interface TuneValidation {
  tV: number;
  iterations: number;
  oscillationFixed: boolean;
  converged: boolean;
  combinedTCpu?: number | null;
  combinedTGpu?: number | null;
}

export interface AutoTuneResult {
  params: AutoTuneParams;
  calibrations: FanCalibration[];
  baseline: TuneBaseline;
  grid: TuneGridPoint[];
  gpuGrid: TuneGpuGridPoint[];
  model: ThermalModel;
  modelGpu?: GpuModel | null;
  pDesign: number;
  pDesignGpu?: number | null;
  effectiveTarget: number;
  effectiveTargetGpu?: number | null;
  gpuCpuCouplingC?: number | null;
  wPoints: WPoint[];
  gpuWPoints?: [number, number][] | null;
  curves: TunedFanCurve[];
  cpuSourceId?: string | null;
  gpuSourceId?: string | null;
  validation: TuneValidation;
  warnings: TuneWarning[];
  finishedAtMs: number;
}

export interface ResynthRequest {
  params: AutoTuneParams;
  model: ThermalModel;
  modelGpu?: GpuModel | null;
  calibrations: FanCalibration[];
  pDesign: number;
  pDesignGpu?: number | null;
}

export interface ResynthResponse {
  curves: TunedFanCurve[];
  wPoints: WPoint[];
  gpuWPoints?: [number, number][] | null;
  effectiveTarget: number;
  effectiveTargetGpu?: number | null;
  warnings: TuneWarning[];
}

export interface PassiveConfig {
  enabled: boolean;
  params: AutoTuneParams;
  model: ThermalModel;
  modelGpu?: GpuModel | null;
  calibrations: FanCalibration[];
  pDesign: number;
  pDesignGpu?: number | null;
}

export interface PassiveStatus {
  enabled: boolean;
  cpuSamples: number;
  gpuSamples: number;
  accumulatedCpuC: number;
  accumulatedGpuC: number;
}

/** Payload of the `fan-autotune-passive` event. */
export interface PassiveAdjustment {
  axis: "cpu" | "gpu";
  deltaC: number;
  medianResidualC: number;
  curves: TunedFanCurve[];
}

/** Payload of the `fan-autotune-aborted` event. */
export interface AutoTuneAbortInfo {
  phase: string;
  reasonZh: string;
  reasonEn: string;
}
```

1c. In the `api` object (near `fanCalibrate`):

```ts
  fanAutotuneStart: (params: AutoTuneParams) => invoke<AutoTuneResult>("fan_autotune_start", { params }),
  fanAutotuneAbort: () => invoke<boolean>("fan_autotune_abort"),
  fanAutotuneResynth: (req: ResynthRequest) => invoke<ResynthResponse>("fan_autotune_resynth", { req }),
  fanPassiveConfigure: (config: PassiveConfig | null) => invoke<void>("fan_passive_configure", { config }),
  fanPassiveStatus: () => invoke<PassiveStatus>("fan_passive_status"),
```

- [ ] **Step 2: Plumb dual-source fields through `fanProfiles.ts`**

2a. `FanConfig` gains:

```ts
  /** GPU-assist second source + curve (auto-tune output). */
  tempSourceId2?: string | null;
  curve2?: FanCurvePoint[];
```

2b. `toBackend` adds to the mapped object:

```ts
    tempSourceId2: c.tempSourceId2 ?? null,
    curve2: c.curve2 ?? [],
```

2c. `cloneConfigs` must deep-copy the second curve — replace its body's map line with:

```ts
    out[k] = { ...v, curve: v.curve.map((p) => ({ ...p })), curve2: v.curve2?.map((p) => ({ ...p })) };
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: `tsc` clean, vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ipc.ts src/store/fanProfiles.ts
git commit -m "feat(autotune): frontend IPC types + dual-source FanConfig plumbing"
```

---

### Task 13: vitest + `autotuneUtils` (pure frontend logic, TDD)

**Files:**
- Modify: `package.json`
- Create: `src/lib/autotuneUtils.ts`
- Create: `src/lib/autotuneUtils.test.ts`

- [ ] **Step 1: Add vitest**

```bash
npm install -D vitest
```

In `package.json` `scripts` add: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing tests**

Create `src/lib/autotuneUtils.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { FanConfig } from "../store/fanProfiles";
import type { TunedFanCurve } from "./ipc";
import { classifyFan, clampTuneParams, curvesDiverge } from "./autotuneUtils";

describe("classifyFan", () => {
  test("pump headers are excluded — a pump must never follow a temp curve", () => {
    expect(classifyFan("AIO Pump")).toBe("excluded");
    expect(classifyFan("W_PUMP+")).toBe("excluded");
    expect(classifyFan("水泵")).toBe("excluded");
  });
  test("cpu-ish headers go to the cpu group", () => {
    expect(classifyFan("CPU Fan")).toBe("cpu");
    expect(classifyFan("CPU_OPT")).toBe("cpu");
    expect(classifyFan("AIO Fan 1")).toBe("cpu");
  });
  test("everything else is a case fan", () => {
    expect(classifyFan("Chassis Fan 2")).toBe("case");
    expect(classifyFan("System Fan")).toBe("case");
    expect(classifyFan("Fan #4")).toBe("case");
  });
});

describe("clampTuneParams", () => {
  test("clamps into spec ranges", () => {
    const p = clampTuneParams({ targetTempC: 95, targetGpuTempC: 40, quietFloorPct: 80, noiseCeilPct: 20, groups: {} });
    expect(p.targetTempC).toBe(88);
    expect(p.targetGpuTempC).toBe(60);
    expect(p.quietFloorPct).toBe(60);
    expect(p.noiseCeilPct).toBeGreaterThanOrEqual(p.quietFloorPct + 15);
  });
});

describe("curvesDiverge", () => {
  const tuned: TunedFanCurve[] = [
    {
      controlId: "a",
      group: "cpu",
      curve: [{ tempC: 20, duty: 25 }, { tempC: 85, duty: 80 }],
      curve2: [],
      minDuty: 25,
      spinUpPct: 70,
      spinDownPct: 30,
    },
  ];
  const matching: Record<string, FanConfig> = {
    a: {
      mode: "curve",
      manualPct: 50,
      tempSourceId: "t",
      curve: [{ tempC: 20, duty: 25 }, { tempC: 85, duty: 80 }],
      minDuty: 25,
      spinUpPct: 70,
      spinDownPct: 30,
      curve2: [],
      tempSourceId2: null,
    },
  };
  test("identical configs do not diverge", () => {
    expect(curvesDiverge(matching, tuned)).toBe(false);
  });
  test("a hand-edited point diverges", () => {
    const edited = { ...matching, a: { ...matching.a, curve: [{ tempC: 20, duty: 40 }, { tempC: 85, duty: 80 }] } };
    expect(curvesDiverge(edited, tuned)).toBe(true);
  });
  test("switching the fan to manual diverges", () => {
    const manual = { ...matching, a: { ...matching.a, mode: "manual" as const } };
    expect(curvesDiverge(manual, tuned)).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL — `autotuneUtils` module not found.

- [ ] **Step 4: Implement `autotuneUtils.ts`**

```ts
// Pure helpers for the fan auto-tune UI. No tauri imports — unit-testable.
import type { FanConfig } from "../store/fanProfiles";
import type { AutoTuneParams, FanCurvePoint, FanGroup, TunedFanCurve } from "./ipc";

/** Default group for a fan header by its (label or chip) name. Pumps are
 *  excluded outright: a pump on a temperature curve can destroy an AIO. */
export function classifyFan(name: string): FanGroup | "excluded" {
  const n = name.toLowerCase();
  if (/pump|水泵/.test(n)) return "excluded";
  if (/cpu|aio|opt/.test(n)) return "cpu";
  return "case";
}

/** Clamp params into spec §2 ranges and keep ceiling ≥ floor + 15. */
export function clampTuneParams(p: AutoTuneParams): AutoTuneParams {
  const targetTempC = Math.min(88, Math.max(60, p.targetTempC));
  const targetGpuTempC = Math.min(87, Math.max(60, p.targetGpuTempC));
  const quietFloorPct = Math.min(60, Math.max(0, p.quietFloorPct));
  const noiseCeilPct = Math.min(100, Math.max(Math.max(40, quietFloorPct + 15), p.noiseCeilPct));
  return { ...p, targetTempC, targetGpuTempC, quietFloorPct, noiseCeilPct };
}

function pointsDiffer(a: FanCurvePoint[] | undefined, b: FanCurvePoint[]): boolean {
  const aa = a ?? [];
  if (aa.length !== b.length) return true;
  return aa.some((p, i) => Math.abs(p.tempC - b[i].tempC) > 0.05 || Math.abs(p.duty - b[i].duty) > 0.55);
}

/** True when the live configs no longer match the tuned output — the user
 *  hand-edited something, so passive learning must pause (spec §7). */
export function curvesDiverge(configs: Record<string, FanConfig>, tuned: TunedFanCurve[]): boolean {
  for (const t of tuned) {
    const c = configs[t.controlId];
    if (!c) return true;
    if (c.mode !== "curve") return true;
    if (pointsDiffer(c.curve, t.curve)) return true;
    if (pointsDiffer(c.curve2 ?? [], t.curve2)) return true;
    if (Math.abs((c.minDuty ?? 0) - t.minDuty) > 0.55) return true;
  }
  return false;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/autotuneUtils.ts src/lib/autotuneUtils.test.ts
git commit -m "feat(autotune): vitest + pure UI helpers (grouping, clamps, divergence)"
```

---

### Task 14: `fanAutotune` store

**Files:**
- Create: `src/store/fanAutotune.ts`

- [ ] **Step 1: Implement the store**

```ts
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  api,
  type AutoTuneParams,
  type AutoTuneResult,
  type PassiveConfig,
  type TunedFanCurve,
} from "../lib/ipc";
import { tauriStorage } from "../lib/persist";
import { useFanProfiles } from "./fanProfiles";

export interface PassiveLogEntry {
  atMs: number;
  axis: "cpu" | "gpu";
  deltaC: number;
  medianResidualC: number;
}

export function defaultTuneParams(): AutoTuneParams {
  return { targetTempC: 85, targetGpuTempC: 80, quietFloorPct: 25, noiseCeilPct: 100, groups: {} };
}

interface FanAutotuneState {
  /** Last completed tune (model + grid + curves), or null. */
  result: AutoTuneResult | null;
  /** Last-used wizard parameters (pre-filled next time). */
  params: AutoTuneParams;
  passiveEnabled: boolean;
  /** True when a hand-edit paused passive learning (cleared by re-apply/re-tune). */
  passivePaused: boolean;
  passiveLog: PassiveLogEntry[];
  setParams: (p: AutoTuneParams) => void;
  setResult: (r: AutoTuneResult | null) => void;
  /** Write tuned curves into the live fan configs and push to the engine. */
  applyTuned: (curves: TunedFanCurve[], cpuSourceId: string | null, gpuSourceId: string | null) => void;
  /** Send (or clear) the passive-learning config to the backend. */
  configurePassive: () => void;
  setPassiveEnabled: (v: boolean) => void;
  setPassivePaused: (v: boolean) => void;
  addPassiveLog: (e: PassiveLogEntry) => void;
}

export const useFanAutotune = create<FanAutotuneState>()(
  persist(
    (set, get) => ({
      result: null,
      params: defaultTuneParams(),
      passiveEnabled: true,
      passivePaused: false,
      passiveLog: [],
      setParams: (params) => set({ params }),
      setResult: (result) => set({ result }),

      applyTuned: (curves, cpuSourceId, gpuSourceId) => {
        const fp = useFanProfiles.getState();
        for (const c of curves) {
          fp.setConfig(c.controlId, {
            mode: "curve",
            curve: c.curve.map((p) => ({ ...p })),
            curve2: c.curve2.map((p) => ({ ...p })),
            tempSourceId: cpuSourceId ?? fp.configs[c.controlId]?.tempSourceId ?? null,
            tempSourceId2: c.curve2.length > 0 ? gpuSourceId : null,
            minDuty: c.minDuty,
            spinUpPct: c.spinUpPct,
            spinDownPct: c.spinDownPct,
          });
        }
        set({ passivePaused: false });
      },

      configurePassive: () => {
        const { result, params, passiveEnabled, passivePaused } = get();
        if (!result || !passiveEnabled || passivePaused) {
          void api.fanPassiveConfigure(null).catch(() => undefined);
          return;
        }
        const cfg: PassiveConfig = {
          enabled: true,
          params,
          model: result.model,
          modelGpu: result.modelGpu ?? null,
          calibrations: result.calibrations,
          pDesign: result.pDesign,
          pDesignGpu: result.pDesignGpu ?? null,
        };
        void api.fanPassiveConfigure(cfg).catch(() => undefined);
      },

      setPassiveEnabled: (passiveEnabled) => {
        set({ passiveEnabled });
        get().configurePassive();
      },
      setPassivePaused: (passivePaused) => {
        set({ passivePaused });
        get().configurePassive();
      },
      addPassiveLog: (e) =>
        set((s) => ({ passiveLog: [e, ...s.passiveLog].slice(0, 20) })),
    }),
    {
      name: "corepilot-fan-autotune",
      version: 1,
      storage: createJSONStorage(() => tauriStorage),
      partialize: ({ passivePaused: _p, ...rest }) => rest,
    },
  ),
);
```

- [ ] **Step 2: Typecheck + tests**

Run: `npm run build && npx vitest run`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add src/store/fanAutotune.ts
git commit -m "feat(autotune): persisted tune-result store with passive-learning lifecycle"
```

---

### Task 15: AutoTuneWizard component

**Files:**
- Create: `src/components/fans/AutoTuneWizard.tsx`

Three steps: 参数 → 运行 → 结果. All strings bilingual via `tf` (project i18n rule: interpolated/fragmented strings need `tf(zh, en)`).

- [ ] **Step 1: Implement the wizard**

```tsx
import { AlertTriangle, Check, Loader2, OctagonX, Sparkles, Thermometer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { classifyFan, clampTuneParams } from "../../lib/autotuneUtils";
import { useTf } from "../../lib/i18n";
import {
  api,
  type AutoTuneParams,
  type AutoTuneProgress,
  type AutoTuneResult,
  type FanChannel,
  type FanGroup,
  type FanTempSource,
  type TuneWarning,
} from "../../lib/ipc";
import { useFanAutotune } from "../../store/fanAutotune";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Segmented } from "../ui/Segmented";
import { Slider } from "../ui/Slider";

type Step = "params" | "running" | "result";
type Assignment = FanGroup | "excluded";

const PHASE_ZH: Record<string, string> = {
  precheck: "环境检查",
  fanCalib: "风扇校准",
  baseline: "怠速基线",
  gridSweep: "满载网格扫描",
  gpuSweep: "GPU 负载扫描",
  fit: "模型拟合",
  synthesize: "曲线合成",
  validate: "满载验证",
  combinedValidate: "双满载验证",
  done: "完成",
};
const PHASE_ORDER = ["precheck", "fanCalib", "baseline", "gridSweep", "gpuSweep", "fit", "synthesize", "validate", "combinedValidate", "done"];

interface AutoTuneWizardProps {
  open: boolean;
  onClose: () => void;
  channels: FanChannel[];
  labels: Record<string, string>;
  temps: FanTempSource[];
}

export function AutoTuneWizard({ open, onClose, channels, labels, temps }: AutoTuneWizardProps) {
  const tf = useTf();
  const store = useFanAutotune();
  const [step, setStep] = useState<Step>("params");
  const [assign, setAssign] = useState<Record<string, Assignment>>({});
  const [draft, setDraft] = useState<AutoTuneParams>(store.params);
  const [progress, setProgress] = useState<AutoTuneProgress | null>(null);
  const [tempHistory, setTempHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutoTuneResult | null>(null);
  const [resynthBusy, setResynthBusy] = useState(false);
  const runningRef = useRef(false);

  const controllable = channels.filter((c) => c.controllable);
  const gpuPresent = temps.some((t) => /gpu/i.test(t.name));

  // Seed group assignments whenever the wizard opens.
  useEffect(() => {
    if (!open) return;
    setStep("params");
    setError(null);
    setResult(null);
    setDraft(store.params);
    const seeded: Record<string, Assignment> = {};
    for (const c of controllable) {
      const prior = store.params.groups[c.id];
      seeded[c.id] = prior ?? classifyFan(labels[c.id] ?? c.name);
    }
    setAssign(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cpuCount = Object.values(assign).filter((a) => a === "cpu").length;
  const startBlocked = cpuCount === 0 || controllable.length === 0;

  async function start() {
    const groups: Record<string, FanGroup> = {};
    for (const [id, a] of Object.entries(assign)) {
      if (a === "cpu" || a === "case") groups[id] = a;
    }
    const params = clampTuneParams({ ...draft, groups });
    store.setParams(params);
    setStep("running");
    setProgress(null);
    setTempHistory([]);
    setError(null);
    runningRef.current = true;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<AutoTuneProgress>("fan-autotune-progress", (e) => {
        setProgress(e.payload);
        if (e.payload.cpuTemp != null) {
          setTempHistory((h) => [...h.slice(-299), e.payload.cpuTemp as number]);
        }
      });
      const r = await api.fanAutotuneStart(params);
      store.setResult(r);
      store.applyTuned(r.curves, r.cpuSourceId ?? null, r.gpuSourceId ?? null);
      store.configurePassive();
      setResult(r);
      setStep("result");
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : tf("调优失败", "Tuning failed"));
    } finally {
      unlisten?.();
      runningRef.current = false;
    }
  }

  /** One-click feasibility actions on the result page (spec §5.2). */
  async function resynthWith(patch: Partial<AutoTuneParams>) {
    if (!result) return;
    setResynthBusy(true);
    try {
      const params = clampTuneParams({ ...result.params, ...patch });
      const resp = await api.fanAutotuneResynth({
        params,
        model: result.model,
        modelGpu: result.modelGpu ?? null,
        calibrations: result.calibrations,
        pDesign: result.pDesign,
        pDesignGpu: result.pDesignGpu ?? null,
      });
      const next: AutoTuneResult = {
        ...result,
        params,
        curves: resp.curves,
        wPoints: resp.wPoints,
        gpuWPoints: resp.gpuWPoints ?? null,
        effectiveTarget: resp.effectiveTarget,
        effectiveTargetGpu: resp.effectiveTargetGpu ?? null,
        warnings: resp.warnings,
      };
      store.setParams(params);
      store.setResult(next);
      store.applyTuned(next.curves, next.cpuSourceId ?? null, next.gpuSourceId ?? null);
      store.configurePassive();
      setResult(next);
    } catch {
      // resynth is best-effort UI sugar; the applied tune stays valid
    } finally {
      setResynthBusy(false);
    }
  }

  function requestClose() {
    if (runningRef.current) return; // running step has its own abort button
    onClose();
  }

  const phaseIdx = progress ? Math.max(0, PHASE_ORDER.indexOf(progress.phase)) : 0;

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={tf("智能调优", "Smart Tune")}
      footer={
        step === "params" ? (
          <>
            <Button onClick={onClose}>{tf("取消", "Cancel")}</Button>
            <Button variant="primary" disabled={startBlocked} onClick={() => void start()}>
              <Sparkles size={13} /> {tf("开始调优(约 25–32 分钟)", "Start (≈25–32 min)")}
            </Button>
          </>
        ) : step === "running" ? (
          <Button
            variant="danger"
            onClick={() => {
              void api.fanAutotuneAbort();
            }}
          >
            <OctagonX size={13} /> {tf("中止", "Abort")}
          </Button>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {tf("完成", "Done")}
          </Button>
        )
      }
    >
      {step === "params" && (
        <div className="space-y-4">
          <Slider
            label={tf("目标最高 CPU 温度(满载钉住此温度)", "Target max CPU temp (pinned at full load)")}
            value={draft.targetTempC}
            min={60}
            max={88}
            unit="°C"
            onChange={(v) => setDraft({ ...draft, targetTempC: v })}
          />
          <Slider
            label={
              gpuPresent
                ? tf("GPU 辅助排热目标温度(机箱风扇)", "GPU assist target temp (case fans)")
                : tf("GPU 目标(未检测到 GPU 温度,GPU 轴将跳过)", "GPU target (no GPU temp detected — axis will be skipped)")
            }
            value={draft.targetGpuTempC}
            min={60}
            max={87}
            unit="°C"
            onChange={(v) => setDraft({ ...draft, targetGpuTempC: v })}
          />
          <Slider
            label={tf("安静底线(低温时的理想转速,占各扇最大转速)", "Quiet floor (idle speed, % of each fan's max RPM)")}
            value={draft.quietFloorPct}
            min={0}
            max={60}
            unit="%"
            onChange={(v) => setDraft({ ...draft, quietFloorPct: v })}
          />
          <Slider
            label={tf("噪音上限(紧急高温除外)", "Noise ceiling (emergency heat exempt)")}
            value={draft.noiseCeilPct}
            min={Math.max(40, draft.quietFloorPct + 15)}
            max={100}
            unit="%"
            onChange={(v) => setDraft({ ...draft, noiseCeilPct: v })}
          />

          <div>
            <div className="hud-label mb-1.5 text-[9.5px] text-dim">{tf("风扇分组", "FAN GROUPS")}</div>
            <div className="space-y-1.5">
              {controllable.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface2/50 px-2.5 py-1.5">
                  <span className="min-w-0 truncate text-[12px] text-ink">{labels[c.id] ?? c.name}</span>
                  <Segmented
                    id={`tune-group-${c.id}`}
                    value={assign[c.id] ?? "case"}
                    options={[
                      { value: "cpu", label: tf("CPU 组", "CPU") },
                      { value: "case", label: tf("机箱组", "Case") },
                      { value: "excluded", label: tf("不参与", "Skip") },
                    ]}
                    onChange={(v) => setAssign({ ...assign, [c.id]: v as Assignment })}
                  />
                </div>
              ))}
            </div>
            {Object.entries(assign).some(([id, a]) => a === "excluded" && /pump|水泵/i.test(labels[id] ?? controllable.find((c) => c.id === id)?.name ?? "")) && (
              <p className="mt-1.5 text-[10.5px] text-dim">
                {tf("检测到水泵接口已自动排除:水泵必须恒速,不能跟随温度曲线。", "Pump headers are auto-excluded: a pump must run at constant speed, never on a temp curve.")}
              </p>
            )}
            {cpuCount === 0 && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-warn">
                <AlertTriangle size={12} /> {tf("CPU 组至少需要 1 个风扇", "The CPU group needs at least one fan")}
              </p>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-dim">
            {tf(
              "全程会运行内置满载(CPU 全核 + GPU 计算),风扇会反复变速,属正常现象。期间请不要使用电脑跑其他重负载;随时可中止,中止即恢复原配置。",
              "The tune runs built-in full loads (all-core CPU + GPU compute); fans will repeatedly change speed. Avoid other heavy workloads during the run; abort anytime to restore the previous config.",
            )}
          </p>
        </div>
      )}

      {step === "running" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[12.5px] text-ink">
            <Loader2 size={14} className="animate-spin text-accent-bright" />
            <span className="font-semibold">{PHASE_ZH[progress?.phase ?? "precheck"] ?? progress?.phase}</span>
            {progress && progress.stepTotal > 0 && (
              <span className="nums text-dim">
                {progress.step}/{progress.stepTotal}
              </span>
            )}
            {progress?.note && <span className="text-[10.5px] text-dim">{progress.note}</span>}
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-surface3">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.round(((phaseIdx + 1) / PHASE_ORDER.length) * 100)}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11.5px]">
            <Readout label="CPU" value={progress?.cpuTemp} unit="°C" warn={(progress?.cpuTemp ?? 0) >= 85} />
            <Readout label={tf("CPU 功耗", "CPU power")} value={progress?.cpuPower} unit="W" />
            <Readout label="GPU" value={progress?.gpuTemp} unit="°C" warn={(progress?.gpuTemp ?? 0) >= 88} />
            <Readout label={tf("GPU 功耗", "GPU power")} value={progress?.gpuPower} unit="W" />
            <Readout label={tf("CPU 组风量", "CPU airflow")} value={progress?.wCpu != null ? progress.wCpu * 100 : null} unit="%" />
            <Readout label={tf("机箱组风量", "Case airflow")} value={progress?.wCase != null ? progress.wCase * 100 : null} unit="%" />
          </div>
          {tempHistory.length > 2 && (
            <svg viewBox="0 0 300 60" className="h-14 w-full">
              <polyline
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="1.5"
                points={tempHistory
                  .map((t, i) => {
                    const lo = Math.min(...tempHistory);
                    const hi = Math.max(...tempHistory, lo + 1);
                    const x = (i / Math.max(1, tempHistory.length - 1)) * 300;
                    const y = 58 - ((t - lo) / (hi - lo)) * 54;
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .join(" ")}
              />
            </svg>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p>{error}</p>
                <Button onClick={onClose}>{tf("关闭", "Close")}</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {step === "result" && result && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <Check size={15} className="text-accent-bright" /> {tf("调优完成,曲线已应用", "Tune complete — curves applied")}
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11.5px]">
            <Readout label={tf("满载实测", "Validated full-load")} value={result.validation.tV} unit="°C" />
            <Readout label={tf("有效目标", "Effective target")} value={result.effectiveTarget} unit="°C" />
            <Readout label={tf("设计功率", "Design power")} value={result.pDesign} unit="W" />
            <Readout
              label={tf("GPU→CPU 热耦合", "GPU→CPU coupling")}
              value={result.gpuCpuCouplingC}
              unit="°C"
            />
          </div>
          {!result.validation.converged && (
            <p className="text-[11px] text-warn">
              {tf("验证未完全收敛,被动学习会在日常使用中继续收口。", "Validation didn't fully converge; passive learning will keep closing the gap.")}
            </p>
          )}
          {result.warnings.map((w) => (
            <WarningRow key={w.kind + w.messageZh} w={w} busy={resynthBusy} onRaiseCeiling={() => void resynthWith({ noiseCeilPct: 100 })} />
          ))}
          <p className="text-[11px] leading-relaxed text-dim">
            {tf(
              "已自动保存为风扇配置档案;之后修改目标温度/底线/上限都会秒级重算,无需重新测量。",
              "Saved as a fan profile; future target/floor/ceiling changes re-solve in seconds with no re-measurement.",
            )}
          </p>
        </div>
      )}
    </Modal>
  );
}

function Readout({ label, value, unit, warn }: { label: string; value?: number | null; unit: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface2/50 px-2.5 py-1.5">
      <div className="hud-label text-[8.5px] text-dim">{label}</div>
      <div className={`nums text-[14px] font-semibold leading-tight ${warn ? "text-warn" : "text-ink"}`}>
        {value != null ? Math.round(value * 10) / 10 : "—"}
        <span className="ml-0.5 text-[9px] font-normal text-dim">{unit}</span>
      </div>
    </div>
  );
}

function WarningRow({ w, busy, onRaiseCeiling }: { w: TuneWarning; busy: boolean; onRaiseCeiling: () => void }) {
  const tf = useTf();
  return (
    <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11.5px] text-warn">
      <div className="flex items-start gap-2">
        <Thermometer size={13} className="mt-0.5 shrink-0" />
        <p className="min-w-0">{tf(w.messageZh, w.messageEn)}</p>
      </div>
      {w.kind === "ceilingInsufficient" && (
        <div className="mt-1.5 flex gap-2">
          <Button disabled={busy} onClick={onRaiseCeiling}>
            {tf("放宽上限到 100% 并重算", "Raise ceiling to 100% & re-solve")}
          </Button>
          <span className="self-center text-[10.5px] text-dim">{tf("或保持现状(接受可达温度)", "or keep as-is (accept the achievable temp)")}</span>
        </div>
      )}
    </div>
  );
}
```

NOTE for the implementer: check `Button`'s actual variant prop names in `src/components/ui/Button.tsx` (`primary`/`danger` are used elsewhere in FanControl.tsx, so they exist). `Segmented` props mirror the usage in FanControl.tsx (`id`, `value`, `options`, `onChange`).

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/fans/AutoTuneWizard.tsx
git commit -m "feat(autotune): three-step tuning wizard (params, live run, results)"
```

---

### Task 16: FanControl integration (entry button, status strip, dual-curve editor, passive events)

**Files:**
- Modify: `src/tabs/FanControl.tsx`

- [ ] **Step 1: Wire the wizard + status strip into `FanControl`**

1a. Imports (top of file):

```tsx
import { AutoTuneWizard } from "../components/fans/AutoTuneWizard";
import { useFanAutotune } from "../store/fanAutotune";
import { curvesDiverge } from "../lib/autotuneUtils";
import type { PassiveAdjustment } from "../lib/ipc";
```

1b. Inside `FanControl()` add state + the store:

```tsx
  const autotune = useFanAutotune();
  const [showTuneWizard, setShowTuneWizard] = useState(false);
```

1c. Add the entry button in the profile-bar button row, BEFORE the「AI 智能校准」button:

```tsx
                <Button
                  variant="primary"
                  onClick={() => setShowTuneWizard(true)}
                  disabled={calibrating || controllableIds.length === 0}
                  title={tf("实测本机散热系统,自动调出最优温度曲线(约 25–32 分钟)", "Measure this machine's cooling and auto-tune optimal curves (≈25–32 min)")}
                >
                  <Sparkles size={13} /> {tf("智能调优", "Smart Tune")}
                </Button>
```

1d. Status strip — render right under the profile bar `</div>` (after the profiles block), only when a tune exists:

```tsx
          {autotune.result && (
            <div className="glass hairline flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-3.5 py-2 text-[11px] text-muted">
              <span>
                {tf("上次智能调优", "Last smart tune")}:{" "}
                <span className="nums text-ink">{new Date(autotune.result.finishedAtMs).toLocaleString()}</span>
              </span>
              <span>
                {tf("目标", "Target")} <span className="nums text-ink">{Math.round(autotune.result.effectiveTarget)}°C</span>
                {" · "}
                {tf("满载实测", "validated")} <span className="nums text-ink">{Math.round(autotune.result.validation.tV * 10) / 10}°C</span>
              </span>
              <label className="ml-auto flex cursor-pointer items-center gap-2">
                {tf("被动学习", "Passive learning")}
                {autotune.passivePaused && <span className="text-[10px] text-warn">{tf("(已暂停:检测到手动修改)", "(paused: hand-edit detected)")}</span>}
                <Toggle checked={autotune.passiveEnabled && !autotune.passivePaused} onChange={(v) => {
                  if (autotune.passivePaused && v) {
                    // Re-enabling after a hand-edit re-applies the tuned curves.
                    autotune.applyTuned(autotune.result!.curves, autotune.result!.cpuSourceId ?? null, autotune.result!.gpuSourceId ?? null);
                  }
                  autotune.setPassiveEnabled(v);
                  autotune.setPassivePaused(false);
                }} />
              </label>
            </div>
          )}
```

1e. Passive event listener + hand-edit divergence watcher (inside `FanControl`, after the polling `useEffect`):

```tsx
  // Passive-learning adjustments arrive from the backend: apply + log.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<PassiveAdjustment>("fan-autotune-passive", (e) => {
      const s = useFanAutotune.getState();
      if (!s.passiveEnabled || s.passivePaused || !s.result) return;
      s.applyTuned(e.payload.curves, s.result.cpuSourceId ?? null, s.result.gpuSourceId ?? null);
      s.setResult({ ...s.result, curves: e.payload.curves });
      s.addPassiveLog({ atMs: Date.now(), axis: e.payload.axis, deltaC: e.payload.deltaC, medianResidualC: e.payload.medianResidualC });
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  // Hand-edit detection: configs diverging from the tuned curves pause passive
  // learning (spec §7 — never overwrite the user's manual work).
  useEffect(() => {
    const s = useFanAutotune.getState();
    if (!s.result || s.passivePaused || !s.passiveEnabled) return;
    if (curvesDiverge(configs, s.result.curves)) {
      s.setPassivePaused(true);
    }
  }, [configs]);

  // Re-arm passive learning on startup (the backend forgets across restarts).
  useEffect(() => {
    const p = useFanAutotune.persist;
    const run = () => useFanAutotune.getState().configurePassive();
    if (p.hasHydrated()) {
      run();
      return;
    }
    return p.onFinishHydration(run);
  }, []);
```

1f. Mount the wizard before the closing fragment (next to the other modals):

```tsx
      <AutoTuneWizard
        open={showTuneWizard}
        onClose={() => setShowTuneWizard(false)}
        channels={channels}
        labels={labels}
        temps={info?.temps ?? []}
      />
```

- [ ] **Step 2: Dual-curve editor on case-fan cards**

In `ChannelCard`, the curve-mode block currently renders one `FanCurveEditor`. Add a curve selector when a GPU curve exists. Above `<FanCurveEditor …/>` insert:

```tsx
              {config.curve2 && config.curve2.length > 0 && (
                <Segmented
                  id={`fan-curvesel-${channel.id}`}
                  value={activeCurve}
                  options={[
                    { value: "primary", label: tf("CPU 源", "CPU source") },
                    { value: "gpu", label: tf("GPU 辅助", "GPU assist") },
                  ]}
                  onChange={(v) => setActiveCurve(v as "primary" | "gpu")}
                />
              )}
```

with local state at the top of `ChannelCard`:

```tsx
  const [activeCurve, setActiveCurve] = useState<"primary" | "gpu">("primary");
```

and make the editor + live marker target the active curve — replace the existing `<FanCurveEditor …/>` invocation with:

```tsx
              {activeCurve === "primary" || !config.curve2?.length ? (
                <FanCurveEditor
                  points={effectiveCurve}
                  onChange={setDraftCurve}
                  onCommit={(curve) => {
                    setDraftCurve(null);
                    onChange({ curve });
                  }}
                  minDuty={config.minDuty}
                  live={liveTemp != null && liveDuty != null ? { tempC: liveTemp, duty: liveDuty } : null}
                />
              ) : (
                <FanCurveEditor
                  points={config.curve2 ?? []}
                  onChange={() => undefined}
                  onCommit={(curve2) => onChange({ curve2 })}
                  minDuty={config.minDuty}
                  live={
                    gpuLiveTemp != null
                      ? { tempC: gpuLiveTemp, duty: Math.max(config.minDuty, interpCurve(config.curve2 ?? [], gpuLiveTemp)) }
                      : null
                  }
                />
              )}
```

with the GPU live temp derived next to `liveTemp`:

```tsx
  const gpuSource = temps.find((t) => t.id === config.tempSourceId2) ?? null;
  const gpuLiveTemp = gpuSource?.c ?? null;
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run build && npx vitest run`
Expected: clean. (Hand-edit detection via the curve editors flows through `onChange({ curve })` → `configs` → the divergence watcher → passive pause.)

- [ ] **Step 4: Commit**

```bash
git add src/tabs/FanControl.tsx
git commit -m "feat(autotune): FanControl integration — wizard entry, status strip, GPU-assist curve editor, passive events"
```

---

### Task 17: Full verification + hardware QA handoff

**Files:** none new.

- [ ] **Step 1: Full Rust suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: model (19) + sim (8) + fan (4) + passive (2) + load_gen (1) all pass.

- [ ] **Step 2: Full frontend suite + build**

Run: `npx vitest run && npm run build`
Expected: 7 vitest tests pass; tsc + vite clean.

- [ ] **Step 3: Dev-build smoke (optional but recommended)**

Run: `npx tauri build` (project rule: never ship via bare `cargo build`). If the overlay DLL is missing first build it: `cargo build -p corepilot-overlay --release --manifest-path src-tauri/Cargo.toml`.
Expected: bundle succeeds.

- [ ] **Step 4: Hardware QA checklist (user runs on the 9950X3D — same protocol as the SMU feature)**

Document these in the session summary for the user; do NOT claim them done:

1. 风扇页 →「智能调优」→ 检查分组预判(CPU_FAN→CPU 组、CHA_FAN→机箱组、水泵被排除)。
2. 默认参数开跑;观察:校准 ~30 s/扇 → 怠速基线 → 满载网格(温度应稳步爬升、风扇逐档降速;CPU 占用 ≈100%,功耗接近 PPT)→ GPU 阶段(显卡功耗应明显上升)→ 验证。
3. 中途点「中止」一次:风扇应立即恢复原配置,无报错残留;重新开跑。
4. 完成后:曲线已应用、自动存档「智能调优 …」出现;满载实测 tV 与目标差 ≤1.5 °C。
5. 机箱风扇卡片出现「CPU 源 / GPU 辅助」切换;打开游戏(GPU 重载)观察机箱扇按 GPU 温度提速。
6. 手改任一曲线点 → 状态条出现「被动学习已暂停」;重新打开开关 → 曲线恢复为调优输出。
7. 把目标温度改激进(如 70 °C)+ 上限 60% 重跑:应出现「上限内最低只能压到 Y °C」警告与一键放宽选项,而不是中途中止。

- [ ] **Step 5: Final commit (if any stragglers) + done**

```bash
git status --short   # should be clean except intentional changes
```

---

## Plan Self-Review (completed at authoring time)

- **Spec coverage:** §2 params → T8/T12/T15; §3 phases/safety → T9; §3 阶段 1 reuse → `reuse_calibration` (T8/T9); §4 models/fit → T3; §5 synthesis/warnings/dual-source engine → T1/T4/T5/T9; §6 validation/combined → T9/T10; §7 passive → T11/T13/T14/T16; §8 architecture/commands/events → T8/T10/T11/T12; §9 error handling → T9 (abort paths)/T10 (snapshot-restore); §10 tests → T1/T3–T6/T9/T11/T13; §11 out-of-scope respected. UI 快改目标温度 lives in the wizard result page via resynth (T15) — the spec's status-strip quick-edit is satisfied by reopening the wizard (entry in T16).
- **Placeholder scan:** no TBD/TODO; every code step carries full code; two explicit "NOTE for the implementer" entries cover windows-crate signature drift and borrowck fallback — both state the invariant semantics to preserve.
- **Type consistency:** `AutoTuneParams/Progress/Result`, `TunedFanCurve`, `Group`/`FanGroup` (serde camelCase ⇄ TS "cpu"/"case"), `ResynthRequest/Response`, `PassiveConfig/Status/Adjustment` cross-checked between T8/T10/T11 (Rust) and T12–T16 (TS); command names match `generate_handler` registrations; event names `fan-autotune-progress`/`fan-autotune-passive`/`fan-autotune-aborted` consistent across T8/T10/T11/T15/T16.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-10-fan-autotune.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?



