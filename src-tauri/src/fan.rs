//! Motherboard fan control — the CorePilot "FanXpert" engine.
//!
//! The single `sensord` sidecar (LibreHardwareMonitor) is the actuator: it
//! streams fan RPM / board temperatures / fan-control (PWM) state on stdout and
//! accepts `set <id> <pct>` / `auto <id>` commands on stdin. `sensors.rs` owns
//! that process; it hands us the child's stdin via [`register_sidecar_stdin`]
//! and feeds every stdout line to [`ingest_line`].
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

use std::collections::HashMap;
use std::io::Write;
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

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
}

static SNAP: Lazy<Mutex<Raw>> = Lazy::new(|| Mutex::new(Raw::default()));

/// The sidecar's stdin, for sending fan commands. `None` until the sidecar is
/// spawned (or after it dies and a write fails).
static SIDECAR_STDIN: Lazy<Mutex<Option<ChildStdin>>> = Lazy::new(|| Mutex::new(None));

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
}

/// One point of a fan curve: at `temp_c` °C, run at `duty` %.
#[derive(Deserialize, Clone)]
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
}

// --- wiring from sensors.rs (the sidecar owner) --------------------------------

/// Store the sidecar's stdin handle so the engine can send commands.
pub fn register_sidecar_stdin(stdin: ChildStdin) {
    *SIDECAR_STDIN.lock() = Some(stdin);
}

/// Clear the snapshot when the sidecar exits (UI shows fans as unavailable
/// rather than stale values). The stdin handle is dropped too.
pub fn clear() {
    *SNAP.lock() = Raw::default();
    *SIDECAR_STDIN.lock() = None;
}

