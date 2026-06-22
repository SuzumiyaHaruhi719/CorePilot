//! Injectable in-game OSD overlay DLL for CorePilot.
//!
//! This is the MSI-Afterburner/RTSS-style overlay: code injected into a game
//! that hooks `Present` and draws CorePilot's metrics into the game's own back
//! buffer. Because we draw inside the game's frame, it works in exclusive
//! fullscreen with no window of our own.
//!
//! Architecture:
//!   * [`corepilot_osd_ipc`] is the shared-memory contract. CorePilot (the
//!     writer) samples metrics into a named block; this DLL (the reader) opens it
//!     and draws an OSD each presented frame. See [`render`].
//!   * [`hudhook`] does the heavy lifting: it hooks `Present` for DX9/11/12 and
//!     OpenGL3 (vendored MinHook) and renders via Dear ImGui.
//!   * At attach we sniff which graphics runtime the host loaded ([`detect`]) and
//!     install the matching hudhook hook.
//!
//! Crash safety: a panic in our render path would unwind across hudhook's FFI
//! and crash the game, so the render body is wrapped in `catch_unwind` (see
//! [`render::OsdRenderLoop`]). The `DllMain` here also never blocks — all hook
//! installation happens on a spawned thread, exactly as hudhook documents.

mod detect;
mod format;
mod render;

use detect::GraphicsApi;
use render::OsdRenderLoop;

// Hook implementations, one per supported present-API.
use hudhook::hooks::dx11::ImguiDx11Hooks;
use hudhook::hooks::dx12::ImguiDx12Hooks;
use hudhook::hooks::dx9::ImguiDx9Hooks;
use hudhook::hooks::opengl3::ImguiOpenGl3Hooks;
use hudhook::Hudhook;

// IMPORTANT: use hudhook's *re-exported* `windows` (0.57) for the DllMain
// signature and `with_hmodule`, so the `HINSTANCE` type matches what hudhook's
// builder expects. Our own `windows` dependency (0.62) is used only inside
// `detect`/`render` for value-returning calls where the version is irrelevant.
use hudhook::windows::Win32::Foundation::HINSTANCE;
use hudhook::windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;

/// Build the hudhook hook set for `api`, wiring in a fresh [`OsdRenderLoop`], and
/// apply it. Each arm is monomorphised over the concrete hook type because
/// `HudhookBuilder::with::<T>` is generic; selecting `T` at runtime therefore
/// means branching here. On failure we ask hudhook to eject so a half-installed
/// hook never lingers in the game.
fn install_hooks(api: GraphicsApi, hmodule: HINSTANCE) {
    // Each branch is identical except for the hook type parameter.
    let result = match api {
        GraphicsApi::Dx12 => Hudhook::builder()
            .with::<ImguiDx12Hooks>(OsdRenderLoop::new())
            .with_hmodule(hmodule)
            .build()
            .apply(),
        GraphicsApi::Dx11 => Hudhook::builder()
            .with::<ImguiDx11Hooks>(OsdRenderLoop::new())
            .with_hmodule(hmodule)
            .build()
            .apply(),
        GraphicsApi::OpenGl3 => Hudhook::builder()
            .with::<ImguiOpenGl3Hooks>(OsdRenderLoop::new())
            .with_hmodule(hmodule)
            .build()
            .apply(),
        GraphicsApi::Dx9 => Hudhook::builder()
            .with::<ImguiDx9Hooks>(OsdRenderLoop::new())
            .with_hmodule(hmodule)
            .build()
            .apply(),
    };

    if let Err(e) = result {
        tracing::error!(
            "CorePilot overlay: failed to apply {:?} hooks: {:?}",
            api,
            e
        );
        // Tear ourselves back out cleanly rather than leaving dangling hooks.
        hudhook::eject();
    } else {
        tracing::info!("CorePilot overlay: installed {:?} hooks", api);
    }
}

/// The worker that runs off the loader lock: detect the API and install hooks.
/// Kept out of `DllMain` so we never call anything non-trivial under the Windows
/// loader lock (which can deadlock the game).
fn attach_worker(hmodule: HINSTANCE) {
    match detect::detect_graphics_api() {
        Some(api) => install_hooks(api, hmodule),
        None => {
            // No supported runtime mapped yet. We don't retry-loop here because
            // hudhook owns the global hook slot; if the device appears later the
            // user can re-inject. Logging helps diagnose "nothing showed up".
            tracing::warn!(
                "CorePilot overlay: no supported graphics API (d3d9/11/12, opengl32) \
                 detected in host process; not hooking"
            );
        }
    }
}

/// DLL entry point.
///
/// We deliberately hand-roll this instead of using the `hudhook!` macro because
/// that macro hard-codes a single hook type, whereas we must pick the hook at
/// runtime from API detection. The shape otherwise mirrors the macro exactly:
/// on `DLL_PROCESS_ATTACH` we spawn a thread and do all real work there, so
/// `DllMain` returns immediately and never blocks under the loader lock.
///
/// # Safety
/// Standard `DllMain` contract — invoked by the Windows loader. We only read
/// `reason`, copy the module handle as an integer to move it to the worker
/// thread, and return; no loader-lock-unsafe work happens here.
#[no_mangle]
pub unsafe extern "system" fn DllMain(
    hmodule: HINSTANCE,
    reason: u32,
    _reserved: *mut core::ffi::c_void,
) -> i32 {
    if reason == DLL_PROCESS_ATTACH {
        // `HINSTANCE` is not `Send`; move it across the thread boundary as a raw
        // integer (this is exactly what hudhook's own macro does) and rebuild it
        // inside the worker.
        let hmodule_raw = hmodule.0 as usize;
        std::thread::spawn(move || {
            let hmodule = HINSTANCE(hmodule_raw as _);
            attach_worker(hmodule);
        });
    }
    // Non-zero = success; required so the loader keeps the DLL mapped.
    1
}
