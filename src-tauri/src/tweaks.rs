//! Reversible Windows performance tweaks — the "深度优化" feature.
//!
//! Every tweak is split into an `apply` (set the optimized value) and a `revert`
//! (restore Windows' documented default) so nothing is one-way. Techniques are
//! re-implemented from public registry keys / `powercfg` / `sc` / `fsutil` usage
//! (facts, not copyrighted code), so this stays license-clean.
//!
//! Tweaks are grouped into two zones by the frontend:
//! * **safe**  — reversible, low risk (MMCSS/gaming priority, network throttling,
//!   power plan, menu delay, telemetry services…).
//! * **danger** — real performance/latency wins but they weaken the system
//!   (Defender, VBS/HVCI, SmartScreen, auto-update, search) — shown behind a
//!   warning and an explicit confirm in the UI.
//!
//! IMPORTANT: these commands modify the live system. The backend only runs them
//! when the UI explicitly calls `tweak_apply` / `tweak_revert`.

use std::os::windows::process::CommandExt;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};

/// `CREATE_NO_WINDOW` — never flash a console for the helper processes.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Run a console helper and map a non-zero exit (or spawn failure) to an error
/// carrying stderr/stdout. Used for the commands that MUST succeed.
fn run(program: &str, args: &[&str]) -> CoreResult<()> {
    let out = Command::new(crate::commands::system_tool(program))
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| CoreError::Msg(format!("{program} 启动失败: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if msg.is_empty() {
        msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    Err(CoreError::Msg(format!(
        "{program} {} 失败: {}",
        args.join(" "),
        if msg.is_empty() {
            "非零退出".into()
        } else {
            msg
        }
    )))
}

/// Best-effort variant: run but ignore failure (e.g. deleting a value that isn't
/// there during revert, or stopping an already-stopped service).
fn run_soft(program: &str, args: &[&str]) {
    let _ = Command::new(crate::commands::system_tool(program))
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

/// Run a console helper and return `(success, stdout)`. Never errors: a spawn
/// failure yields `(false, "")`. Used to *read* current system state (reg query
/// / sc qc / powercfg) when snapshotting, where failure simply means "unknown".
fn run_capture(program: &str, args: &[&str]) -> (bool, String) {
    match Command::new(crate::commands::system_tool(program))
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        ),
        Err(_) => (false, String::new()),
    }
}

// --- small helpers around the standard tools ----------------------------------

fn reg_add(key: &str, name: &str, kind: &str, data: &str) -> CoreResult<()> {
    run(
        "reg",
        &["add", key, "/v", name, "/t", kind, "/d", data, "/f"],
    )
}

fn reg_del(key: &str, name: &str) {
    run_soft("reg", &["delete", key, "/v", name, "/f"]);
}

/// Set a service start type ("disabled" | "auto" | "demand" | "delayed-auto").
/// `sc` needs the value as a separate token after `start=`.
fn sc_config(service: &str, start: &str) -> CoreResult<()> {
    run("sc", &["config", service, "start=", start])
}

fn powercfg(args: &[&str]) -> CoreResult<()> {
    run("powercfg", args)
}

fn ps(script: &str) -> CoreResult<()> {
    run(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", script],
    )
}

const MMCSS_GAMES: &str =
    r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games";
const MMCSS_PROFILE: &str =
    r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile";
const POWER_BALANCED: &str = "381b4222-f694-41f0-9685-ff5bb260df2e";
const POWER_ULTIMATE: &str = "e9a42b02-d5df-448d-aa00-03f14749eb61";
/// Fixed GUID for CorePilot's copy of the Ultimate Performance template. A
/// GUID-less `-duplicatescheme` minted a new plan on every apply (they piled up
/// in the control panel) and then activated the hidden template instead of the
/// copy; duplicating to one fixed GUID is idempotent (a repeat fails harmlessly).
const POWER_ULTIMATE_COPY: &str = "c09e7a11-0e5a-4d1f-b2c3-e9a42b02d5df";

// --- reversible-state snapshot / restore ---------------------------------------
//
// Before a tweak mutates anything we capture the CURRENT state of exactly the
// targets it touches. `tweak_apply` SERIALIZES that capture to a JSON string and
// hands it back to the caller; the frontend persists it per-tweak-id and passes
// it back to `tweak_revert`, which restores those exact prior values instead of
// guessing Windows' documented defaults. This is what makes `vbs_off` safe to
// revert: if HVCI was already disabled we recorded `Enabled=0` and put that back,
// rather than force-enabling it. Everything here is best-effort and panic-free —
// an empty/unparseable snapshot degrades to the documented-default path on
// revert, never a crash.

/// One thing a tweak can change, plus the value it had *before* we touched it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum Snapshot {
    /// A registry value. `data`/`type` are `None` when the value did not exist
    /// (so revert deletes it), `Some` when it did (so revert restores it).
    #[serde(rename = "reg")]
    Reg {
        key: String,
        name: String,
        #[serde(rename = "type")]
        ty: Option<String>,
        data: Option<String>,
    },
    /// A service's start type, as an `sc config start=` token
    /// ("auto"|"demand"|"disabled"|"delayed-auto"). `None` if it couldn't be read.
    #[serde(rename = "service")]
    Service { name: String, start: Option<String> },
    /// The active power scheme GUID. `None` if it couldn't be read.
    #[serde(rename = "power")]
    Power { guid: Option<String> },
}

