//! Motherboard fan control — the CorePilot "FanXpert" engine.
//!
//! The single `sensord` sidecar (LibreHardwareMonitor) is the actuator: it
//! streams fan RPM / board temperatures / fan-control (PWM) state on stdout and
//! accepts `set <id> <pct>` / `auto <id>` commands on stdin. `crate::sidecar`
//! owns that process; it feeds every parsed stdout line to [`ingest`] and
//! carries our commands (never blocking the caller).
//!
//! This module keeps the latest snapshot (for the UI), the per-fan configuration
//! pushed from the frontend, and a background engine that — once per ~2 s — turns
//! each fan's mode into a concrete command:
//! * `auto`   → return the header to BIOS control (sent once on transition);
//! * `manual` → hold a fixed duty %;
//! * `curve`  → interpolate a temperature→duty curve against a chosen temp source.
//!
//! Everything degrades gracefully: with no sidecar, no controllable header, or no
//! temperature reading, the relevant step simply no-ops and nothing is fabricated.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

// --- snapshot streamed from the sidecar ----------------------------------------

#[derive(Default, Clone)]
struct Raw {
    /// (id, name, rpm)
    fans: Vec<(String, String, Option<f32>)>,
    /// (id, name, °C)
    temps: Vec<(String, String, Option<f32>)>,
    /// (id, name, pct, controllable, hardware)
    controls: Vec<(String, String, Option<f32>, bool, String)>,
    /// Whether the sidecar has produced at least one parseable line.
    got_any: bool,
    received_at: Option<Instant>,
}

static SNAP: Lazy<Mutex<Raw>> = Lazy::new(|| Mutex::new(Raw::default()));

/// Headers whose BIOS hand-back was lost: a sensord process died WITHOUT its own
/// reset while we drove them (crash, or a hang the watchdog had to terminate).
/// LibreHardwareMonitor restores only the defaults the SAME process saved, so a
/// fresh sidecar's `auto` is a no-op and the first `set` records the pinned
/// state as "default" — the fan would stay at the last software duty (e.g. 25 %)
/// while temps climb, with every `auto` reporting success. These stay under a
/// safe software curve until reboot, which is the only thing that resets the
/// chip's mode registers.
static DIRTY: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Built-in curve (against the CPU temperature) for a dirty header the user left
/// on auto — the BIOS curve we can no longer hand it back to. 100 % without a
/// reading.
const FAILSAFE_CURVE: [CurvePoint; 4] = [
    CurvePoint { temp_c: 40.0, duty: 35.0 },
    CurvePoint { temp_c: 60.0, duty: 55.0 },
    CurvePoint { temp_c: 75.0, duty: 80.0 },
    CurvePoint { temp_c: 85.0, duty: 100.0 },
];

/// Per-fan configuration last pushed from the frontend.
static FAN_CONFIG: Lazy<Mutex<Vec<FanChannelConfig>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Last command applied per control id: (mode, duty%) — used to avoid spamming
/// the sidecar with redundant writes and to detect auto-mode transitions.
static LAST: Lazy<Mutex<HashMap<String, (String, i32)>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Current applied duty per control id while in CURVE mode (the smoothed value the
/// fan is actually being driven toward its target from). Decoupled from `LAST`
/// (which is rounded + shared with manual/auto) so the ramp accumulates at full
/// precision and ignores the 2% write-hysteresis. Entries are seeded on the first
/// curve tick (or after a mode change) so a fan starts easing from where it is,
/// not from 0.
static CURVE_DUTY: Lazy<Mutex<HashMap<String, f32>>> = Lazy::new(|| Mutex::new(HashMap::new()));

static ENGINE_STARTED: AtomicBool = AtomicBool::new(false);

/// True while an AI calibration sweep is running; pauses the engine so it does
/// not fight the sweep's manual duty writes.
static CALIBRATING: AtomicBool = AtomicBool::new(false);
static SIDECAR_GENERATION: AtomicU64 = AtomicU64::new(0);
static INGEST_GENERATION: AtomicU64 = AtomicU64::new(u64::MAX);

/// Try to take exclusive manual control of the fans (pauses the engine).
/// Returns false if a calibration/tune already holds it.
pub(crate) fn exclusive_begin() -> bool {
    let was = CALIBRATING.swap(true, Ordering::SeqCst);
    if !was {
        crate::sidecar::refresh_interval();
    }
    !was
}

/// Whether a calibration / auto-tune currently holds fan exclusivity. The
/// self-updater refuses to install during one: the tune parks fans at a test
/// duty and only its own completion path restores them, so killing the app
/// mid-sweep leaves the hardware pinned with nobody left to reset it.
pub(crate) fn exclusive_active() -> bool {
    CALIBRATING.load(Ordering::SeqCst)
}

/// Release exclusivity and force the engine to re-apply the user's config
/// (mirrors the tail of `fan_calibrate`).
pub(crate) fn exclusive_end() {
    CALIBRATING.store(false, Ordering::SeqCst);
    crate::sidecar::refresh_interval();
    LAST.lock().clear();
    CURVE_DUTY.lock().clear();
    apply_once();
}

/// Last duty the engine applied to a control (manual or curve), if any.
pub(crate) fn last_applied_duty(control_id: &str) -> Option<f32> {
    LAST.lock().get(control_id).map(|(_, d)| *d as f32)
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
    let raw = SNAP.lock();
    let fresh = raw
        .received_at
        .map(|t| t.elapsed() <= Duration::from_secs(10))
        .unwrap_or(false);
    if !fresh {
        return HashMap::new();
    }
    raw.temps
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

// --- shapes sent to / received from the frontend -------------------------------

/// One controllable fan header: its control plus the best-matched RPM reading.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FanChannel {
    pub id: String,
    pub name: String,
    pub hw: String,
    pub pct: Option<f32>,
    pub controllable: bool,
    pub rpm: Option<f32>,
    pub rpm_name: Option<String>,
}

/// A temperature sensor usable as a curve source.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FanTempSource {
    pub id: String,
    pub name: String,
    pub c: Option<f32>,
}

