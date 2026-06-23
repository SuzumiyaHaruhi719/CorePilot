//! Disk Space Analyzer — backend scan engine.
//!
//! See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md.
//!
//! PHASE 0 (Skeleton & nav) implements ONLY the volume enumeration command
//! (`disk_list_volumes`) backing the disk-picker landing (Zone A). The scan
//! registry, `ScanHandle`, the `FindFirstFileExW` walk, the arena tree, and the
//! `disk-scan://progress` event arrive in Phase 1+. The `ScanId` type alias and
//! the module skeleton are introduced here so later phases extend, not rewrite.
//!
//! CRITICAL-PATH INVARIANT (see lib.rs): every Tauri command stays O(1) and never
//! blocks the main thread. `disk_list_volumes` does a handful of cheap Win32 calls
//! but is routed through `spawn_blocking` anyway (a slow/disconnected removable or
//! network volume can stall `GetVolumeInformationW`), so the IPC router never stalls.

use crate::error::CoreResult;
use serde::Serialize;

/// Stable per-disk key. The volume GUID path (`\\?\Volume{guid}\`) where
/// available, falling back to the drive-letter root (`C:\`). Phase 1+ keys the
/// `SCANS` registry by this; the UI displays the friendly letter+label.
pub type ScanId = String;

/// One fixed/removable volume surfaced in the disk picker (Zone A).
///
/// `total`/`free` are bytes; `used = total - free`. `supported` is false for
/// volumes we can list but not (yet) scan (locked BitLocker, no free-space info)
/// so the picker can grey them out. Serialized camelCase for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    /// Stable scan key — volume GUID path when resolvable, else the drive root.
    pub scan_id: ScanId,
    /// Friendly display root, e.g. "C:\\".
    pub root: String,
    /// Drive letter without the trailing separator, e.g. "C:".
    pub letter: String,
    /// Volume label (may be empty).
    pub label: String,
    /// File system, e.g. "NTFS" / "exFAT" (may be empty when unavailable).
    pub file_system: String,
    /// Win32 drive type: "fixed" | "removable" | "remote" | "cdrom" | "ramdisk" | "unknown".
    pub drive_type: String,
    /// Total size in bytes (0 when unavailable).
    pub total: u64,
    /// Free bytes available to the caller (0 when unavailable).
    pub free: u64,
    /// True when this volume can be scanned (has size info and is a real fixed/removable disk).
    pub supported: bool,
}