// --- single-target capture ------------------------------------------------------

/// Normalise a `REG_DWORD`/`REG_QWORD` payload that `reg query` prints in hex
/// (`0x1a`) into the decimal form `reg add /d` accepts unambiguously. Other
/// types (REG_SZ, REG_EXPAND_SZ, …) are passed through verbatim.
fn normalize_reg_data(ty: &str, raw: &str) -> String {
    let raw = raw.trim();
    if ty.eq_ignore_ascii_case("REG_DWORD") || ty.eq_ignore_ascii_case("REG_QWORD") {
        if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
            if let Ok(v) = u64::from_str_radix(hex, 16) {
                return v.to_string();
            }
        }
    }
    raw.to_string()
}

/// Parse the `<name> <type> <data>` line out of `reg query <key> /v <name>`.
/// The value columns are whitespace-separated but the *data* can itself contain
/// spaces (e.g. a REG_SZ), so we split on the type token, not on every space.
fn parse_reg_query(stdout: &str, name: &str) -> Option<(String, String)> {
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        // Value lines start with the value name; skip the key header line.
        if !trimmed.starts_with(name) {
            continue;
        }
        // Find the REG_* type token.
        let mut parts = trimmed.splitn(2, "REG_");
        let _before = parts.next()?; // the value name + padding
        let rest = parts.next()?; // e.g. "DWORD    0x1a"
        let mut rest_parts = rest.splitn(2, char::is_whitespace);
        let ty_suffix = rest_parts.next()?; // "DWORD"
        let data = rest_parts.next().unwrap_or("").trim(); // "0x1a" or ""
        let ty = format!("REG_{ty_suffix}");
        return Some((ty.clone(), normalize_reg_data(&ty, data)));
    }
    None
}

/// Capture the current state of one registry value (exists → type+data, or a
/// did-not-exist marker).
fn capture_reg(key: &str, name: &str) -> Snapshot {
    let (ok, stdout) = run_capture("reg", &["query", key, "/v", name]);
    if ok {
        if let Some((ty, data)) = parse_reg_query(&stdout, name) {
            return Snapshot::Reg {
                key: key.to_string(),
                name: name.to_string(),
                ty: Some(ty),
                data: Some(data),
            };
        }
    }
    // Either the key/value is absent or the query failed — record "did not exist"
    // so revert removes whatever the tweak added.
    Snapshot::Reg {
        key: key.to_string(),
        name: name.to_string(),
        ty: None,
        data: None,
    }
}

/// Map a numeric `START_TYPE` code (and the human label) from `sc qc` to the
/// token `sc config start=` expects.
fn start_code_to_token(code: u32, label: &str) -> &'static str {
    match code {
        2 => {
            if label.to_uppercase().contains("DELAYED") {
                "delayed-auto"
            } else {
                "auto"
            }
        }
        3 => "demand",
        4 => "disabled",
        // 0/1 are boot/system drivers — not something we toggle; closest safe
        // mapping for restore is "demand" but these won't occur for our services.
        _ => "demand",
    }
}

