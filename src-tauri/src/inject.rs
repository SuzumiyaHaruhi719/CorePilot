//! Minimal, dependency-free DLL injector (Win32 `LoadLibraryW` technique).
//!
//! We deliberately hand-roll injection on the `windows` crate the project already
//! uses instead of pulling in a third-party injector. The obvious choice,
//! `dll-syringe`, cannot build on this project's **stable** toolchain: every 0.15+
//! release relies on nightly-only `MaybeUninit` slice APIs (and 0.16+ add a
//! crate-root `#![feature(...)]`), which fails `cargo build` on stable. Rather
//! than fork it, we implement the exact mechanism it wraps — the classic, robust
//! `CreateRemoteThread(LoadLibraryW)` injection — in ~120 lines we fully control.
//!
//! Technique (inject):
//!   0. If the module is already loaded in the target (ToolHelp snapshot), return
//!      early — injection is idempotent and never bumps the load count twice.
//!   1. `OpenProcess` with create-thread + VM rights.
//!   2. `VirtualAllocEx` a buffer for the DLL path (UTF-16, NUL-terminated).
//!   3. `WriteProcessMemory` the path into it.
//!   4. `CreateRemoteThread` whose start address is `LoadLibraryW`, arg = the
//!      remote path. `kernel32.dll` loads at the same base in every process of a
//!      given boot (ASLR is per-boot, system-wide for known DLLs), so the local
//!      `LoadLibraryW` address is valid in the target.
//!   5. Wait for the thread; a non-zero exit code = the `HMODULE` loaded OK.
//!
//! Eject mirrors it: find the overlay module's remote base via a ToolHelp module
//! snapshot, then `CreateRemoteThread(FreeLibrary, base)`.
//!
//! Every call is best-effort and returns a `Result<_, String>` with a localised
//! message; nothing here panics.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::s;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE, WAIT_OBJECT_0};
use windows::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    TH32CS_SNAPMODULE32,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
};
use windows::Win32::System::Threading::{
    CreateRemoteThread, GetExitCodeThread, OpenProcess, WaitForSingleObject,
    LPTHREAD_START_ROUTINE, PROCESS_CREATE_THREAD, PROCESS_QUERY_INFORMATION,
    PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE,
};

/// How long to wait for the remote LoadLibrary/FreeLibrary thread before giving
/// up (ms). 10s is generous — LoadLibrary of an already-on-disk DLL is fast; a
/// hang here means the target is wedged, and we must not block our caller forever.
const REMOTE_THREAD_TIMEOUT_MS: u32 = 10_000;

/// RAII process handle (always closed).
struct ProcHandle(HANDLE);
impl Drop for ProcHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// RAII thread handle (always closed).
struct ThreadHandle(HANDLE);
impl Drop for ThreadHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Open `pid` with the rights needed to inject (create a remote thread + write a
/// path into its address space).
fn open_for_inject(pid: u32) -> Result<ProcHandle, String> {
    let access = PROCESS_CREATE_THREAD
        | PROCESS_QUERY_INFORMATION
        | PROCESS_VM_OPERATION
        | PROCESS_VM_WRITE
        | PROCESS_VM_READ;
    // SAFETY: standard OpenProcess; we own and close the returned handle.
    let handle = unsafe { OpenProcess(access, false, pid) }
        .map_err(|e| format!("无法打开目标进程 (pid {pid}): {e}"))?;
    Ok(ProcHandle(handle))
}

/// Resolve a `kernel32.dll` export's address as an `LPTHREAD_START_ROUTINE`. Both
/// `LoadLibraryW` and `FreeLibrary` have a compatible single-pointer-arg ABI, so
/// they can be used directly as a remote thread start routine. The address is the
/// same in the target process (shared kernel32 base for the boot session).
fn kernel32_proc(name: windows::core::PCSTR) -> Result<LPTHREAD_START_ROUTINE, String> {
    // SAFETY: kernel32 is always loaded; we only read the returned function ptr.
    unsafe {
        let kernel32 =
            GetModuleHandleW(windows::core::w!("kernel32.dll")).map_err(|e| e.to_string())?;
        let proc = GetProcAddress(kernel32, name)
            .ok_or_else(|| "无法解析 kernel32 导出函数".to_string())?;
        // Transmute the FARPROC into the thread-start routine shape.
        Ok(Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            unsafe extern "system" fn(*mut c_void) -> u32,
        >(proc)))
    }
}

/// Run a remote thread `start(arg)` in `proc` and wait for it, returning its
/// 32-bit exit code. Used for both LoadLibrary (returns the HMODULE low bits) and
/// FreeLibrary (returns BOOL).
fn run_remote_thread(
    proc: &ProcHandle,
    start: LPTHREAD_START_ROUTINE,
    arg: *const c_void,
) -> Result<u32, String> {
    unsafe {
        let thread = CreateRemoteThread(
            proc.0,
            None,
            0,
            start,
            Some(arg),
            0,
            None,
        )
        .map_err(|e| format!("无法在目标进程创建远程线程: {e}"))?;
        let thread = ThreadHandle(thread);

        // Wait (bounded) for the loader to finish.
        let wait = WaitForSingleObject(thread.0, REMOTE_THREAD_TIMEOUT_MS);
        if wait != WAIT_OBJECT_0 {
            return Err("远程线程超时（目标进程无响应）".to_string());
        }
        let mut code: u32 = 0;
        GetExitCodeThread(thread.0, &mut code).map_err(|e| e.to_string())?;
        Ok(code)
    }
}

