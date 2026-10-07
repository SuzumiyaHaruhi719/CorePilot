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

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
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
const CLASSIFICATION_CACHE_TTL: Duration = Duration::from_secs(10);

/// Cache module walks because status polls run every 1.5 seconds and a ToolHelp
/// walk can stall the UI; the TTL limits stale data when a PID is recycled.
static CLASSIFICATION_CACHE: Lazy<Mutex<HashMap<u32, (Instant, ModuleFacts)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

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

/// Graphics API and anti-cheat presence from ONE module snapshot (they were two
/// full ToolHelp walks of the game per classification).
fn scan_modules(pid: u32) -> (GraphicsApi, bool) {
    let mut found = [false; API_MARKERS.len()];
    let mut anticheat = false;
    for_each_module(pid, |name| {
        for (i, (marker, _)) in API_MARKERS.iter().enumerate() {
            if name == *marker {
                found[i] = true;
            }
        }
        if !anticheat && ANTICHEAT_MODULE_MARKERS.iter().any(|m| name.contains(m)) {
            anticheat = true;
        }
    });
    let api = API_MARKERS
        .iter()
        .enumerate()
        .find(|(i, _)| found[*i])
        .map(|(_, (_, api))| *api)
        .unwrap_or(GraphicsApi::Unknown);
    (api, anticheat)
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

/// True when `pid` runs natively (64-bit on 64-bit Windows). The injector starts
/// its remote thread at OUR `LoadLibraryW` and loads a 64-bit DLL, neither of
/// which exists in a WoW64 process — so anything else is refused. Fails closed:
/// a process we can't query is treated as not native.
pub fn is_native(pid: u32) -> bool {
    use windows::Win32::System::SystemInformation::IMAGE_FILE_MACHINE_UNKNOWN;
    use windows::Win32::System::Threading::{
        IsWow64Process2, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let handle = Snapshot(handle); // same RAII close
        let mut process_machine = IMAGE_FILE_MACHINE_UNKNOWN;
        IsWow64Process2(handle.0, &mut process_machine, None).is_ok()
            && process_machine == IMAGE_FILE_MACHINE_UNKNOWN
    }
}

/// Kernel-mode anti-cheat services/drivers (SCM names). These have no module in
/// the game process — the module scan can't see them — and they watch the
/// whole system, so while one is RUNNING nothing gets injected anywhere.
/// Ceiling: a vendor not on this list is invisible here; the per-exe allowlist
/// is the primary gate, this is the extra refusal on top.
const KERNEL_ANTICHEAT_SERVICES: &[(&str, &str)] = &[
    ("vgk", "Riot Vanguard"),
    ("vgc", "Riot Vanguard"),
    ("mhyprot2", "miHoYo mhyprot"),
    ("mhyprot3", "miHoYo mhyprot"),
    ("EasyAntiCheat", "EasyAntiCheat"),
    ("EasyAntiCheat_EOS", "EasyAntiCheat"),
    ("BEService", "BattlEye"),
    ("BEDaisy", "BattlEye"),
    ("FACEIT", "FACEIT"),
    ("ESEADriver2", "ESEA"),
    ("npggsvc", "nProtect GameGuard"),
    ("xhunter1", "XIGNCODE3"),
];

/// How long a kernel-AC probe result is reused (an SCM query per service).
const KERNEL_AC_TTL: Duration = Duration::from_secs(30);
static KERNEL_AC: Lazy<Mutex<Option<(Instant, Option<&'static str>)>>> =
    Lazy::new(|| Mutex::new(None));

/// The vendor name of a running kernel anti-cheat, if any.
pub fn kernel_anticheat_running() -> Option<&'static str> {
    let mut cache = KERNEL_AC.lock();
    if let Some((at, hit)) = *cache {
        if at.elapsed() < KERNEL_AC_TTL {
            return hit;
        }
    }
    let hit = probe_kernel_anticheat();
    *cache = Some((Instant::now(), hit));
    hit
}

fn probe_kernel_anticheat() -> Option<&'static str> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_MANAGER_CONNECT,
        SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_STATUS,
    };
    unsafe {
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT).ok()?;
        let mut hit = None;
        for (name, vendor) in KERNEL_ANTICHEAT_SERVICES {
            let Ok(svc) = OpenServiceW(scm, &HSTRING::from(*name), SERVICE_QUERY_STATUS) else {
                continue; // not installed
            };
            let mut status = SERVICE_STATUS::default();
            let running = QueryServiceStatus(svc, &mut status).is_ok()
                && status.dwCurrentState == SERVICE_RUNNING;
            let _ = CloseServiceHandle(svc);
            if running {
                hit = Some(*vendor);
                break;
            }
        }
        let _ = CloseServiceHandle(scm);
        hit
    }
}