/// Capture a service's current start type via `sc qc <svc>`.
fn capture_service(name: &str) -> Snapshot {
    let (ok, stdout) = run_capture("sc", &["qc", name]);
    let start = if ok {
        let mut found: Option<String> = None;
        for line in stdout.lines() {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("START_TYPE") {
                // e.g. ": 2   AUTO_START"  /  ": 2   AUTO_START (DELAYED)"
                let rest = rest.trim_start_matches(':').trim();
                let mut it = rest.splitn(2, char::is_whitespace);
                let code = it.next().unwrap_or("").trim();
                let label = it.next().unwrap_or("").trim();
                if let Ok(code) = code.parse::<u32>() {
                    found = Some(start_code_to_token(code, label).to_string());
                }
                break;
            }
        }
        found
    } else {
        None
    };
    Snapshot::Service {
        name: name.to_string(),
        start,
    }
}

/// Capture the active power scheme GUID via `powercfg /getactivescheme`.
fn capture_power() -> Snapshot {
    let (ok, stdout) = run_capture("powercfg", &["/getactivescheme"]);
    let guid = if ok {
        // "Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)"
        stdout.split_whitespace().find_map(|tok| {
            let t = tok.trim_matches(|c| c == '(' || c == ')');
            if is_guid(t) {
                Some(t.to_string())
            } else {
                None
            }
        })
    } else {
        None
    };
    Snapshot::Power { guid }
}

/// Loose GUID shape check (8-4-4-4-12 hex). Avoids restoring a malformed token.
fn is_guid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let lens = [8usize, 4, 4, 4, 12];
    parts.len() == 5
        && parts
            .iter()
            .zip(lens)
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The complete set of tweak ids the app understands. Used to reject unknown ids
/// in `tweak_revert` before the snapshot/fallback logic runs. MUST match the arms
/// in `tweak_apply` / `tweak_revert`.
const KNOWN_TWEAKS: &[&str] = &[
    // safe
    "mmcss_gaming",
    "network_throttling_off",
    "foreground_boost",
    "menu_delay_0",
    "ntfs_lastaccess_off",
    "telemetry_off",
    "ultimate_power_plan",
    "game_dvr_off",
    // danger
    "defender_rt_off",
    "vbs_off",
    "smartscreen_off",
    "sysmain_off",
    "search_off",
    "auto_update_off",
];

fn is_known_tweak(id: &str) -> bool {
    KNOWN_TWEAKS.contains(&id)
}

// --- which targets each tweak touches -------------------------------------------

