//! System optimization actions. Memory ops use the documented
//! NtSetSystemInformation memory-list commands (like RAMMap / ISLC).

use crate::error::{CoreError, CoreResult};
use serde::Serialize;
use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::Path;
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

fn clean_dir(path: &Path, acc: &mut CleanResult) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            clean_dir(&p, acc);
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

/// Best-effort cleanup of user + Windows temp directories (skips locked files).
pub fn clean_temp() -> CleanResult {
    let mut acc = CleanResult { bytes: 0, files: 0 };
    if let Ok(temp) = std::env::var("TEMP") {
        clean_dir(Path::new(&temp), &mut acc);
    }
    if let Ok(windir) = std::env::var("WINDIR") {
        clean_dir(&Path::new(&windir).join("Temp"), &mut acc);
    }
    acc
}

pub fn flush_dns() -> CoreResult<()> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
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