/// Whether a process is a safe, hookable overlay target right now: the
/// foreground GAME, on the user's allowlist, rendering with a hookable API,
/// native bitness, and no anti-cheat. Surfaced to the UI so the user is told
/// *why* the overlay can't attach to a given app.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayTarget {
    pub pid: u32,
    pub api: GraphicsApi,
    /// An anti-cheat module is loaded in the target, OR a kernel anti-cheat is
    /// running system-wide (then `blockedBy` names it).
    pub anticheat: bool,
    pub blocked_by: Option<String>,
    /// The foreground game detector (`fps::foreground_info_now`) says this PID
    /// is a game. Without it every D3D-using app — explorer, a browser,
    /// CorePilot itself — looked injectable.
    pub game: bool,
    /// Lowercased exe name of the target (when it is the foreground app).
    pub exe: Option<String>,
    /// The exe is on the user's injection allowlist (`overlay_config`). Fail
    /// closed: anything else gets the window overlay.
    pub allowed: bool,
    /// Native 64-bit process (see [`is_native`]).
    pub native: bool,
    /// True iff `game && allowed && native && api.is_hookable() && !anticheat`.
    pub injectable: bool,
}

/// The module-walk part of a classification: what's cached.
#[derive(Clone, Copy)]
struct ModuleFacts {
    api: GraphicsApi,
    anticheat: bool,
    native: bool,
}

/// Classify a target process for the overlay (does not inject). The expensive
/// module walk is cached per PID for [`CLASSIFICATION_CACHE_TTL`]; the game
/// verdict is re-read every call because it flips as a game starts presenting.
pub fn classify_target(pid: u32) -> OverlayTarget {
    if pid == 0 {
        return OverlayTarget {
            pid,
            api: GraphicsApi::Unknown,
            anticheat: false,
            blocked_by: None,
            game: false,
            exe: None,
            allowed: false,
            native: false,
            injectable: false,
        };
    }
    let now = Instant::now();
    let cached = CLASSIFICATION_CACHE
        .lock()
        .get(&pid)
        .filter(|(at, _)| now.duration_since(*at) < CLASSIFICATION_CACHE_TTL)
        .map(|(_, facts)| *facts);
    let facts = cached.unwrap_or_else(|| {
        let (api, anticheat) = scan_modules(pid);
        let facts = ModuleFacts {
            api,
            anticheat,
            native: is_native(pid),
        };
        let mut cache = CLASSIFICATION_CACHE.lock();
        cache.retain(|_, (at, _)| now.duration_since(*at) < CLASSIFICATION_CACHE_TTL);
        cache.insert(pid, (now, facts));
        facts
    });
    let fg = crate::fps::foreground_info_now();
    let is_fg = fg.pid == pid;
    let game = pid != std::process::id() && is_fg && fg.is_game;
    let exe = if is_fg { fg.exe } else { None };
    let allowed = exe
        .as_deref()
        .is_some_and(crate::overlay_inject::is_allowed);
    let blocked_by = kernel_anticheat_running().map(str::to_string);
    let anticheat = facts.anticheat || blocked_by.is_some();
    OverlayTarget {
        pid,
        api: facts.api,
        anticheat,
        blocked_by,
        game,
        exe,
        allowed,
        native: facts.native,
        injectable: game && allowed && facts.native && facts.api.is_hookable() && !anticheat,
    }
}