/// One thing a tweak may change. This table is the single source for BOTH the
/// pre-apply capture and the revert allow-list: `tweak_revert` refuses any
/// snapshot entry not listed here for that id. Without that, revert wrote
/// whatever registry key/service the caller sent — from an elevated process,
/// e.g. a service `ImagePath`, i.e. SYSTEM code execution for any compromised
/// frontend. MUST stay in sync with `tweak_apply`.
#[derive(Debug, Clone, Copy)]
enum Target {
    Reg(&'static str, &'static str),
    Service(&'static str),
    Power,
}

const PRIORITY_CONTROL: &str = r"HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl";
const HVCI: &str =
    r"HKLM\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity";
const EXPLORER: &str = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer";
const WU_AU: &str = r"HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU";
const GAME_CONFIG: &str = r"HKCU\System\GameConfigStore";
const GAME_DVR_POLICY: &str = r"HKLM\SOFTWARE\Policies\Microsoft\Windows\GameDVR";

fn targets(id: &str) -> &'static [Target] {
    use Target::{Power, Reg, Service};
    match id {
        // ---- SAFE ----
        "mmcss_gaming" => &[
            Reg(MMCSS_PROFILE, "SystemResponsiveness"),
            Reg(MMCSS_GAMES, "GPU Priority"),
            Reg(MMCSS_GAMES, "Priority"),
            Reg(MMCSS_GAMES, "Scheduling Category"),
            Reg(MMCSS_GAMES, "SFIO Priority"),
        ],
        "network_throttling_off" => &[Reg(MMCSS_PROFILE, "NetworkThrottlingIndex")],
        "foreground_boost" => &[Reg(PRIORITY_CONTROL, "Win32PrioritySeparation")],
        "menu_delay_0" => &[Reg(r"HKCU\Control Panel\Desktop", "MenuShowDelay")],
        // fsutil's disablelastaccess lives in the registry; capture it so revert
        // restores the prior policy byte instead of assuming "2".
        "ntfs_lastaccess_off" => &[Reg(
            r"HKLM\SYSTEM\CurrentControlSet\Control\FileSystem",
            "NtfsDisableLastAccessUpdate",
        )],
        "telemetry_off" => &[Service("DiagTrack"), Service("dmwappushservice")],
        "ultimate_power_plan" => &[Power],
        "game_dvr_off" => &[
            Reg(GAME_CONFIG, "GameDVR_Enabled"),
            Reg(GAME_DVR_POLICY, "AllowGameDVR"),
        ],
        // ---- DANGER ----
        // Defender realtime monitoring is toggled via Set-MpPreference, not a
        // directly captured key; no reliable snapshot target, so revert falls
        // back to re-enabling (documented default) as before.
        "defender_rt_off" => &[],
        "vbs_off" => &[Reg(HVCI, "Enabled")],
        "smartscreen_off" => &[Reg(EXPLORER, "SmartScreenEnabled")],
        "sysmain_off" => &[Service("SysMain")],
        "search_off" => &[Service("WSearch")],
        "auto_update_off" => &[Reg(WU_AU, "NoAutoUpdate")],
        _ => &[],
    }
}

fn capture(target: Target) -> Snapshot {
    match target {
        Target::Reg(key, name) => capture_reg(key, name),
        Target::Service(name) => capture_service(name),
        Target::Power => capture_power(),
    }
}

/// Start-type tokens `sc config start=` accepts (and `capture_service` emits).
const START_TOKENS: &[&str] = &["auto", "demand", "disabled", "delayed-auto"];

/// Refuse a snapshot that names anything `id` doesn't touch, or carries a value
/// shape our capture can't have produced.
fn validate_snapshot(id: &str, snaps: &[Snapshot]) -> CoreResult<()> {
    let allowed = targets(id);
    for snap in snaps {
        let ok =
            match snap {
                Snapshot::Reg {
                    key,
                    name,
                    ty,
                    data,
                } => allowed.iter().any(
                    |t| matches!(t, Target::Reg(k, n) if k.eq_ignore_ascii_case(key) && n == name),
                ) && match (ty.as_deref(), data) {
                    (None, None) => true,
                    (Some("REG_DWORD"), Some(d)) => d.parse::<u32>().is_ok(),
                    (Some("REG_SZ"), Some(d)) => !d.contains(['\0', '\n', '\r']),
                    _ => false,
                },
                Snapshot::Service { name, start } => {
                    allowed
                        .iter()
                        .any(|t| matches!(t, Target::Service(n) if n.eq_ignore_ascii_case(name)))
                        && start.as_deref().is_none_or(|s| START_TOKENS.contains(&s))
                }
                Snapshot::Power { guid } => {
                    allowed.iter().any(|t| matches!(t, Target::Power))
                        && guid.as_deref().is_none_or(is_guid)
                }
            };
        if !ok {
            return Err(CoreError::Msg(format!(
                "还原数据与优化项 {id} 不符，已拒绝还原"
            )));
        }
    }
    Ok(())
}

/// Capture the targets for `id` and serialize them to a JSON snapshot string that
/// the caller persists and later hands to [`tweak_revert`]. Best-effort: any read
/// failure is encoded as a sensible marker, never a panic. Returns an empty string
/// when the tweak has no captured targets (or serialization fails), which the
/// frontend stores verbatim and which makes revert take the documented-default
/// fallback path.
fn snapshot_before_apply(id: &str) -> String {
    let snaps: Vec<Snapshot> = targets(id).iter().map(|t| capture(*t)).collect();
    if snaps.is_empty() {
        return String::new();
    }
    serde_json::to_string(&snaps).unwrap_or_default()
}