/// Live fan state for the UI.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FanState {
    /// The sidecar produced fan/control data at least once.
    pub available: bool,
    /// At least one header is software-controllable on this board.
    pub supported: bool,
    pub channels: Vec<FanChannel>,
    pub temps: Vec<FanTempSource>,
    /// Control ids that can't be handed back to the BIOS until reboot (see
    /// [`DIRTY`]); CorePilot keeps them on a safe curve. Usually empty.
    pub dirty_headers: Vec<String>,
}

/// One point of a fan curve: at `temp_c` °C, run at `duty` %.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurvePoint {
    pub temp_c: f32,
    pub duty: f32,
}

/// Default for the spin-up/spin-down smoothing fields: 100 = Immediate, i.e. the
/// fan reaches its curve target in a single tick. Used as the serde default so
/// configs saved/sent before these fields existed deserialize to today's exact
/// (instant) behavior.
fn default_spin_pct() -> f32 {
    100.0
}

/// Per-fan configuration pushed from the frontend.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FanChannelConfig {
    pub control_id: String,
    /// "auto" | "manual" | "curve".
    pub mode: String,
    #[serde(default)]
    pub manual_pct: f32,
    #[serde(default)]
    pub temp_source_id: Option<String>,
    #[serde(default)]
    pub curve: Vec<CurvePoint>,
    /// Minimum duty floor (a fan is never driven below this).
    #[serde(default)]
    pub min_duty: f32,
    /// Curve-mode ramp-UP smoothing, 0 (Smooth) .. 100 (Immediate). Caps how far
    /// the applied duty may rise toward the curve target each tick. Only used in
    /// curve mode; ignored by manual/auto.
    #[serde(default = "default_spin_pct")]
    pub spin_up_pct: f32,
    /// Curve-mode ramp-DOWN smoothing, 0 (Smooth) .. 100 (Immediate). Caps how far
    /// the applied duty may fall toward the curve target each tick.
    #[serde(default = "default_spin_pct")]
    pub spin_down_pct: f32,
    /// Optional SECOND temperature source (e.g. GPU core) for dual-source curves.
    /// The applied duty is max(curve@source, curve2@source2). Defaults keep old
    /// configs byte-identical in behavior.
    #[serde(default)]
    pub temp_source_id2: Option<String>,
    #[serde(default)]
    pub curve2: Vec<CurvePoint>,
}

// --- wiring from crate::sidecar (the sidecar owner) ----------------------------

/// The sidecar process exited. Clear the snapshot (the UI shows fans as
/// unavailable rather than stale values). `clean` = it ran its own fan reset on
/// the way out; otherwise every header we were driving is now [`DIRTY`].
pub(crate) fn sidecar_gone(clean: bool) {
    *SNAP.lock() = Raw::default();
    SIDECAR_GENERATION.fetch_add(1, Ordering::SeqCst);
    if !clean {
        let driven: Vec<String> = LAST
            .lock()
            .iter()
            .filter(|(_, (mode, _))| mode != "auto")
            .map(|(id, _)| id.clone())
            .collect();
        if !driven.is_empty() {
            tracing::warn!(?driven, "sensord died without its fan reset; headers kept on a fail-safe curve until reboot");
            DIRTY.lock().extend(driven);
        }
    }
}

