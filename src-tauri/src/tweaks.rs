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

use crate::error::{CoreError, CoreResult};

/// `CREATE_NO_WINDOW` — never flash a console for the helper processes.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Run a console helper and map a non-zero exit (or spawn failure) to an error
/// carrying stderr/stdout. Used for the commands that MUST succeed.
fn run(program: &str, args: &[&str]) -> CoreResult<()> {
    let out = Command::new(program)
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
        if msg.is_empty() { "非零退出".into() } else { msg }
    )))
}

/// Best-effort variant: run but ignore failure (e.g. deleting a value that isn't
/// there during revert, or stopping an already-stopped service).
fn run_soft(program: &str, args: &[&str]) {
    let _ = Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

// --- small helpers around the standard tools ----------------------------------

fn reg_add(key: &str, name: &str, kind: &str, data: &str) -> CoreResult<()> {
    run("reg", &["add", key, "/v", name, "/t", kind, "/d", data, "/f"])
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
    run("powershell", &["-NoProfile", "-NonInteractive", "-Command", script])
}

const MMCSS_GAMES: &str =
    r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games";
const MMCSS_PROFILE: &str = r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile";
const POWER_BALANCED: &str = "381b4222-f694-41f0-9685-ff5bb260df2e";
const POWER_ULTIMATE: &str = "e9a42b02-d5df-448d-aa00-03f14749eb61";

// --- apply / revert dispatch ---------------------------------------------------

/// Apply the tweak with the given id. Modifies the live system.
#[tauri::command]
pub fn tweak_apply(id: String) -> CoreResult<()> {
    match id.as_str() {
        // ---- SAFE ----
        "mmcss_gaming" => {
            reg_add(MMCSS_PROFILE, "SystemResponsiveness", "REG_DWORD", "10")?;
            reg_add(MMCSS_GAMES, "GPU Priority", "REG_DWORD", "8")?;
            reg_add(MMCSS_GAMES, "Priority", "REG_DWORD", "6")?;
            reg_add(MMCSS_GAMES, "Scheduling Category", "REG_SZ", "High")?;
            reg_add(MMCSS_GAMES, "SFIO Priority", "REG_SZ", "High")?;
            Ok(())
        }
        "network_throttling_off" => {
            reg_add(MMCSS_PROFILE, "NetworkThrottlingIndex", "REG_DWORD", "4294967295")
        }
        "foreground_boost" => reg_add(
            r"HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl",
            "Win32PrioritySeparation",
            "REG_DWORD",
            "38", // 0x26 — favour the foreground app
        ),
        "menu_delay_0" => reg_add(r"HKCU\Control Panel\Desktop", "MenuShowDelay", "REG_SZ", "0"),
        "ntfs_lastaccess_off" => run("fsutil", &["behavior", "set", "disablelastaccess", "1"]),
        "telemetry_off" => {
            run_soft("sc", &["stop", "DiagTrack"]);
            sc_config("DiagTrack", "disabled")?;
            run_soft("sc", &["stop", "dmwappushservice"]);
            sc_config("dmwappushservice", "disabled")?;
            Ok(())
        }
        "ultimate_power_plan" => {
            // Duplicate may already exist; that's fine — just activate it.
            run_soft("powercfg", &["-duplicatescheme", POWER_ULTIMATE]);
            powercfg(&["-setactive", POWER_ULTIMATE])
        }
        "game_dvr_off" => {
            reg_add(r"HKCU\System\GameConfigStore", "GameDVR_Enabled", "REG_DWORD", "0")?;
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
    }
}

/// Revert the tweak to Windows' documented default.
#[tauri::command]
pub fn tweak_revert(id: String) -> CoreResult<()> {
    match id.as_str() {
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
        "menu_delay_0" => reg_add(r"HKCU\Control Panel\Desktop", "MenuShowDelay", "REG_SZ", "400"),
        "ntfs_lastaccess_off" => run("fsutil", &["behavior", "set", "disablelastaccess", "2"]),
        "telemetry_off" => {
            sc_config("DiagTrack", "auto")?;
            run_soft("sc", &["start", "DiagTrack"]);
            sc_config("dmwappushservice", "demand")?;
            Ok(())
        }
        "ultimate_power_plan" => powercfg(&["-setactive", POWER_BALANCED]),
        "game_dvr_off" => {
            reg_add(r"HKCU\System\GameConfigStore", "GameDVR_Enabled", "REG_DWORD", "1")?;
            reg_del(r"HKLM\SOFTWARE\Policies\Microsoft\Windows\GameDVR", "AllowGameDVR");
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
            reg_del(r"HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU", "NoAutoUpdate");
            Ok(())
        }

        other => Err(CoreError::Msg(format!("未知的优化项: {other}"))),
    }
}

/// Create a System Restore point before the user applies tweaks. Windows
/// rate-limits these to one per ~24h by default; a rate-limited call is reported
/// as a (non-fatal) message the UI can surface.
#[tauri::command]
pub fn create_restore_point() -> CoreResult<()> {
    // Ensure protection is on for C: then checkpoint.
    run_soft("powershell", &[
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Enable-ComputerRestore -Drive 'C:\\'",
    ]);
    ps("Checkpoint-Computer -Description 'CorePilot 优化前' -RestorePointType MODIFY_SETTINGS")
}