// --- restore from snapshot ------------------------------------------------------

/// Restore one captured target to its exact prior value.
fn restore_one(snap: &Snapshot) -> CoreResult<()> {
    match snap {
        Snapshot::Reg {
            key,
            name,
            ty,
            data,
        } => match (ty, data) {
            // Restore the exact prior type+data.
            (Some(ty), Some(data)) => reg_add(key, name, ty, data),
            // Value did not exist before — remove what the tweak added (absent
            // already is fine, hence best-effort).
            _ => {
                reg_del(key, name);
                Ok(())
            }
        },
        Snapshot::Service { name, start } => {
            if let Some(start) = start {
                sc_config(name, start)?;
                // If we are re-enabling a service, also (best-effort) start it so
                // behaviour matches the documented-default revert path.
                if start != "disabled" {
                    run_soft("sc", &["start", name]);
                }
            }
            Ok(())
        }
        Snapshot::Power { guid } => match guid {
            Some(guid) if is_guid(guid) => powercfg(&["-setactive", guid]),
            _ => Ok(()),
        },
    }
}

/// Revert from the JSON `snapshot` captured at apply time and passed back by the
/// frontend. `Ok(false)` = no usable snapshot (empty / unparseable / no targets),
/// so the caller takes the documented-default fallback. Every target is
/// attempted; failures are collected and reported together instead of claiming
/// "已还原" while e.g. HVCI stayed off.
fn restore_from_snapshot(id: &str, snapshot: &str) -> CoreResult<bool> {
    if snapshot.trim().is_empty() {
        return Ok(false);
    }
    let Ok(snaps) = serde_json::from_str::<Vec<Snapshot>>(snapshot) else {
        return Ok(false);
    };
    if snaps.is_empty() {
        return Ok(false);
    }
    validate_snapshot(id, &snaps)?;
    let failures: Vec<String> = snaps
        .iter()
        .filter_map(|s| restore_one(s).err().map(|e| e.to_string()))
        .collect();
    if failures.is_empty() {
        Ok(true)
    } else {
        Err(CoreError::Msg(format!(
            "部分设置未能还原: {}",
            failures.join("；")
        )))
    }
}

// --- apply / revert dispatch ---------------------------------------------------

/// Apply the tweak with the given id. Modifies the live system.
///
/// BEFORE mutating anything we snapshot the current state of exactly the targets
/// this id touches and RETURN that snapshot as a JSON string. The frontend
/// persists it per-tweak-id and passes it back to [`tweak_revert`], which restores
/// the *real* prior values rather than guessing Windows' defaults. The snapshot is
/// best-effort and never blocks the apply; unknown ids capture nothing (empty
/// string) and fall through to the error arm below. On apply failure we return the
/// error and no snapshot — the system was at worst partially changed, and reverting
/// it would need a snapshot we never handed out, so the frontend leaves the toggle
/// off.
///
/// A multi-step tweak that fails partway is rolled back from that same snapshot
/// before the error is returned — otherwise the system was left half-changed and
/// a retry snapshotted the half-changed state as "prior", losing the original.
///
/// Async + blocking pool: every arm spawns `reg`/`sc`/`powercfg`/`powershell`
/// (rule 1 — a sync command would run them on the main thread).
#[tauri::command]
pub async fn tweak_apply(id: String) -> CoreResult<String> {
    crate::commands::run_blocking(move || tweak_apply_blocking(&id)).await
}