/// App exit: dirty headers can't be returned to the BIOS, and `autoall` (or
/// sensord's own EOF reset) would put back the PINNED state the new process
/// saved as "default". Park them at 100 % and make sensord forget them so they
/// stay there, safe, until reboot.
pub(crate) fn park_dirty_for_exit() {
    for id in DIRTY.lock().iter() {
        if send_set(id, 100.0) {
            let _ = send(&format!("forget {id}"));
        }
    }
}

/// Update the snapshot from one sidecar line (parsed once by `crate::sidecar`).
/// Lines without fan arrays are ignored; CPU/GPU fields are `sensors`' business.
pub(crate) fn ingest(json: &serde_json::Value) {
    let num = |v: &serde_json::Value, key: &str| -> Option<f32> {
        let n = v.get(key)?;
        if n.is_null() {
            return None;
        }
        let f = n.as_f64()?;
        if f.is_finite() {
            Some(f as f32)
        } else {
            None
        }
    };
    let text = |v: &serde_json::Value, key: &str| -> String {
        v.get(key)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };

    let mut raw = Raw::default();
    raw.received_at = Some(Instant::now());

    if let Some(arr) = json.get("fans").and_then(|v| v.as_array()) {
        for f in arr {
            raw.fans
                .push((text(f, "id"), text(f, "name"), num(f, "rpm")));
        }
    }
    if let Some(arr) = json.get("temps").and_then(|v| v.as_array()) {
        for t in arr {
            raw.temps
                .push((text(t, "id"), text(t, "name"), num(t, "c")));
        }
    }
    if let Some(arr) = json.get("controls").and_then(|v| v.as_array()) {
        for c in arr {
            let controllable = c
                .get("controllable")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            raw.controls.push((
                text(c, "id"),
                text(c, "name"),
                num(c, "pct"),
                controllable,
                text(c, "hw"),
            ));
        }
    }

    // Only treat as a fan-bearing line if any of the arrays were present.
    raw.got_any =
        json.get("fans").is_some() || json.get("controls").is_some() || json.get("temps").is_some();

    if raw.got_any {
        let generation = SIDECAR_GENERATION.load(Ordering::SeqCst);
        if INGEST_GENERATION.swap(generation, Ordering::SeqCst) != generation {
            LAST.lock().clear();
            CURVE_DUTY.lock().clear();
        }
        *SNAP.lock() = raw;
    }
}

// --- command transport ---------------------------------------------------------

/// Maximum length of a control id we will forward to the sidecar. LHM
/// identifiers are short paths; anything longer is almost certainly malformed.
const MAX_CONTROL_ID_LEN: usize = 256;

/// Whether a control id is safe to forward to the sidecar as a stdin text line.
///
/// The sidecar parses commands as space-delimited tokens terminated by a
/// newline, so an id containing whitespace, control characters (`\r`, `\n`, …),
/// or any byte outside the LHM identifier alphabet (`[A-Za-z0-9/_.:-]`) could
/// split into extra tokens / inject additional sidecar commands. Reject those.
fn is_valid_control_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_CONTROL_ID_LEN {
        return false;
    }
    id.chars()
        .all(|c| matches!(c, 'A'..='Z' | 'a'..='z' | '0'..='9' | '/' | '_' | '.' | ':' | '-'))
}

fn send(cmd: &str) -> bool {
    crate::sidecar::send(cmd)
}

pub(crate) fn send_set(id: &str, pct: f32) -> bool {
    // Never forward an id that could inject extra tokens/commands into the
    // sidecar's line-oriented stdin protocol.
    if !is_valid_control_id(id) {
        return false;
    }
    send(&format!("set {id} {:.0}", pct.clamp(0.0, 100.0)))
}

fn send_auto(id: &str) -> bool {
    if !is_valid_control_id(id) {
        return false;
    }
    send(&format!("auto {id}"))
}

// --- curve math ----------------------------------------------------------------