/// Parse one sidecar JSON line and update the snapshot. Unknown shapes are
/// ignored; the existing CPU/GPU fields are handled separately in `sensors.rs`.
pub fn ingest_line(line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return;
    };

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
        v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };

    let mut raw = Raw::default();

    if let Some(arr) = json.get("fans").and_then(|v| v.as_array()) {
        for f in arr {
            raw.fans.push((text(f, "id"), text(f, "name"), num(f, "rpm")));
        }
    }
    if let Some(arr) = json.get("temps").and_then(|v| v.as_array()) {
        for t in arr {
            raw.temps.push((text(t, "id"), text(t, "name"), num(t, "c")));
        }
    }
    if let Some(arr) = json.get("controls").and_then(|v| v.as_array()) {
        for c in arr {
            let controllable = c.get("controllable").and_then(|x| x.as_bool()).unwrap_or(false);
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
    raw.got_any = json.get("fans").is_some()
        || json.get("controls").is_some()
        || json.get("temps").is_some();

    if raw.got_any {
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
    id.chars().all(|c| {
        matches!(c, 'A'..='Z' | 'a'..='z' | '0'..='9' | '/' | '_' | '.' | ':' | '-')
    })
}

/// Write a single line command to the sidecar; drop the handle on failure.
fn send(cmd: &str) {
    let mut guard = SIDECAR_STDIN.lock();
    let Some(stdin) = guard.as_mut() else {
        return;
    };
    let line = format!("{cmd}\n");
    if stdin.write_all(line.as_bytes()).is_err() || stdin.flush().is_err() {
        *guard = None; // sidecar gone — stop trying until re-registered
    }
}

fn send_set(id: &str, pct: f32) {
    // Never forward an id that could inject extra tokens/commands into the
    // sidecar's line-oriented stdin protocol.
    if !is_valid_control_id(id) {
        return;
    }
    send(&format!("set {id} {:.0}", pct.clamp(0.0, 100.0)));
}

fn send_auto(id: &str) {
    if !is_valid_control_id(id) {
        return;
    }
    send(&format!("auto {id}"));
}

// --- curve math ----------------------------------------------------------------

/// Linear interpolation of a temperature→duty curve. Points are sorted by
/// temperature; below the first point clamps to its duty, above the last clamps
/// to its duty. Returns 0 for an empty curve.
fn interp(curve: &[CurvePoint], temp: f32) -> f32 {
    if curve.is_empty() {
        return 0.0;
    }
    let mut pts: Vec<&CurvePoint> = curve.iter().collect();
    pts.sort_by(|a, b| a.temp_c.partial_cmp(&b.temp_c).unwrap_or(std::cmp::Ordering::Equal));

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
    if cfgs.is_empty() {
        return;
    }

    // Snapshot temps by id for curve sources.
    let temps: HashMap<String, f32> = {
        let raw = SNAP.lock();
        raw.temps
            .iter()
            .filter_map(|(id, _, v)| v.map(|x| (id.clone(), x)))
            .collect()
    };

    let mut last = LAST.lock();
    let mut curve_duty = CURVE_DUTY.lock();
    for c in &cfgs {
        let floor = c.min_duty.clamp(0.0, 100.0);
        match c.mode.as_str() {
            "manual" => {
                let target = c.manual_pct.clamp(floor, 100.0);
                send_set(&c.control_id, target);
                last.insert(c.control_id.clone(), ("manual".to_string(), target.round() as i32));
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
                    let already_auto =
                        last.get(&c.control_id).map(|(m, _)| m == "auto").unwrap_or(false);
                    if !already_auto {
                        send_auto(&c.control_id);
                        last.insert(c.control_id.clone(), ("auto".to_string(), 0));
                    }
                    // Header handed back to BIOS — forget the ramp so re-acquiring
                    // the curve eases from where the fan actually is.
                    curve_duty.remove(&c.control_id);
                    continue;
                };
                let target = interp(&c.curve, t).clamp(floor, 100.0);
                // Smooth the approach to the target. Seed the per-channel applied
                // duty on first entry (or after a mode change away from curve)
                // from the last known curve duty, else straight to the target so
                // the very first apply isn't a forced ramp from 0.
                let prev_curve = last.get(&c.control_id).map(|(m, _)| m == "curve").unwrap_or(false);
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
                    send_set(&c.control_id, next);
                    last.insert(c.control_id.clone(), ("curve".to_string(), di));
                }
            }
            _ => {
                // auto: hand back to BIOS, but only once per transition.
                let already_auto = last.get(&c.control_id).map(|(m, _)| m == "auto").unwrap_or(false);
                curve_duty.remove(&c.control_id);
                if !already_auto {
                    send_auto(&c.control_id);
                    last.insert(c.control_id.clone(), ("auto".to_string(), 0));
                }
            }
        }
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
    crate::sensors::ensure_sidecar();
    std::thread::Builder::new()
        .name("fan-engine".into())
        .spawn(|| loop {
            apply_once();
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

    let temps: Vec<FanTempSource> = raw
        .temps
        .iter()
        .map(|(id, name, c)| FanTempSource {
            id: id.clone(),
            name: name.clone(),
            c: *c,
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
            pct: *pct,
            controllable: *controllable,
            rpm,
            rpm_name,
        });
    }

    FanState {
        available: raw.got_any,
        supported,
        channels,
        temps,
    }
}

// --- Tauri commands ------------------------------------------------------------

/// Live fan headers + temperature sources for the Fan Control page.
#[tauri::command]
pub fn fan_info() -> FanState {
    // Guarantee the sidecar is up the moment the Fan page asks for data.
    crate::sensors::ensure_sidecar();
    build_state()
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
fn controllable_ids() -> std::collections::HashSet<String> {
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
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalibPoint {
    pub duty: f32,
    pub rpm: f32,
}

/// The result of calibrating one fan header.
#[derive(Serialize, Clone)]
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
fn paired_rpm(control_id: &str) -> Option<f32> {
    let raw = SNAP.lock();
    let (cprefix, cidx) = split_id(control_id, "/control/")?;
    raw.fans.iter().find_map(|(fid, _, frpm)| match split_id(fid, "/fan/") {
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
const CALIB_STEPS: [f32; 13] =
    [0.0, 8.0, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0];
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
            points.push(CalibPoint { duty, rpm: r.max(0.0) });
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

/// Run an AI calibration sweep over the given controllable headers (or all of
/// them when the list is empty). Pauses the engine for the duration, steps each
/// fan's PWM across [`CALIB_STEPS`], and returns the per-fan calibration. Emits a
/// `fan-calib-progress` event after every step so the UI can show live progress.
#[tauri::command]
pub async fn fan_calibrate(
    app: tauri::AppHandle,
    control_ids: Vec<String>,
) -> crate::error::CoreResult<Vec<FanCalibration>> {
    crate::sensors::ensure_sidecar();

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

    let result = tauri::async_runtime::spawn_blocking(move || {
        let total = targets.len();
        let mut out = Vec::with_capacity(total);
        for (i, id) in targets.iter().enumerate() {
            out.push(calibrate_one(&app, id, i, total));
        }
        out
    })
    .await;

    CALIBRATING.store(false, Ordering::SeqCst);
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