fn tweak_apply_blocking(id: &str) -> CoreResult<String> {
    // Capture-then-mutate. Done first so the returned snapshot reflects the
    // pre-apply state even for a tweak that only partially succeeds.
    let snapshot = snapshot_before_apply(id);
    let applied: CoreResult<()> = match id {
        // ---- SAFE ----
        "mmcss_gaming" => {
            reg_add(MMCSS_PROFILE, "SystemResponsiveness", "REG_DWORD", "10")?;
            reg_add(MMCSS_GAMES, "GPU Priority", "REG_DWORD", "8")?;
            reg_add(MMCSS_GAMES, "Priority", "REG_DWORD", "6")?;
            reg_add(MMCSS_GAMES, "Scheduling Category", "REG_SZ", "High")?;
            reg_add(MMCSS_GAMES, "SFIO Priority", "REG_SZ", "High")?;
            Ok(())
        }
        "network_throttling_off" => reg_add(
            MMCSS_PROFILE,
            "NetworkThrottlingIndex",
            "REG_DWORD",
            "4294967295",
        ),
        "foreground_boost" => reg_add(
            r"HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl",
            "Win32PrioritySeparation",
            "REG_DWORD",
            "38", // 0x26 — favour the foreground app
        ),
        "menu_delay_0" => reg_add(
            r"HKCU\Control Panel\Desktop",
            "MenuShowDelay",
            "REG_SZ",
            "0",
        ),
        "ntfs_lastaccess_off" => run("fsutil", &["behavior", "set", "disablelastaccess", "1"]),
        "telemetry_off" => {
            run_soft("sc", &["stop", "DiagTrack"]);
            sc_config("DiagTrack", "disabled")?;
            run_soft("sc", &["stop", "dmwappushservice"]);
            sc_config("dmwappushservice", "disabled")?;
            Ok(())
        }
        "ultimate_power_plan" => {
            // The copy may already exist from an earlier apply; that's fine.
            run_soft(
                "powercfg",
                &["-duplicatescheme", POWER_ULTIMATE, POWER_ULTIMATE_COPY],
            );
            powercfg(&["-setactive", POWER_ULTIMATE_COPY])
        }
        "game_dvr_off" => {
            reg_add(
                r"HKCU\System\GameConfigStore",
                "GameDVR_Enabled",
                "REG_DWORD",
                "0",
            )?;
            reg_add(
                r"HKLM\SOFTWARE\Policies\Microsoft\Windows\GameDVR",
                "AllowGameDVR",
                "REG_DWORD",
                "0",
            )
        }

        // ---- DANGER ----
        "defender_rt_off" => ps("Set-MpPreference -DisableRealtimeMonitoring $true"),
        "vbs_off" => reg_add(
            r"HKLM\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
            "Enabled",
            "REG_DWORD",
            "0",
        ),
        "smartscreen_off" => reg_add(
            r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer",
            "SmartScreenEnabled",
            "REG_SZ",
            "Off",
        ),
        "sysmain_off" => {
            run_soft("sc", &["stop", "SysMain"]);
            sc_config("SysMain", "disabled")
        }
        "search_off" => {
            run_soft("sc", &["stop", "WSearch"]);
            sc_config("WSearch", "disabled")
        }
        "auto_update_off" => reg_add(
            r"HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU",
            "NoAutoUpdate",
            "REG_DWORD",
            "1",
        ),

        other => Err(CoreError::Msg(format!("未知的优化项: {other}"))),
    };
    if let Err(e) = applied {
        if let Err(rollback) = restore_from_snapshot(id, &snapshot) {
            tracing::warn!("tweak {id}: rollback after failed apply also failed: {rollback}");
        }
        return Err(e);
    }
    // Hand back the captured snapshot so the frontend can persist it and pass it
    // to a later revert.
    Ok(snapshot)
}

/// Revert the tweak, restoring the EXACT pre-apply state from the `snapshot` that
/// [`tweak_apply`] returned and the frontend handed back (so e.g. `vbs_off` revert
/// puts back whatever HVCI value was there before — never force-enables it). When
/// the snapshot is empty/missing/unparseable (e.g. it was applied by an older
/// build that didn't return one) it falls back to writing Windows' documented
/// defaults below.
#[tauri::command]
pub async fn tweak_revert(id: String, snapshot: String) -> CoreResult<()> {
    crate::commands::run_blocking(move || tweak_revert_blocking(&id, &snapshot)).await
}