/// Linear interpolation of a temperature→duty curve. Points are sorted by
/// temperature; below the first point clamps to its duty, above the last clamps
/// to its duty. Returns 0 for an empty curve. Crate-visible: the auto-tune
/// validation drive reuses the exact engine interpolation.
pub(crate) fn interp(curve: &[CurvePoint], temp: f32) -> f32 {
    if curve.is_empty() {
        return 0.0;
    }
    let mut pts: Vec<&CurvePoint> = curve.iter().collect();
    pts.sort_by(|a, b| {
        a.temp_c
            .partial_cmp(&b.temp_c)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if temp <= pts[0].temp_c {
        return pts[0].duty;
    }
    let last = pts[pts.len() - 1];
    if temp >= last.temp_c {
        return last.duty;
    }
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if temp >= a.temp_c && temp <= b.temp_c {
            let span = b.temp_c - a.temp_c;
            if span <= f32::EPSILON {
                return b.duty;
            }
            let f = (temp - a.temp_c) / span;
            return a.duty + f * (b.duty - a.duty);
        }
    }
    last.duty
}

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

// --- curve ramp smoothing -------------------------------------------------------

/// Smallest per-tick duty step at the "Smooth" extreme (spinPct = 0), in duty %.
/// Must be > 0 so even fully-smooth still creeps toward the target instead of
/// freezing; ~1%/tick at the ~2 s tick means a full 0→100 swing eases over ~3 min.
const MIN_RAMP_STEP: f32 = 1.0;

/// Max per-tick duty step for a given smoothing percentage. `spin_pct` is clamped
/// to [0,100]; the step grows linearly from [`MIN_RAMP_STEP`] (Smooth) to 100 — a
/// full-range jump — at 100 (Immediate). Because the step reaches the entire 0–100
/// duty range at 100, the applied duty always reaches the target in one tick there,
/// preserving the pre-smoothing (instant) behavior exactly.
fn max_ramp_step(spin_pct: f32) -> f32 {
    let p = spin_pct.clamp(0.0, 100.0) / 100.0;
    MIN_RAMP_STEP + p * (100.0 - MIN_RAMP_STEP)
}

/// Move `current` toward `target` by at most the step implied by the smoothing
/// percentages: `spin_up_pct` governs rising (target above current), `spin_down_pct`
/// governs falling. At 100 the step spans the full range, so the result is exactly
/// `target` (instant) — identical to today's behavior. Lower values cap the step so
/// the duty eases over several ticks.
fn ramp_toward(current: f32, target: f32, spin_up_pct: f32, spin_down_pct: f32) -> f32 {
    let delta = target - current;
    if delta == 0.0 {
        return target;
    }
    let step = if delta > 0.0 {
        max_ramp_step(spin_up_pct)
    } else {
        max_ramp_step(spin_down_pct)
    };
    if delta.abs() <= step {
        target
    } else if delta > 0.0 {
        current + step
    } else {
        current - step
    }
}

// --- engine --------------------------------------------------------------------

/// One pass: turn each configured fan's mode into a sidecar command.
fn apply_once() {
    // An AI calibration sweep is driving the fans directly — don't fight it.
    if CALIBRATING.load(Ordering::SeqCst) {
        return;
    }
    let cfgs = FAN_CONFIG.lock().clone();
    let dirty = DIRTY.lock().clone();
    if cfgs.is_empty() && dirty.is_empty() {
        return;
    }

    // Snapshot temps by id for curve sources.
    let temps: HashMap<String, f32> = temps_by_id();
    let failsafe = failsafe_duty(&temps);

    let mut last = LAST.lock();
    let mut curve_duty = CURVE_DUTY.lock();
    // A dirty header with no config of its own still needs managing.
    for id in dirty.iter().filter(|id| !cfgs.iter().any(|c| &c.control_id == *id)) {
        drive_failsafe(id, failsafe, &mut last);
    }
    for c in &cfgs {
        let floor = c.min_duty.clamp(0.0, 100.0);
        match c.mode.as_str() {
            "manual" => {
                let target = c.manual_pct.clamp(floor, 100.0);
                if !send_set(&c.control_id, target) {
                    continue;
                }
                last.insert(
                    c.control_id.clone(),
                    ("manual".to_string(), target.round() as i32),
                );
                // Leaving curve mode: drop the smoothed state so a later return to
                // curve re-seeds from the fan's live position, not a stale value.
                curve_duty.remove(&c.control_id);
            }
            "curve" => {
                // Fail safe: if the curve's temperature source is unconfigured,
                // unknown, or has no current reading, we cannot compute a duty.
                // Leaving the header at its last software duty could pin a fan
                // low while temps climb, so hand the header back to the BIOS
                // (auto). Track last-applied so we issue `auto` only once per
                // transition instead of every 2 s tick.
                let reading = c
                    .temp_source_id
                    .as_ref()
                    .and_then(|src| temps.get(src).copied());
                let Some(t) = reading else {
                    curve_duty.remove(&c.control_id);
                    if dirty.contains(&c.control_id) {
                        // No BIOS to fall back to: run hot-safe instead.
                        let peak = c.curve.iter().map(|p| p.duty).fold(failsafe, f32::max);
                        drive_failsafe(&c.control_id, peak.clamp(floor, 100.0), &mut last);
                        continue;
                    }
                    let already_auto = last
                        .get(&c.control_id)
                        .map(|(m, _)| m == "auto")
                        .unwrap_or(false);
                    if !already_auto {
                        if !send_auto(&c.control_id) {
                            continue;
                        }
                        last.insert(c.control_id.clone(), ("auto".to_string(), 0));
                    }
                    // Header handed back to BIOS — forget the ramp so re-acquiring
                    // the curve eases from where the fan actually is.
                    curve_duty.remove(&c.control_id);
                    continue;
                };
                let t2 = c
                    .temp_source_id2
                    .as_ref()
                    .and_then(|src| temps.get(src).copied());
                let target = combined_target(c, t, t2).clamp(floor, 100.0);
                // Smooth the approach to the target. Seed the per-channel applied
                // duty on first entry (or after a mode change away from curve)
                // from the last known curve duty, else straight to the target so
                // the very first apply isn't a forced ramp from 0.
                let prev_curve = last
                    .get(&c.control_id)
                    .map(|(m, _)| m == "curve")
                    .unwrap_or(false);
                let current = match curve_duty.get(&c.control_id) {
                    Some(&v) if prev_curve => v,
                    _ => target,
                };
                // Always re-clamp the smoothed value to the floor so the minimum-duty
                // guarantee holds even mid-ramp.
                let next = ramp_toward(current, target, c.spin_up_pct, c.spin_down_pct)
                    .clamp(floor, 100.0);
                curve_duty.insert(c.control_id.clone(), next);

                let di = next.round() as i32;
                let changed = match last.get(&c.control_id) {
                    // Hysteresis: only re-issue when mode changed or duty moved >=2%…
                    Some((mode, prev)) => mode != "curve" || (di - prev).abs() >= 2,
                    None => true,
                };
                // …but while a ramp is still in progress (smoothed value hasn't yet
                // reached the target) keep issuing each tick so sub-2% steps aren't
                // swallowed by the hysteresis and the fan actually eases.
                let ramping = (next - target).abs() > f32::EPSILON;
                if changed || ramping {
                    if !send_set(&c.control_id, next) {
                        continue;
                    }
                    last.insert(c.control_id.clone(), ("curve".to_string(), di));
                }
            }
            _ if dirty.contains(&c.control_id) => {
                curve_duty.remove(&c.control_id);
                drive_failsafe(&c.control_id, failsafe.max(floor), &mut last);
            }
            _ => {
                // auto: hand back to BIOS, but only once per transition.
                let already_auto = last
                    .get(&c.control_id)
                    .map(|(m, _)| m == "auto")
                    .unwrap_or(false);
                curve_duty.remove(&c.control_id);
                if !already_auto {
                    if !send_auto(&c.control_id) {
                        continue;
                    }
                    last.insert(c.control_id.clone(), ("auto".to_string(), 0));
                }
            }
        }
    }
}

/// Duty for a dirty header with no usable curve: [`FAILSAFE_CURVE`] at the CPU
/// temperature, 100 % when there is no reading.
fn failsafe_duty(temps: &HashMap<String, f32>) -> f32 {
    resolve_source_ids()
        .0
        .and_then(|id| temps.get(&id).copied())
        .map_or(100.0, |t| interp(&FAILSAFE_CURVE, t))
}

/// Drive `id` at `duty`, re-sending only when it moved ≥2 % (same hysteresis as
/// the curve path).
fn drive_failsafe(id: &str, duty: f32, last: &mut HashMap<String, (String, i32)>) {
    let di = duty.round() as i32;
    let unchanged = last
        .get(id)
        .is_some_and(|(mode, prev)| mode == "failsafe" && (di - prev).abs() < 2);
    if !unchanged && send_set(id, duty) {
        last.insert(id.to_string(), ("failsafe".to_string(), di));
    }
}

/// Start the background fan engine (idempotent). Applies the active config every
/// ~2 s. Does nothing meaningful until the frontend pushes a config.
pub fn start_engine() {
    if ENGINE_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // Make sure the LHM sidecar is running so fan/temp data flows even if the
    // user opens the Fan page before ever visiting Monitor (which is the only
    // other thing that spawns the sidecar).
    crate::sidecar::ensure();
    std::thread::Builder::new()
        .name("fan-engine".into())
        .spawn(|| loop {
            apply_once();
            crate::fan_autotune::passive::tick();
            std::thread::sleep(Duration::from_millis(2000));
        })
        .ok();
}

// --- snapshot → UI state -------------------------------------------------------

/// Split an LHM sensor identifier into (hardware-prefix, channel-index) around the
/// given segment, e.g. `/lpc/nct6701d/0/control/1` with `"/control/"` →
/// (`/lpc/nct6701d/0`, `1`). Used to pair a Control with its Fan RPM sensor on the
/// SAME chip (matching prefix + index) — never across hardware (a GPU control must
/// not borrow the motherboard's Fan #2 RPM).
fn split_id<'a>(id: &'a str, seg: &str) -> Option<(&'a str, &'a str)> {
    let pos = id.find(seg)?;
    Some((&id[..pos], &id[pos + seg.len()..]))
}

