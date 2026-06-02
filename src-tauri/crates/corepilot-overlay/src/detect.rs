//! Graphics-API detection for the host (injected-into) process.
//!
//! We can't know ahead of time whether a given game presents via DirectX or
//! OpenGL, so at DLL attach we sniff which graphics runtime DLLs are already
//! loaded into our process and hook the matching `Present`. This mirrors how
//! generic overlays (RTSS, etc.) pick a backend.
//!
//! Detection is read-only: `GetModuleHandleW` only succeeds if the module is
//! already mapped into *this* process; it never loads anything. If several are
//! present (e.g. a D3D11-on-12 title), we prefer the newest/most-capable API in
//! the order DX12 > DX11 > OpenGL3 > DX9.

use windows::core::w;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;

/// Which present-API the host process uses, in hudhook hook terms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphicsApi {
    Dx12,
    Dx11,
    OpenGl3,
    Dx9,
}

/// True when `module` (e.g. `d3d12.dll`) is currently mapped into this process.
///
/// `GetModuleHandleW` returns `Ok` only for an already-loaded module — it does
/// not load it — so this is a safe, side-effect-free probe. We discard the
/// handle (we never own it; the module stays loaded by the game).
fn module_loaded(module: windows::core::PCWSTR) -> bool {
    // SAFETY: passing a valid static wide string; we only read the Result.
    unsafe { GetModuleHandleW(module).is_ok() }
}

/// Detect the host's graphics API by probing for loaded runtime DLLs.
///
/// Returns `None` only if none of the supported runtimes are loaded yet (e.g.
/// the hook attached extremely early, before the game created its device). The
/// caller retries on a later attach attempt rather than guessing.
pub fn detect_graphics_api() -> Option<GraphicsApi> {
    // Order matters: prefer the most modern API a process exposes.
    if module_loaded(w!("d3d12.dll")) {
        Some(GraphicsApi::Dx12)
    } else if module_loaded(w!("d3d11.dll")) {
        Some(GraphicsApi::Dx11)
    } else if module_loaded(w!("opengl32.dll")) {
        Some(GraphicsApi::OpenGl3)
    } else if module_loaded(w!("d3d9.dll")) {
        Some(GraphicsApi::Dx9)
    } else {
        None
    }
}