fn tweak_revert_blocking(id: &str, snapshot: &str) -> CoreResult<()> {
    // Validate the id against the known set first so an unknown id still errors
    // the same way it always did, even with no snapshot present.
    if !is_known_tweak(id) {
        return Err(CoreError::Msg(format!("未知的优化项: {id}")));
    }
    // True reversible restore from the pre-apply snapshot, if we have a usable one.
    if restore_from_snapshot(id, snapshot)? {
        return Ok(());
    }
    // No snapshot → documented-default fallback (legacy behaviour).
    match id {
        // ---- SAFE ----
        "mmcss_gaming" => {
            reg_add(MMCSS_PROFILE, "SystemResponsiveness", "REG_DWORD", "20")?;
            reg_add(MMCSS_GAMES, "GPU Priority", "REG_DWORD", "8")?;
            reg_add(MMCSS_GAMES, "Priority", "REG_DWORD", "2")?;
            reg_add(MMCSS_GAMES, "Scheduling Category", "REG_SZ", "Medium")?;
            reg_add(MMCSS_GAMES, "SFIO Priority", "REG_SZ", "Normal")?;
            Ok(())
        }
        "network_throttling_off" => {
            reg_add(MMCSS_PROFILE, "NetworkThrottlingIndex", "REG_DWORD", "10")
        }
        "foreground_boost" => reg_add(
            r"HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl",
            "Win32PrioritySeparation",
            "REG_DWORD",
            "2",
        ),
        "menu_delay_0" => reg_add(
            r"HKCU\Control Panel\Desktop",
            "MenuShowDelay",
            "REG_SZ",
            "400",
        ),
        "ntfs_lastaccess_off" => run("fsutil", &["behavior", "set", "disablelastaccess", "2"]),
        "telemetry_off" => {
            sc_config("DiagTrack", "auto")?;
            run_soft("sc", &["start", "DiagTrack"]);
            sc_config("dmwappushservice", "demand")?;
            Ok(())
        }
        "ultimate_power_plan" => powercfg(&["-setactive", POWER_BALANCED]),
        "game_dvr_off" => {
            reg_add(
                r"HKCU\System\GameConfigStore",
                "GameDVR_Enabled",
                "REG_DWORD",
                "1",
            )?;
            reg_del(
                r"HKLM\SOFTWARE\Policies\Microsoft\Windows\GameDVR",
                "AllowGameDVR",
            );
            Ok(())
        }

        // ---- DANGER ----
        "defender_rt_off" => ps("Set-MpPreference -DisableRealtimeMonitoring $false"),
        "vbs_off" => reg_add(
            r"HKLM\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
            "Enabled",
            "REG_DWORD",
            "1",
        ),
        "smartscreen_off" => reg_add(
            r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer",
            "SmartScreenEnabled",
            "REG_SZ",
            "Warn",
        ),
        "sysmain_off" => {
            sc_config("SysMain", "auto")?;
            run_soft("sc", &["start", "SysMain"]);
            Ok(())
        }
        "search_off" => {
            sc_config("WSearch", "delayed-auto")?;
            run_soft("sc", &["start", "WSearch"]);
            Ok(())
        }
        "auto_update_off" => {
            reg_del(
                r"HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU",
                "NoAutoUpdate",
            );
            Ok(())
        }

        other => Err(CoreError::Msg(format!("未知的优化项: {other}"))),
    }
}

/// Exit code our restore-point script uses for "Checkpoint-Computer returned but
/// no new point exists" (Windows' 24 h rate limit, or System Protection off).
const RESTORE_POINT_NOT_CREATED: i32 = 3;

/// Create a System Restore point before the user applies tweaks. Windows
/// rate-limits these to one per ~24 h and `Checkpoint-Computer` then SUCCEEDS
/// with only a (localised) warning — so we compare the newest restore point's
/// sequence number before and after instead of trusting the exit status.
///
/// Async + blocking pool: this is a VSS checkpoint, often tens of seconds.
#[tauri::command]
pub async fn create_restore_point() -> CoreResult<()> {
    crate::commands::run_blocking(create_restore_point_blocking).await
}