fn build_state() -> FanState {
    let raw = SNAP.lock().clone();
    let fresh = raw
        .received_at
        .map(|t| t.elapsed() <= Duration::from_secs(10))
        .unwrap_or(false);

    let temps: Vec<FanTempSource> = raw
        .temps
        .iter()
        .map(|(id, name, c)| FanTempSource {
            id: id.clone(),
            name: name.clone(),
            c: if fresh { *c } else { None },
        })
        .collect();

    let mut channels: Vec<FanChannel> = Vec::with_capacity(raw.controls.len());
    let mut supported = false;
    for (id, name, pct, controllable, hw) in raw.controls.iter() {
        if *controllable {
            supported = true;
        }
        // Pair to the RPM sensor on the SAME chip: same identifier prefix AND same
        // channel index (control/N ↔ fan/N). This keeps GPU controls paired with
        // GPU fans and motherboard controls with motherboard fans — never crossed.
        let paired = split_id(id, "/control/").and_then(|(cprefix, cidx)| {
            raw.fans.iter().find(|(fid, _, _)| {
                matches!(split_id(fid, "/fan/"), Some((fprefix, fidx)) if fprefix == cprefix && fidx == cidx)
            })
        });
        let (rpm, rpm_name) = match paired {
            Some((_, fname, frpm)) => (*frpm, Some(fname.clone())),
            None => (None, None),
        };
        channels.push(FanChannel {
            id: id.clone(),
            name: name.clone(),
            hw: hw.clone(),
            pct: if fresh { *pct } else { None },
            controllable: *controllable,
            rpm: if fresh { rpm } else { None },
            rpm_name,
        });
    }

    let mut dirty_headers: Vec<String> = DIRTY.lock().iter().cloned().collect();
    dirty_headers.sort();
    FanState {
        available: raw.got_any,
        supported,
        channels,
        temps,
        dirty_headers,
    }
}

