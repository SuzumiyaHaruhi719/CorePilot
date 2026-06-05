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

static ENGINE_STARTED: AtomicBool = AtomicBool::new(false);

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
    send(&format!("set {id} {:.0}", pct.clamp(0.0, 100.0)));
}

fn send_auto(id: &str) {
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

// --- engine --------------------------------------------------------------------

/// One pass: turn each configured fan's mode into a sidecar command.
fn apply_once() {
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
    for c in &cfgs {
        let floor = c.min_duty.clamp(0.0, 100.0);
        match c.mode.as_str() {
            "manual" => {
                let target = c.manual_pct.clamp(floor, 100.0);
                send_set(&c.control_id, target);
                last.insert(c.control_id.clone(), ("manual".to_string(), target.round() as i32));
            }
            "curve" => {
                let Some(src) = c.temp_source_id.as_ref() else {
                    continue;
                };
                let Some(&t) = temps.get(src) else {
                    continue; // no reading yet this tick — leave header as-is
                };
                let target = interp(&c.curve, t).clamp(floor, 100.0);
                let di = target.round() as i32;
                let changed = match last.get(&c.control_id) {
                    // Hysteresis: only re-issue when mode changed or duty moved >=2%.
                    Some((mode, prev)) => mode != "curve" || (di - prev).abs() >= 2,
                    None => true,
                };
                if changed {
                    send_set(&c.control_id, target);
                    last.insert(c.control_id.clone(), ("curve".to_string(), di));
                }
            }
            _ => {
                // auto: hand back to BIOS, but only once per transition.
                let already_auto = last.get(&c.control_id).map(|(m, _)| m == "auto").unwrap_or(false);
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

/// Replace the engine's per-fan configuration. Applied immediately and then on
/// each engine tick. Sending an empty list leaves headers untouched (the engine
/// no-ops); switch a fan to `auto` to actively hand it back to the BIOS.
#[tauri::command]
pub fn fan_set_config(configs: Vec<FanChannelConfig>) -> crate::error::CoreResult<()> {
    *FAN_CONFIG.lock() = configs;
    apply_once();
    Ok(())
}
