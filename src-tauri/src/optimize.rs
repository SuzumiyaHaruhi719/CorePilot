//! System optimization actions. Memory ops use the documented
//! NtSetSystemInformation memory-list commands (like RAMMap / ISLC).

use crate::error::{CoreError, CoreResult};
use serde::Serialize;
use std::ffi::c_void;
use std::os::windows::fs::MetadataExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

#[link(name = "ntdll")]
extern "system" {
    fn NtSetSystemInformation(info_class: i32, info: *mut c_void, len: u32) -> i32;
}

const SYSTEM_MEMORY_LIST_INFORMATION: i32 = 80;
const MEMORY_EMPTY_WORKING_SETS: u32 = 2;
const MEMORY_PURGE_STANDBY_LIST: u32 = 4;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemDetail {
    pub total: u64,
    pub avail: u64,
    pub used: u64,
    pub load_pct: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    pub bytes: u64,
    pub files: u32,
}

fn enable_privilege(name: &str) -> CoreResult<()> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )?;
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut luid = LUID::default();
        let lookup = LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(wide.as_ptr()), &mut luid);
        if let Err(e) = lookup {
            let _ = CloseHandle(token);
            return Err(e.into());
        }
        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        let result = AdjustTokenPrivileges(token, false, Some(&privileges), 0, None, None);
        let _ = CloseHandle(token);
        result?;
    }
    Ok(())
}

fn memory_command(command: u32) -> CoreResult<()> {
    enable_privilege("SeProfileSingleProcessPrivilege")?;
    unsafe {
        let mut cmd = command;
        let status = NtSetSystemInformation(
            SYSTEM_MEMORY_LIST_INFORMATION,
            &mut cmd as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        );
        if status != 0 {
            return Err(CoreError::Msg(format!(
                "NtSetSystemInformation failed: 0x{:08X}",
                status
            )));
        }
    }
    Ok(())
}

/// Empty the working sets of all processes (trim resident memory).
pub fn free_working_sets() -> CoreResult<()> {
    memory_command(MEMORY_EMPTY_WORKING_SETS)
}

/// Purge the standby list (cached memory) — frees "cached" RAM.
pub fn purge_standby() -> CoreResult<()> {
    memory_command(MEMORY_PURGE_STANDBY_LIST)
}

pub fn memory_detail() -> CoreResult<MemDetail> {
    unsafe {
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..std::mem::zeroed()
        };
        GlobalMemoryStatusEx(&mut status)?;
        Ok(MemDetail {
            total: status.ullTotalPhys,
            avail: status.ullAvailPhys,
            used: status.ullTotalPhys.saturating_sub(status.ullAvailPhys),
            load_pct: status.dwMemoryLoad,
        })
    }
}

/// Windows file attribute marking a reparse point (junction, symlink, mount
/// point, …). We never follow one of these during cleanup: a directory junction
/// inside the temp tree could otherwise redirect the recursive delete out into
/// arbitrary parts of the filesystem, which — running elevated — would be a way
/// to wipe protected files. `std::fs` resolves `is_symlink()` for name-surrogate
/// reparse points, but we also test the raw attribute bit so non-surrogate
/// reparse points (e.g. some mount points) are caught too.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// True if the symlink-level metadata describes a reparse point or symlink — i.e.
/// something we must NOT descend into or treat as a plain directory/file.
fn is_reparse_or_symlink(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink() || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

/// True if `path`, once canonicalized, still lives under `root` (also canonical).
/// Used as the final gate before any deletion so we can never remove something
/// that resolves outside the temp tree, even if an earlier check was bypassed.
fn stays_under(root: &Path, path: &Path) -> bool {
    match std::fs::canonicalize(path) {
        Ok(real) => real.starts_with(root),
        // If it can't be canonicalized (e.g. it vanished) treat it as out-of-tree
        // and skip it — deletion is best-effort, so skipping is always safe.
        Err(_) => false,
    }
}

/// Recursively delete the contents of `dir`, staying strictly inside `root`
/// (which must already be canonical). Symlink-aware: reparse points / symlinked
/// directories are skipped wholesale (never followed), and every entry's
/// canonical path is verified to remain under `root` before it is removed.
fn clean_dir(root: &Path, dir: &Path, acc: &mut CleanResult) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        // symlink_metadata does NOT traverse the link, so a junction/symlink is
        // reported as itself rather than its target.
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };

        if is_reparse_or_symlink(&meta) {
            // A reparse point could point anywhere. Remove the LINK itself if and
            // only if the link node lives under root (its own path is inside the
            // temp tree), but never recurse through it. Use the directory/file
            // remover that matches the link's surface type without following it.
            if p.parent().map(|parent| stays_under(root, parent)).unwrap_or(false) {
                if meta.file_type().is_dir() {
                    // Removes the junction/dir-symlink node, not its target tree.
                    let _ = std::fs::remove_dir(&p);
                } else {
                    let _ = std::fs::remove_file(&p);
                }
            }
            continue;
        }

        if meta.is_dir() {
            // Real directory: descend, then try to remove the now-empty dir — but
            // only if it canonicalizes back under root.
            clean_dir(root, &p, acc);
            if stays_under(root, &p) {
                let _ = std::fs::remove_dir(&p);
            }
        } else {
            // Real file: delete only if its canonical path is still under root.
            if !stays_under(root, &p) {
                continue;
            }
            let len = meta.len();
            if std::fs::remove_file(&p).is_ok() {
                acc.bytes = acc.bytes.saturating_add(len);
                acc.files += 1;
            }
        }
    }
}