// --- Tauri commands ------------------------------------------------------------

/// Live fan headers + temperature sources for the Fan Control page.
///
/// Async + blocking-pool: the snapshot read is µs, but `ensure_sidecar` takes
/// the sidecar respawn path whenever the sidecar has died — a CreateProcess
/// (hundreds of ms under Defender/load) that must not run on the main thread
/// at this command's ~1 Hz poll cadence.
#[tauri::command]
pub async fn fan_info() -> FanState {
    crate::commands::run_blocking_default("fan_info", || {
        // Guarantee the sidecar is up the moment the Fan page asks for data.
        crate::sidecar::ensure();
        build_state()
    })
    .await
}

/// Maximum number of points we accept in a single fan curve.
const MAX_CURVE_POINTS: usize = 24;
/// Highest temperature (°C) a curve point may reference.
const MAX_CURVE_TEMP_C: f32 = 120.0;

/// Sanitize one config coming over IPC: bound the mode, clamp the duties, and
/// cap/clamp the curve. Returns `None` if the mode is not recognized.
fn sanitize_config(c: &FanChannelConfig) -> Option<FanChannelConfig> {
    // Mode allow-list: anything else is dropped rather than silently treated as
    // a fail-safe (the engine only ever knows these three).
    let mode = match c.mode.as_str() {
        "auto" => "auto",
        "manual" => "manual",
        "curve" => "curve",
        _ => return None,
    };

    // Bound the curve: cap the point count, clamp each point's temperature and
    // duty into a sane physical range so interpolation can never be driven by
    // out-of-range / non-finite values from the frontend.
    let curve: Vec<CurvePoint> = c
        .curve
        .iter()
        .take(MAX_CURVE_POINTS)
        .map(|p| CurvePoint {
            temp_c: clamp_finite(p.temp_c, 0.0, MAX_CURVE_TEMP_C),
            duty: clamp_finite(p.duty, 0.0, 100.0),
        })
        .collect();

    // The secondary (GPU-assist) curve gets the same bounds as the primary.
    let curve2: Vec<CurvePoint> = c
        .curve2
        .iter()
        .take(MAX_CURVE_POINTS)
        .map(|p| CurvePoint {
            temp_c: clamp_finite(p.temp_c, 0.0, MAX_CURVE_TEMP_C),
            duty: clamp_finite(p.duty, 0.0, 100.0),
        })
        .collect();

    Some(FanChannelConfig {
        control_id: c.control_id.clone(),
        mode: mode.to_string(),
        manual_pct: clamp_finite(c.manual_pct, 0.0, 100.0),
        temp_source_id: c.temp_source_id.clone(),
        curve,
        min_duty: clamp_finite(c.min_duty, 0.0, 100.0),
        // Smoothing percentages: clamp to [0,100] (NaN → 0 = fully Smooth, which
        // still creeps via MIN_RAMP_STEP and so can never freeze a fan). Missing
        // fields are defaulted to 100 = Immediate by serde before we get here.
        spin_up_pct: clamp_finite(c.spin_up_pct, 0.0, 100.0),
        spin_down_pct: clamp_finite(c.spin_down_pct, 0.0, 100.0),
        temp_source_id2: c.temp_source_id2.clone(),
        curve2,
    })
}