fn create_restore_point_blocking() -> CoreResult<()> {
    const SCRIPT: &str = "$d = $env:SystemDrive + '\\'; \
        Enable-ComputerRestore -Drive $d -ErrorAction SilentlyContinue; \
        $b = (Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Measure-Object -Property SequenceNumber -Maximum).Maximum; \
        Checkpoint-Computer -Description 'CorePilot 优化前' -RestorePointType MODIFY_SETTINGS -WarningAction SilentlyContinue; \
        $a = (Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Measure-Object -Property SequenceNumber -Maximum).Maximum; \
        if ($a -eq $b) { exit 3 }";
    let out = Command::new(crate::commands::system_tool("powershell"))
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| CoreError::Msg(format!("powershell 启动失败: {e}")))?;
    match out.status.code() {
        Some(0) => Ok(()),
        Some(RESTORE_POINT_NOT_CREATED) => Err(CoreError::Msg(
            "未新建还原点：Windows 每 24 小时只允许创建一个，或系统保护已关闭".into(),
        )),
        _ => {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(CoreError::Msg(format!("创建还原点失败: {msg}")))
        }
    }
}

#[cfg(test)]
mod revert_validation_tests {
    use super::*;

    fn reg(key: &str, name: &str, ty: Option<&str>, data: Option<&str>) -> Snapshot {
        Snapshot::Reg {
            key: key.into(),
            name: name.into(),
            ty: ty.map(Into::into),
            data: data.map(Into::into),
        }
    }

    #[test]
    fn accepts_what_capture_produces() {
        let snaps = vec![
            reg(HVCI, "Enabled", Some("REG_DWORD"), Some("1")),
            reg(&HVCI.to_lowercase(), "Enabled", None, None),
        ];
        assert!(validate_snapshot("vbs_off", &snaps).is_ok());
        let svc = vec![Snapshot::Service {
            name: "diagtrack".into(),
            start: Some("delayed-auto".into()),
        }];
        assert!(validate_snapshot("telemetry_off", &svc).is_ok());
        let power = vec![Snapshot::Power {
            guid: Some(POWER_BALANCED.into()),
        }];
        assert!(validate_snapshot("ultimate_power_plan", &power).is_ok());
    }

    #[test]
    fn rejects_targets_outside_the_tweak() {
        // Another tweak's key.
        let foreign = vec![reg(WU_AU, "NoAutoUpdate", Some("REG_DWORD"), Some("0"))];
        assert!(validate_snapshot("vbs_off", &foreign).is_err());
        // The SYSTEM-execution primitive.
        let image_path = vec![reg(
            r"HKLM\SYSTEM\CurrentControlSet\Services\DiagTrack",
            "ImagePath",
            Some("REG_EXPAND_SZ"),
            Some(r"C:\evil.exe"),
        )];
        assert!(validate_snapshot("telemetry_off", &image_path).is_err());
        let svc = vec![Snapshot::Service {
            name: "WinDefend".into(),
            start: Some("disabled".into()),
        }];
        assert!(validate_snapshot("sysmain_off", &svc).is_err());
        let power = vec![Snapshot::Power {
            guid: Some(POWER_BALANCED.into()),
        }];
        assert!(validate_snapshot("vbs_off", &power).is_err());
    }

    #[test]
    fn rejects_value_shapes_capture_cannot_produce() {
        for (ty, data) in [
            (Some("REG_EXPAND_SZ"), Some("x")),
            (Some("REG_DWORD"), Some("abc")),
            (Some("REG_SZ"), Some("a\nb")),
            (Some("REG_DWORD"), None),
        ] {
            let snaps = vec![reg(EXPLORER, "SmartScreenEnabled", ty, data)];
            assert!(
                validate_snapshot("smartscreen_off", &snaps).is_err(),
                "{ty:?} {data:?}"
            );
        }
        let bad_start = vec![Snapshot::Service {
            name: "SysMain".into(),
            start: Some("boot".into()),
        }];
        assert!(validate_snapshot("sysmain_off", &bad_start).is_err());
        let bad_guid = vec![Snapshot::Power {
            guid: Some("not-a-guid".into()),
        }];
        assert!(validate_snapshot("ultimate_power_plan", &bad_guid).is_err());
    }

    #[test]
    fn every_known_tweak_but_defender_declares_targets() {
        for id in KNOWN_TWEAKS {
            assert_eq!(targets(id).is_empty(), *id == "defender_rt_off", "{id}");
        }
        assert!(is_guid(POWER_ULTIMATE_COPY));
    }
}
