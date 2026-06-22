//! In-game overlay targeting + injection-safety layer.
//!
//! The MSI-Afterburner-style overlay works by injecting `corepilot_overlay.dll`
//! into a game and hooking its `Present`. Before we ever inject we must decide
//! (1) which process to target (the foreground game), (2) which graphics API it
//! uses (so the DLL hooks the right present path), and (3) whether it is guarded
//! by kernel/user anti-cheat — in which case we MUST refuse, because injection is
//! exactly what anti-cheat flags and could get the user banned.
//!
//! This module is pure detection (no injection yet); it enumerates a target
//! process's loaded modules via ToolHelp. The sampler (writes metrics to the
//! shared block) and the injector are wired on top of this.

use serde::Serialize;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    TH32CS_SNAPMODULE32,
};

/// Graphics API a process renders with, detected from its loaded modules. Drives
/// which `Present`/`SwapBuffers` the injected overlay hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphicsApi {
    /// `d3d12.dll` present — hook `IDXGISwapChain3::Present` (+ command queue).
    Dx12,
    /// `d3d11.dll` present — hook `IDXGISwapChain::Present`.
    Dx11,
    /// `d3d10.dll` present — DXGI present (treated like DX11).
    Dx10,
    /// `d3d9.dll` present — hook `IDirect3DDevice9::Present`.
    Dx9,
    /// `vulkan-1.dll` present — needs a Vulkan layer (hudhook can't hook this).
    Vulkan,
    /// `opengl32.dll` present — hook `wglSwapBuffers`.
    OpenGl,
    /// No known 3D module loaded (yet) — not a renderable target.
    Unknown,
}

impl GraphicsApi {
    /// Whether our `hudhook`-based overlay DLL can hook this API. Vulkan needs a
    /// separate implicit-layer approach (tracked as future work), so it's `false`.
    pub fn is_hookable(self) -> bool {
        matches!(
            self,
            GraphicsApi::Dx12
                | GraphicsApi::Dx11
                | GraphicsApi::Dx10
                | GraphicsApi::Dx9
                | GraphicsApi::OpenGl
        )
    }
}

/// Lowercased module file names that mark a process as anti-cheat-protected.
/// Substring match (e.g. `easyanticheat`, `beclient_x64.dll`). Injecting into
/// these risks a ban, so we hard-refuse.
const ANTICHEAT_MODULE_MARKERS: &[&str] = &[
    "easyanticheat", // Epic EasyAntiCheat / EAC EOS
    "beclient",      // BattlEye client
    "beservice",     // BattlEye service
    "vgc",           // Riot Vanguard user component
    "vgk",           // Riot Vanguard kernel component (driver)
    "gameguard",     // nProtect GameGuard (npggnt / GameMon)
    "npggnt",
    "gamemon",
    "xigncode", // Wellbia XIGNCODE3
    "x3.xem",
    "mhyprot",   // miHoYo anti-cheat
    "anticheat", // generic (covers several vendors' DLLs)
    "battleye",
    "faceit", // FACEIT AC
    "esea",   // ESEA AC
];

/// Graphics-API module markers, in detection priority order (a process can load
/// several DXGI DLLs; resolve to the highest-level renderer first).
const API_MARKERS: &[(&str, GraphicsApi)] = &[
    ("vulkan-1.dll", GraphicsApi::Vulkan),
    ("d3d12.dll", GraphicsApi::Dx12),
    ("d3d11.dll", GraphicsApi::Dx11),
    ("d3d10.dll", GraphicsApi::Dx10),
    ("opengl32.dll", GraphicsApi::OpenGl),
    ("d3d9.dll", GraphicsApi::Dx9),
];

/// RAII wrapper so the ToolHelp snapshot handle is always closed.
struct Snapshot(HANDLE);
impl Drop for Snapshot {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Visit each loaded module's lowercased file name for `pid`. Best-effort: on any
/// failure (access denied, race) the closure simply isn't called. Never panics.
fn for_each_module(pid: u32, mut visit: impl FnMut(&str)) {
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
        {
            Ok(h) => Snapshot(h),
            Err(_) => return,
        };
        let mut entry = MODULEENTRY32W {
            dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
            ..Default::default()
        };
        if Module32FirstW(snapshot.0, &mut entry).is_err() {
            return;
        }
        loop {
            let end = entry
                .szModule
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szModule.len());
            let name = String::from_utf16_lossy(&entry.szModule[..end]).to_lowercase();
            visit(&name);
            if Module32NextW(snapshot.0, &mut entry).is_err() {
                break;
            }
        }
    }
}

/// Detect the graphics API `pid` is rendering with, from its loaded modules.
pub fn detect_graphics_api(pid: u32) -> GraphicsApi {
    if pid == 0 {
        return GraphicsApi::Unknown;
    }
    // Collect which markers are present, then resolve by priority order.
    let mut found = [false; 6];
    for_each_module(pid, |name| {
        for (i, (marker, _)) in API_MARKERS.iter().enumerate() {
            if name == *marker {
                found[i] = true;
            }
        }
    });
    API_MARKERS
        .iter()
        .enumerate()
        .find(|(i, _)| found[*i])
        .map(|(_, (_, api))| *api)
        .unwrap_or(GraphicsApi::Unknown)
}

/// True when `pid` has a known anti-cheat module loaded. Injecting into such a
/// process risks a ban, so the injector must refuse.
pub fn is_anticheat_protected(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let mut protected = false;
    for_each_module(pid, |name| {
        if !protected && ANTICHEAT_MODULE_MARKERS.iter().any(|m| name.contains(m)) {
            protected = true;
        }
    });
    protected
}

/// Whether a process is a safe, hookable overlay target right now: a known
/// graphics API and no anti-cheat. Surfaced to the UI so the user is told *why*
/// the overlay can't attach to a given game.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayTarget {
    pub pid: u32,
    pub api: GraphicsApi,
    pub anticheat: bool,
    /// True iff `api.is_hookable()` and `!anticheat`.
    pub injectable: bool,
}

/// Classify a target process for the overlay (does not inject).
pub fn classify_target(pid: u32) -> OverlayTarget {
    let api = detect_graphics_api(pid);
    let anticheat = is_anticheat_protected(pid);
    OverlayTarget {
        pid,
        api,
        anticheat,
        injectable: api.is_hookable() && !anticheat,
    }
}