/// Inject `dll_path` into `pid` via `LoadLibraryW`. Returns `Ok(())` on success.
///
/// # Safety / correctness
/// The remote memory holding the path is freed before returning. A zero
/// LoadLibrary exit code (the truncated HMODULE) means the load failed in the
/// target — surfaced as an error.
pub fn inject(pid: u32, dll_path: &Path) -> Result<(), String> {
    let proc = open_for_inject(pid)?;

    // IDEMPOTENCY GUARD (defense in depth): if our overlay module is already
    // loaded in the target, do not LoadLibraryW it again. Re-injecting would bump
    // the module's load count and leave it resident across a single detach, which
    // is the DLL leak this fixes. The caller (`overlay_inject`) already tracks the
    // injected PID, but guarding here keeps the mechanism itself non-accumulating
    // even if it is ever driven from another path. Match on the DLL's file name.
    if let Some(file_name) = dll_path.file_name().and_then(|n| n.to_str()) {
        if find_remote_module(pid, file_name).is_some() {
            return Ok(());
        }
    }

    // Encode the absolute path as a NUL-terminated wide string and size the
    // remote buffer in BYTES.
    let wide: Vec<u16> = dll_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let bytes = wide.len() * std::mem::size_of::<u16>();

    unsafe {
        // Reserve+commit RW memory in the target for the path string.
        let remote = VirtualAllocEx(
            proc.0,
            None,
            bytes,
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        );
        if remote.is_null() {
            return Err("目标进程内存分配失败 (VirtualAllocEx)".to_string());
        }
        // Ensure the allocation is released on every exit path below.
        let remote_guard = RemoteAlloc { proc: proc.0, addr: remote };

        // Write the path.
        let mut written = 0usize;
        WriteProcessMemory(
            proc.0,
            remote,
            wide.as_ptr() as *const c_void,
            bytes,
            Some(&mut written),
        )
        .map_err(|e| format!("写入目标进程内存失败: {e}"))?;
        if written != bytes {
            return Err("写入目标进程内存不完整".to_string());
        }

        // CreateRemoteThread(LoadLibraryW, remote_path).
        let load_library = kernel32_proc(s!("LoadLibraryW"))?;
        let code = run_remote_thread(&proc, load_library, remote)?;

        // The remote buffer is no longer needed once LoadLibrary has copied the
        // path; drop the guard explicitly to free it now.
        drop(remote_guard);

        // LoadLibraryW returns the module handle (non-zero) on success. The
        // remote thread's exit code is that handle truncated to 32 bits; zero
        // means the load failed inside the target.
        if code == 0 {
            return Err("LoadLibrary 在目标进程中失败（DLL 未加载）".to_string());
        }
    }
    Ok(())
}

/// RAII for a `VirtualAllocEx` region in another process.
struct RemoteAlloc {
    proc: HANDLE,
    addr: *mut c_void,
}
impl Drop for RemoteAlloc {
    fn drop(&mut self) {
        // SAFETY: `addr` came from VirtualAllocEx on `proc`; MEM_RELEASE frees it.
        unsafe {
            let _ = VirtualFreeEx(self.proc, self.addr, 0, MEM_RELEASE);
        }
    }
}

/// Find the remote base address of a loaded module named `dll_name`
/// (case-insensitive) in `pid`, via a ToolHelp module snapshot. `None` when the
/// module isn't loaded (or the snapshot fails). Mirrors the enumeration in
/// `overlay.rs` but returns the module base needed for `FreeLibrary`.
fn find_remote_module(pid: u32, dll_name: &str) -> Option<HMODULE> {
    let target = dll_name.to_lowercase();
    unsafe {
        let snapshot =
            CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid).ok()?;
        let snapshot = ProcHandle(snapshot); // reuse RAII to close the snapshot handle
        let mut entry = MODULEENTRY32W {
            dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
            ..Default::default()
        };
        if Module32FirstW(snapshot.0, &mut entry).is_err() {
            return None;
        }
        loop {
            let end = entry
                .szModule
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szModule.len());
            let name = String::from_utf16_lossy(&entry.szModule[..end]).to_lowercase();
            if name == target {
                return Some(HMODULE(entry.modBaseAddr as *mut c_void));
            }
            if Module32NextW(snapshot.0, &mut entry).is_err() {
                break;
            }
        }
    }
    None
}

/// Eject a previously-injected module (`dll_name`, e.g. `corepilot_overlay.dll`)
/// from `pid` via `CreateRemoteThread(FreeLibrary, base)`. Returns `Ok(())` when
/// the module is gone — including the "not loaded / process exited" cases, which
/// are treated as already-ejected rather than errors.
pub fn eject(pid: u32, dll_name: &str) -> Result<(), String> {
    // Process gone → nothing to eject.
    let Ok(proc) = open_for_inject(pid) else {
        return Ok(());
    };
    // Module not present → already ejected.
    let Some(module) = find_remote_module(pid, dll_name) else {
        return Ok(());
    };
    let free_library = kernel32_proc(s!("FreeLibrary"))?;
    // FreeLibrary(HMODULE) — pass the remote base as the thread arg.
    let code = run_remote_thread(&proc, free_library, module.0 as *const c_void)?;
    // FreeLibrary returns non-zero (BOOL TRUE) on success.
    if code == 0 {
        return Err("FreeLibrary 在目标进程中失败".to_string());
    }
    Ok(())
}
