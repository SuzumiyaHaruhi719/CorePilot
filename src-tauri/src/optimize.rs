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

pub fn enable_privilege(name: &str) -> CoreResult<()> {
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
const FILE_ATTRIBUTE_DIRECTORY_BIT: u32 = 0x10;

/// True if the symlink-level metadata describes a reparse point or symlink — i.e.
/// something we must NOT descend into or treat as a plain directory/file.
fn is_reparse_or_symlink(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink() || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

/// An open handle on a directory that has been verified NOT to be a reparse
/// point. Opened without `FILE_SHARE_DELETE`, so while it lives nobody can
/// rename or delete that directory — and Windows also refuses to rename any
/// ancestor of a directory with open handles in its subtree. That pins the
/// whole path from the volume root down to here, which is what makes the
/// path-based deletes below race-free: a check-then-delete by path let a
/// standard user swap a directory under the temp root for a junction between
/// the check and the delete, steering this ELEVATED process into System32.
struct PinnedDir(HANDLE);

impl Drop for PinnedDir {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Open and pin `path` as a directory. `None` if it can't be opened or the
/// object actually opened is a reparse point (never followed: the open itself
/// uses `FILE_FLAG_OPEN_REPARSE_POINT`, so it lands on the link, not its target).
fn pin_dir(path: &Path) -> Option<PinnedDir> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_LIST_DIRECTORY, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let handle = CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_LIST_DIRECTORY.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .ok()?;
        let pin = PinnedDir(handle);
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        GetFileInformationByHandle(pin.0, &mut info).ok()?;
        let attrs = info.dwFileAttributes;
        (attrs & FILE_ATTRIBUTE_REPARSE_POINT == 0 && attrs & FILE_ATTRIBUTE_DIRECTORY.0 != 0)
            .then_some(pin)
    }
}

/// The path the pinned handle really refers to (`\\?\C:\…`, as `canonicalize`
/// returns), for checking the root we pinned is the root we resolved.
fn pinned_path(pin: &PinnedDir) -> Option<PathBuf> {
    use windows::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};
    let mut buf = vec![0u16; 1024];
    let len = unsafe { GetFinalPathNameByHandleW(pin.0, &mut buf, FILE_NAME_NORMALIZED) } as usize;
    (len > 0 && len < buf.len()).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}

/// Recursively delete the contents of `dir` while it is pinned (see
/// [`PinnedDir`]). Reparse points are removed as links and never descended
/// into; real subdirectories are pinned in turn before their contents go.
fn clean_dir(dir: &Path, acc: &mut CleanResult) {
    let Some(_pin) = pin_dir(dir) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        // symlink_metadata does NOT traverse the link, so a junction/symlink is
        // reported as itself rather than its target.
        let Ok(meta) = std::fs::symlink_metadata(&p) else {
            continue;
        };
        if is_reparse_or_symlink(&meta) {
            // Removes the link node itself (DeleteFile / RemoveDirectory act on a
            // final-component reparse point, not its target). Junctions report
            // `is_symlink`, not `is_dir`, so pick the remover by the attribute.
            if meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY_BIT != 0 {
                let _ = std::fs::remove_dir(&p);
            } else {
                let _ = std::fs::remove_file(&p);
            }
            continue;
        }
        if meta.is_dir() {
            clean_dir(&p, acc);
            // The child's pin is released by now; if it was swapped for a
            // junction in this instant, RemoveDirectory removes only the link.
            let _ = std::fs::remove_dir(&p);
        } else {
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

/// Clean one temp root: resolve it, pin it, and confirm the pinned object is
/// the directory we resolved (an ancestor could have been swapped between the
/// canonicalize and the open) before deleting anything under it.
fn clean_root(path: &Path, acc: &mut CleanResult) {
    let Some(root) = canonical_temp_root(path) else {
        return;
    };
    let Some(pin) = pin_dir(&root) else {
        return;
    };
    let same = pinned_path(&pin).is_some_and(|real| {
        real.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&root.as_os_str().to_string_lossy())
    });
    if same {
        clean_dir(&root, acc);
    }
}

/// Best-effort cleanup of user + Windows temp directories (skips locked files).
///
/// The temp root is taken from [`std::env::temp_dir`] (not a raw, attacker-
/// controllable `%TEMP%` read in the delete path), canonicalized, and pinned;
/// the walker pins every directory it descends into and never follows a
/// reparse point. Running elevated, this prevents a hostile env var or an
/// in-tree junction — including one swapped in mid-walk — from steering the
/// recursive delete onto arbitrary files.
pub fn clean_temp() -> CleanResult {
    let mut acc = CleanResult { bytes: 0, files: 0 };

    // User temp: resolved by std (honours TMP/TEMP but yields a real path we then
    // canonicalize), so we operate on the actual directory, not an unverified
    // string.
    clean_root(&std::env::temp_dir(), &mut acc);

    // Windows\Temp: derive from the system root rather than %WINDIR% where
    // possible, then canonicalize the same way.
    let windir = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .map(PathBuf::from);
    if let Some(windir) = windir {
        clean_root(&windir.join("Temp"), &mut acc);
    }

    acc
}

pub fn flush_dns() -> CoreResult<()> {
    let status = std::process::Command::new(crate::commands::system_tool("ipconfig"))
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
    let status = std::process::Command::new(crate::commands::system_tool("powercfg"))
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
    let output = std::process::Command::new(crate::commands::system_tool("powercfg"))
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

#[cfg(test)]
mod clean_tests {
    use super::*;

    /// The guarantee: a junction inside the tree is removed as a link and the
    /// directory it points at is left untouched; real files and dirs go.
    #[test]
    fn junctions_are_unlinked_never_followed() {
        let base = std::env::temp_dir().join(format!("cp-clean-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("a.tmp"), b"1234").unwrap();
        std::fs::write(root.join("sub").join("b.tmp"), b"56").unwrap();
        std::fs::write(outside.join("keep.txt"), b"precious").unwrap();
        let junction = root.join("link");
        let made = std::process::Command::new(crate::commands::system_tool("cmd"))
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(made, "mklink /J failed");

        let mut acc = CleanResult { bytes: 0, files: 0 };
        clean_root(&root, &mut acc);

        assert_eq!(acc.files, 2);
        assert_eq!(acc.bytes, 6);
        assert!(!junction.exists(), "junction should be unlinked");
        assert!(!root.join("sub").exists());
        assert_eq!(
            std::fs::read(outside.join("keep.txt")).unwrap(),
            b"precious"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_root_that_is_a_junction_is_refused() {
        let base = std::env::temp_dir().join(format!("cp-clean-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let target = base.join("target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep.txt"), b"x").unwrap();
        let link = base.join("rootlink");
        let made = std::process::Command::new(crate::commands::system_tool("cmd"))
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(made, "mklink /J failed");

        let mut acc = CleanResult { bytes: 0, files: 0 };
        clean_root(&link, &mut acc);
        assert_eq!(acc.files, 0);
        assert!(target.join("keep.txt").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