/// Clamp into `[lo, hi]`, mapping NaN to `lo` (never trust a non-finite value
/// from IPC to reach hardware).
fn clamp_finite(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_nan() {
        lo
    } else {
        v.clamp(lo, hi)
    }
}

/// The set of control ids that are currently software-controllable, taken from
/// the latest sidecar snapshot. A config whose `control_id` is not in this set
/// is dropped — IPC may not name an unknown or non-controllable header.
pub(crate) fn controllable_ids() -> std::collections::HashSet<String> {
    SNAP.lock()
        .controls
        .iter()
        .filter(|(_, _, _, controllable, _)| *controllable)
        .map(|(id, _, _, _, _)| id.clone())
        .collect()
}

/// Replace the engine's per-fan configuration. Applied immediately and then on
/// each engine tick. Sending an empty list leaves headers untouched (the engine
/// no-ops); switch a fan to `auto` to actively hand it back to the BIOS.
///
/// Every config is validated against the live hardware before it can drive a
/// fan: only currently-controllable control ids are accepted, modes are
/// restricted to `auto`/`manual`/`curve`, and all duties/curve points are
/// clamped to physical ranges. Anything that fails validation is dropped.
#[tauri::command]
pub fn fan_set_config(configs: Vec<FanChannelConfig>) -> crate::error::CoreResult<()> {
    let received = configs.len();

    // An empty push is a legitimate "stop managing" signal: clear the config so
    // the engine no-ops (headers keep whatever state they were last in).
    if received == 0 {
        *FAN_CONFIG.lock() = Vec::new();
        return Ok(());
    }

    let controllable = controllable_ids();

    let validated: Vec<FanChannelConfig> = configs
        .iter()
        .filter(|c| is_valid_control_id(&c.control_id))
        .filter(|c| controllable.contains(&c.control_id))
        .filter_map(sanitize_config)
        .collect();

    if validated.is_empty() {
        return Err(crate::error::CoreError::from(format!(
            "no valid fan configurations: all {received} dropped (unknown/non-controllable control id, unsupported mode, or no controllable fan headers detected yet)"
        )));
    }

    *FAN_CONFIG.lock() = validated;
    apply_once();
    Ok(())
}

// --- AI calibration (per-fan PWM↔RPM sweep) ------------------------------------
//
// The CorePilot equivalent of FanXpert's "AI Tuning": for each controllable
// header, step the PWM duty across its range, let the fan settle, and record the
// resulting RPM. From that we derive the lowest duty the fan reliably spins at
// (its quietest stable speed), its max RPM, and the duty beyond which RPM no
// longer climbs — enough for the UI to build a no-stall curve tailored per fan.
// Implementation is our own (no third-party fan-control code).

/// One measured (duty %, RPM) sample from a calibration sweep.
/// Round-trips over IPC (auto-tune results store + re-ingest calibrations).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalibPoint {
    pub duty: f32,
    pub rpm: f32,
}

/// The result of calibrating one fan header.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FanCalibration {
    pub control_id: String,
    pub name: String,
    /// Lowest duty at which the fan reliably spins (its quietest stable speed).
    pub min_start_duty: f32,
    pub max_rpm: f32,
    /// Lowest duty whose RPM already reaches ~97% of max (higher is wasted noise).
    pub saturation_duty: f32,
    pub points: Vec<CalibPoint>,
    /// True when the header never produced any RPM (no fan, or RPM not wired).
    pub disconnected: bool,
}

/// Progress event payload, emitted as `fan-calib-progress` after every step.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CalibProgress {
    control_id: String,
    name: String,
    fan_index: usize,
    fan_total: usize,
    duty: f32,
    rpm: Option<f32>,
}

/// RPM currently paired to `control_id` in the latest snapshot (same chip prefix
/// + channel index as [`build_state`]). `None` if unread / unpaired.
pub(crate) fn paired_rpm(control_id: &str) -> Option<f32> {
    let raw = SNAP.lock();
    let (cprefix, cidx) = split_id(control_id, "/control/")?;
    raw.fans
        .iter()
        .find_map(|(fid, _, frpm)| match split_id(fid, "/fan/") {
            Some((fprefix, fidx)) if fprefix == cprefix && fidx == cidx => *frpm,
            _ => None,
        })
}

/// Human name of a control id from the latest snapshot (falls back to the id).
fn control_name(control_id: &str) -> String {
    SNAP.lock()
        .controls
        .iter()
        .find(|(id, _, _, _, _)| id == control_id)
        .map(|(_, name, _, _, _)| name.clone())
        .unwrap_or_else(|| control_id.to_string())
}