/// Canonicalize a temp root, returning None if it doesn't exist / can't be
/// resolved (nothing to clean) or if it is itself a reparse point (we refuse to
/// treat a redirected temp dir as a safe deletion root).
fn canonical_temp_root(path: &Path) -> Option<PathBuf> {
    // Reject a temp root that is itself a symlink/junction before resolving it.
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if is_reparse_or_symlink(&meta) {
            return None;
        }
    }
    let real = std::fs::canonicalize(path).ok()?;
    real.is_dir().then_some(real)
}

/// Best-effort cleanup of user + Windows temp directories (skips locked files).
///
/// The temp root is taken from [`std::env::temp_dir`] (not a raw, attacker-
/// controllable `%TEMP%` read in the delete path) and canonicalized up front;
/// the walker then refuses to follow any reparse point and verifies every
/// deletion target still resolves under that canonical root. Running elevated,
/// this prevents a hostile env var or an in-tree junction from steering the
/// recursive delete onto arbitrary files.
pub fn clean_temp() -> CleanResult {
    let mut acc = CleanResult { bytes: 0, files: 0 };

    // User temp: resolved by std (honours TMP/TEMP but yields a real path we then
    // canonicalize), so we operate on the actual directory, not an unverified
    // string.
    if let Some(root) = canonical_temp_root(&std::env::temp_dir()) {
        clean_dir(&root, &root, &mut acc);
    }

    // Windows\Temp: derive from the system root rather than %WINDIR% where
    // possible, then canonicalize the same way.
    let windir = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .map(PathBuf::from);
    if let Some(windir) = windir {
        if let Some(root) = canonical_temp_root(&windir.join("Temp")) {
            clean_dir(&root, &root, &mut acc);
        }
    }

    acc
}

pub fn flush_dns() -> CoreResult<()> {
    let status = std::process::Command::new("ipconfig")
        .arg("/flushdns")
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| CoreError::Msg(e.to_string()))?;
    if !status.success() {
        return Err(CoreError::Msg("ipconfig /flushdns failed".into()));
    }
    Ok(())
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PLAN_BALANCED: &str = "381b4222-f694-41f0-9685-ff5bb260df2e";
const PLAN_HIGH: &str = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";

fn run_powercfg(args: &[&str]) -> CoreResult<()> {
    let status = std::process::Command::new("powercfg")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| CoreError::Msg(e.to_string()))?;
    if !status.success() {
        return Err(CoreError::Msg("powercfg failed".into()));
    }
    Ok(())
}

/// Switch the active Windows power plan ("balanced" | "high").
pub fn set_power_plan(plan: &str) -> CoreResult<()> {
    let guid = match plan {
        "balanced" => PLAN_BALANCED,
        "high" => PLAN_HIGH,
        _ => return Err(CoreError::Msg(format!("unknown power plan: {plan}"))),
    };
    run_powercfg(&["/setactive", guid])
}

pub fn get_power_plan() -> CoreResult<String> {
    let output = std::process::Command::new("powercfg")
        .args(["/getactivescheme"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| CoreError::Msg(e.to_string()))?;
    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    let name = if text.contains(PLAN_HIGH) {
        "high"
    } else if text.contains(PLAN_BALANCED) {
        "balanced"
    } else {
        "other"
    };
    Ok(name.to_string())
}
