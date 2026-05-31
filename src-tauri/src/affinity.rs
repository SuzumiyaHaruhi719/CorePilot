//! Process CPU affinity + priority control via Win32.

use crate::error::CoreResult;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    GetProcessAffinityMask, OpenProcess, SetPriorityClass, SetProcessAffinityMask,
    PROCESS_CREATION_FLAGS, PROCESS_QUERY_INFORMATION, PROCESS_SET_INFORMATION,
};

/// Pin a process to the given logical-CPU mask (group 0).
pub fn set_affinity(pid: u32, mask: u64) -> CoreResult<()> {
    unsafe {
        let handle = OpenProcess(
            PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION,
            false.into(),
            pid,
        )?;
        let result = SetProcessAffinityMask(handle, mask as usize);
        let _ = CloseHandle(handle);
        result?;
    }
    Ok(())
}

/// Returns (process affinity mask, system affinity mask).
pub fn get_affinity(pid: u32) -> CoreResult<(u64, u64)> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION, false.into(), pid)?;
        let mut process_mask: usize = 0;
        let mut system_mask: usize = 0;
        let result = GetProcessAffinityMask(handle, &mut process_mask, &mut system_mask);
        let _ = CloseHandle(handle);
        result?;
        Ok((process_mask as u64, system_mask as u64))
    }
}

/// Set a Windows priority class (e.g. 0x80 = HIGH, 0x4000 = BELOW_NORMAL).
pub fn set_priority(pid: u32, class: u32) -> CoreResult<()> {
    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, false.into(), pid)?;
        let result = SetPriorityClass(handle, PROCESS_CREATION_FLAGS(class));
        let _ = CloseHandle(handle);
        result?;
    }
    Ok(())
}