#[cfg(target_os = "windows")]
mod win {
    use super::VolumeInfo;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
        GetVolumeNameForVolumeMountPointW,
    };

    // Win32 DRIVE_* return codes from GetDriveTypeW (winbase.h). The windows crate
    // returns a plain u32 and doesn't export the named constants in this version, so
    // we match the documented numeric values directly.
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;

    /// UTF-16, NUL-terminated copy of `s`, suitable for `PCWSTR(v.as_ptr())`.
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Lossy `String` from a NUL-terminated wide buffer.
    fn from_wide_nul(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    fn drive_type_str(root_w: &[u16]) -> &'static str {
        // SAFETY: `root_w` is a valid NUL-terminated wide string.
        match unsafe { GetDriveTypeW(PCWSTR(root_w.as_ptr())) } {
            DRIVE_FIXED => "fixed",
            DRIVE_REMOVABLE => "removable",
            DRIVE_REMOTE => "remote",
            DRIVE_CDROM => "cdrom",
            DRIVE_RAMDISK => "ramdisk",
            _ => "unknown",
        }
    }

    /// Resolve the stable volume-GUID path for a drive root (`C:\`). Falls back to
    /// the root itself when the mount point can't be resolved (e.g. a network share
    /// or an empty removable bay).
    fn volume_guid_path(root_w: &[u16]) -> Option<String> {
        let mut buf = [0u16; 64]; // "\\?\Volume{GUID}\" is 49 wide chars + NUL.
        // SAFETY: `root_w` is NUL-terminated; `buf` is sized for the documented output.
        let ok = unsafe { GetVolumeNameForVolumeMountPointW(PCWSTR(root_w.as_ptr()), &mut buf) };
        if ok.is_ok() {
            let s = from_wide_nul(&buf);
            if !s.is_empty() {
                return Some(s);
            }
        }
        None
    }

    /// Read label + filesystem for a drive root. Returns ("", "") when unavailable
    /// (locked / disconnected volume) — the caller then marks the volume unsupported.
    fn volume_information(root_w: &[u16]) -> (String, String) {
        let mut label = [0u16; 256];
        let mut fs = [0u16; 256];
        // SAFETY: all pointers reference live, correctly-sized stack buffers; the
        // unused out-params (serial/flags/max-component) are passed as None.
        let ok = unsafe {
            GetVolumeInformationW(
                PCWSTR(root_w.as_ptr()),
                Some(&mut label),
                None,
                None,
                None,
                Some(&mut fs),
            )
        };
        if ok.is_ok() {
            (from_wide_nul(&label), from_wide_nul(&fs))
        } else {
            (String::new(), String::new())
        }
    }

    /// (total, free-available) bytes for a drive root, or (0, 0) when the volume
    /// can't report sizes (no media, locked, disconnected).
    fn disk_space(root_w: &[u16]) -> (u64, u64) {
        let mut free_avail = 0u64;
        let mut total = 0u64;
        // SAFETY: out-params point at live u64s; `root_w` is NUL-terminated.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(root_w.as_ptr()),
                Some(&mut free_avail),
                Some(&mut total),
                None,
            )
        };
        if ok.is_ok() {
            (total, free_avail)
        } else {
            (0, 0)
        }
    }

    /// Enumerate the machine's logical drives (A:..Z:) and describe each as a
    /// `VolumeInfo`. Cheap Win32 calls; called from a `spawn_blocking` task so a
    /// slow removable/network probe never stalls the IPC router.
    pub fn list_volumes() -> Vec<VolumeInfo> {
        // SAFETY: no arguments; returns a bitmask of present logical drives.
        let mask = unsafe { GetLogicalDrives() };
        let mut out = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter_char = (b'A' + i as u8) as char;
            let root = format!("{letter_char}:\\");
            let letter = format!("{letter_char}:");
            let root_w = wide(&root);

            let drive_type = drive_type_str(&root_w);
            // v1 picker lists fixed + removable disks only; network/optical/RAM
            // drives are out of scope (network deep support is a non-goal).
            if drive_type != "fixed" && drive_type != "removable" {
                continue;
            }

            let (label, file_system) = volume_information(&root_w);
            let (total, free) = disk_space(&root_w);
            let scan_id = volume_guid_path(&root_w).unwrap_or_else(|| root.clone());
            // Scannable only when we got real size info AND a filesystem (a locked
            // BitLocker volume or an empty removable bay reports neither).
            let supported = total > 0 && !file_system.is_empty();

            out.push(VolumeInfo {
                scan_id,
                root,
                letter,
                label,
                file_system,
                drive_type: drive_type.to_string(),
                total,
                free,
                supported,
            });
        }
        out
    }
}

#[cfg(not(target_os = "windows"))]
mod win {
    use super::VolumeInfo;
    pub fn list_volumes() -> Vec<VolumeInfo> {
        Vec::new()
    }
}

/// Enumerate fixed + removable volumes for the disk-picker landing (Zone A).
///
/// O(1) from the IPC router's perspective: the Win32 enumeration runs on the
/// blocking pool so a slow/disconnected volume can never stall the main thread.
#[tauri::command]
pub async fn disk_list_volumes() -> CoreResult<Vec<VolumeInfo>> {
    tauri::async_runtime::spawn_blocking(win::list_volumes)
        .await
        .map_err(|e| crate::error::CoreError::Msg(format!("task failed: {e}")))
}
