//! Process CPU affinity + priority control via Win32.

use crate::error::{CoreError, CoreResult};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    GetProcessAffinityMask, OpenProcess, SetPriorityClass, SetProcessAffinityMask,
    PROCESS_CREATION_FLAGS, PROCESS_QUERY_INFORMATION, PROCESS_SET_INFORMATION,
    REALTIME_PRIORITY_CLASS,
};

/// Pin a process to the given logical-CPU mask (group 0).
///
/// The mask is validated against the process's *system* affinity mask
/// (`GetProcessAffinityMask`): it must be non-zero and a subset of the CPUs the
/// process is actually allowed to run on. A zero mask is rejected by Windows
/// anyway, and a superset silently includes CPUs that don't exist for the
/// process — both are refused here with a clear error instead.
pub fn set_affinity(pid: u32, mask: u64) -> CoreResult<()> {
    // Defense in depth: refuse critical/system PIDs here too, so every caller
    // (IPC command surface and the CLI binary alike) is gated, not just the
    // ones that remember to call the guard first.
    crate::process::guard_critical_pid(pid)?;
    unsafe {
        let handle = OpenProcess(
            PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION,
            false.into(),
            pid,
        )?;

        // Read the system affinity mask so we can validate the request against
        // the CPUs this process may actually use.
        let mut proc_mask: usize = 0;
        let mut sys_mask: usize = 0;
        if let Err(e) = GetProcessAffinityMask(handle, &mut proc_mask, &mut sys_mask) {
            let _ = CloseHandle(handle);
            return Err(CoreError::from(e));
        }
        let sys_mask = sys_mask as u64;

        if mask == 0 {
            let _ = CloseHandle(handle);
            return Err(CoreError::Msg("亲和性掩码不能为空".into()));
        }
        if mask & !sys_mask != 0 {
            let _ = CloseHandle(handle);
            return Err(CoreError::Msg(format!(
                "亲和性掩码超出该进程可用的逻辑处理器范围 (系统掩码: {sys_mask:#x})"
            )));
        }

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

/// HIGH_PRIORITY_CLASS — the safe ceiling we map a REALTIME request down to.
const HIGH_PRIORITY_CLASS: u32 = 0x0000_0080;

/// Set a Windows priority class (e.g. 0x80 = HIGH, 0x4000 = BELOW_NORMAL).
///
/// REALTIME (0x100) is never honored: at real-time priority a busy process can
/// starve kernel threads (input, disk, networking) and hang the whole machine.
/// A real-time request is transparently clamped down to HIGH instead.
pub fn set_priority(pid: u32, class: u32) -> CoreResult<()> {
    // Defense in depth: gate critical/system PIDs at the function boundary so
    // both the IPC command and the CLI binary are protected.
    crate::process::guard_critical_pid(pid)?;
    let class = if class == REALTIME_PRIORITY_CLASS.0 {
        HIGH_PRIORITY_CLASS
    } else {
        class
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, false.into(), pid)?;
        let result = SetPriorityClass(handle, PROCESS_CREATION_FLAGS(class));
        let _ = CloseHandle(handle);
        result?;
    }
    Ok(())
}