/// Duty steps for the sweep — denser at the low end, where start/stop lives.
const CALIB_STEPS: [f32; 13] = [
    0.0, 8.0, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0,
];
/// Settle time per step before reading RPM (≈2 sidecar samples at ~1 Hz).
const CALIB_SETTLE_MS: u64 = 2500;
/// RPM at or below this is treated as "not spinning".
const CALIB_MIN_RPM: f32 = 150.0;

/// Sweep one header and derive its calibration. Hands the header back to the
/// BIOS at the end so it is never left pinned by the sweep.
fn calibrate_one(
    app: &tauri::AppHandle,
    control_id: &str,
    idx: usize,
    total: usize,
) -> FanCalibration {
    use tauri::Emitter;
    let name = control_name(control_id);
    let mut points: Vec<CalibPoint> = Vec::new();

    for &duty in CALIB_STEPS.iter() {
        send_set(control_id, duty);
        std::thread::sleep(Duration::from_millis(CALIB_SETTLE_MS));
        let rpm = paired_rpm(control_id);
        let _ = app.emit(
            "fan-calib-progress",
            CalibProgress {
                control_id: control_id.to_string(),
                name: name.clone(),
                fan_index: idx,
                fan_total: total,
                duty,
                rpm,
            },
        );
        if let Some(r) = rpm {
            points.push(CalibPoint {
                duty,
                rpm: r.max(0.0),
            });
        }
    }
    send_auto(control_id);

    let max_rpm = points.iter().map(|p| p.rpm).fold(0.0_f32, f32::max);
    let disconnected = max_rpm < CALIB_MIN_RPM;
    let min_start_duty = points
        .iter()
        .find(|p| p.rpm >= CALIB_MIN_RPM)
        .map(|p| p.duty)
        .unwrap_or(0.0);
    let sat_threshold = max_rpm * 0.97;
    let saturation_duty = points
        .iter()
        .find(|p| max_rpm > 0.0 && p.rpm >= sat_threshold)
        .map(|p| p.duty)
        .unwrap_or(100.0);

    FanCalibration {
        control_id: control_id.to_string(),
        name,
        min_start_duty,
        max_rpm,
        saturation_duty,
        points,
        disconnected,
    }
}

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

/// Run an AI calibration sweep over the given controllable headers (or all of
/// them when the list is empty). Pauses the engine for the duration, steps each
/// fan's PWM across [`CALIB_STEPS`], and returns the per-fan calibration. Emits a
/// `fan-calib-progress` event after every step so the UI can show live progress.
#[tauri::command]
pub async fn fan_calibrate(
    app: tauri::AppHandle,
    control_ids: Vec<String>,
) -> crate::error::CoreResult<Vec<FanCalibration>> {
    crate::sidecar::ensure();

    let controllable = controllable_ids();
    let mut targets: Vec<String> = if control_ids.is_empty() {
        controllable.iter().cloned().collect()
    } else {
        control_ids
            .into_iter()
            .filter(|id| is_valid_control_id(id) && controllable.contains(id))
            .collect()
    };
    targets.sort();
    if targets.is_empty() {
        return Err(crate::error::CoreError::from(
            "no controllable fan headers to calibrate".to_string(),
        ));
    }
    // Only one sweep at a time — it takes exclusive manual control of the fans.
    if CALIBRATING.swap(true, Ordering::SeqCst) {
        return Err(crate::error::CoreError::from(
            "a fan calibration is already running".to_string(),
        ));
    }

    let _ = send("interval 1000");
    let result =
        tauri::async_runtime::spawn_blocking(move || calibrate_headers(&app, &targets)).await;

    CALIBRATING.store(false, Ordering::SeqCst);
    let _ = send("interval 1400");
    // Force the engine to re-apply the user's real config now (LAST is stale after
    // the sweep drove the fans directly, so clear it first to defeat hysteresis).
    // Also drop the smoothed curve duties so each fan re-seeds its ramp from the
    // post-sweep live position rather than a pre-sweep value.
    LAST.lock().clear();
    CURVE_DUTY.lock().clear();
    apply_once();

    match result {
        Ok(out) => Ok(out),
        Err(e) => Err(crate::error::CoreError::from(format!(
            "calibration task failed: {e}"
        ))),
    }
}

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
        v.iter()
            .map(|&(temp_c, duty)| CurvePoint { temp_c, duty })
            .collect()
    }

    #[test]
    fn combined_target_takes_max_of_both_curves() {
        let c = cfg(
            pts(&[(30.0, 20.0), (80.0, 100.0)]),
            pts(&[(30.0, 30.0), (80.0, 90.0)]),
        );
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
        c.curve2.extend((0..40).map(|i| CurvePoint {
            temp_c: i as f32,
            duty: 50.0,
        }));
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
