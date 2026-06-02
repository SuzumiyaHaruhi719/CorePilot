# OSD Injection Research — How RTSS/Afterburner Do It, and What CorePilot Should Borrow

Status: research + design note. **No code changes proposed here are implemented.** This
document contrasts CorePilot's current overlay (a transparent click-through Tauri window
+ ETW present timing) with the MSI Afterburner + RTSS approach (DLL injection + present
hooking), and recommends a realistic path.

Reference for current behavior: `src-tauri/src/osd.rs`, `src-tauri/src/fps.rs`,
`src/osd/OsdOverlay.tsx`, `src/osd/OsdPlate.tsx`, `src/lib/osd.ts`, `docs/osd-spec.md`.

---

## 1. RTSS in-game overlay = API hooking via DLL injection

The RivaTuner Statistics Server (RTSS) overlay is **not** a separate window floating on
top of the game. It is drawn **inside the game's own rendered frame**, by injecting a
hooks DLL (`RTSSHooks64.dll` / `RTSSHooks.dll`) into each graphics application and
intercepting that app's *present/swap* call. Concretely RTSS hooks the per-API frame
submission entry points:

| Graphics API | Hooked entry point(s) | Notes |
|---|---|---|
| Direct3D 9 | `IDirect3DDevice9::Present`, `::EndScene`, `IDirect3DSwapChain9::Present` | legacy titles |
| DXGI (D3D10/11/12) | `IDXGISwapChain::Present`, `::Present1` | the modern majority |
| OpenGL | `wglSwapBuffers` (and `SwapBuffers` on the GL DC) | |
| Vulkan | `vkQueuePresentKHR` (+ swapchain create) | layer-style interception |

**Mechanism.** Hooking is done by patching the function prologue (a detour/trampoline:
overwrite the first bytes with a `jmp` to RTSS code, preserving the originals to call
through) or by IAT/vtable patching for COM interfaces like `IDXGISwapChain`. When the
game calls `Present`, control first enters RTSS's hook, which:

1. **Times the frame.** The interval between successive `Present` calls on that swapchain
   is the true frame time; this is how RTSS produces its own framerate/frametime
   independent of any external sampler.
2. **Renders the overlay into the game's back buffer** using the game's *own* device/
   context (a D3D/GL/VK draw of RTSS's text), so the OSD becomes part of the very frame
   the GPU is about to scan out.
3. Calls the original `Present` so the frame (now containing the overlay) is displayed.

**Why this works in exclusive fullscreen and flip-model — and an external window does
not.** In **exclusive fullscreen** the application owns the display output directly; the
Desktop Window Manager (DWM) is bypassed and no other top-level window is composited over
the game's scanned-out surface. An external always-on-top window therefore simply is not
visible — there is no compositor to layer it in. The **flip presentation model**
(`DXGI_SWAP_EFFECT_FLIP_*`, including independent-flip / "fullscreen optimizations") has
the same consequence whenever the runtime promotes the swapchain to direct scanout: the
game's back buffers are flipped straight to the display plane, so anything not drawn into
those buffers is not on screen. Because RTSS draws **into the swapchain's back buffer
before the flip**, its overlay travels with the frame regardless of presentation model —
exclusive fullscreen, flip-model borderless, or classic composited windowed. That is the
whole reason injection is used instead of a window: it is the only way to put pixels into
a surface the app exclusively owns.

A secondary benefit: because the hook sits on the exact `Present` call, RTSS's frame
timing and frame-limiting (its scanline-sync / framerate cap) are measured and applied at
the precise submission boundary — something an outside observer cannot do as tightly.

---

## 2. Automatic game detection (RTSS + Afterburner)

RTSS auto-detects 3D applications rather than requiring the user to register each game:

- **Global hook / injection scope.** RTSS installs a system-wide hook so that processes
  loading a graphics runtime get the RTSS hooks DLL mapped in. When a process actually
  **loads `d3d9/d3d11/d3d12/dxgi/opengl32/vulkan-1`** and begins issuing present/swap
  calls, RTSS recognizes it as a renderable target — i.e., detection is by *observed use
  of a graphics API and presents*, not by a hard-coded title list.
- **Per-application profiles.** RTSS keeps a profile per executable (global default +
  per-`.exe` overrides) controlling whether the OSD shows, its position, the frame cap,
  etc. The "On-Screen Display application detection level" / "Application detection level"
  setting (None / Low / Medium / High) tunes how aggressively RTSS hooks processes,
  trading compatibility against the chance of hooking something you didn't intend.
- **Afterburner drives RTSS.** MSI Afterburner is the sensor/overclocking front end; it
  does **not** render the in-game overlay itself. It feeds its monitored values (GPU/CPU
  temps, clocks, usage, fan, framerate, etc.) to RTSS over RTSS's shared-memory interface,
  and **RTSS** is the component that injects and draws them in-game. This separation —
  *sensor source* vs. *injected renderer* — is the key architectural split to keep in
  mind for CorePilot.

---

## 3. Modern measurement basis: PresentMon (Intel)

The industry-standard way to measure framerate/frametime/latency **without injection** is
Intel's **PresentMon**. It is an ETW (Event Tracing for Windows) consumer that listens to
the OS's own present pipeline — the **`Microsoft-Windows-DxgKrnl`** and **DXGI**
providers — and reconstructs, per process and per swapchain, when each frame was
presented, how it was presented (composed vs. flip vs. independent flip), and derived
metrics:

- **Frametime / FPS** from inter-present intervals.
- **Presentation mode** (Composed, Hardware Independent Flip, etc.).
- Latency-oriented metrics such as displayed-frame timing and (with PresentMon 2.x /
  `PresentMonService` + the SDK) GPU busy and click-to-photon style figures.

Because it only *reads* ETW events emitted by the graphics stack, PresentMon needs **no
DLL in the game** — and therefore carries no anti-cheat/AV injection risk. The cost is
that it can **measure** the frame but cannot **draw** anything inside it; rendering an
overlay still requires either injection (RTSS) or external compositing.

**CorePilot already uses this basis.** `src-tauri/src/fps.rs` runs a single real-time ETW
user-trace on `Microsoft-Windows-DxgKrnl` (GUID `802ec45a-…`), counts `Present_Info`
(event id `0xB8`, one per `IDXGISwapChain::Present` on the submitting PID), buckets
timestamps per process id from the event header, and exposes FPS for the **foreground
window's PID** via `foreground_fps()` / the `osd_fps` command. This is a minimal
PresentMon-style consumer: no injection, admin-gated, fails closed to `None`.

---

## 4. Contrast with CorePilot today

| Concern | RTSS / Afterburner | CorePilot today |
|---|---|---|
| Overlay surface | Injected DLL draws **into the game's swapchain back buffer** | Separate **transparent, always-on-top, click-through Tauri window** (`osd.rs`), WebView2 renders `OsdPlate` |
| Exclusive fullscreen | **Works** (overlay is part of the frame) | **Does not show** (no compositor to layer the window) |
| Flip-model borderless / independent flip | Works | May not show when promoted to direct scanout |
| Composited borderless / windowed (DWM) | Works | **Works** — DWM composites the topmost window over the game |
| Frame timing | Measured **at the hooked `Present`** (per-swapchain, exact) | Measured **externally via ETW** `DxgKrnl Present_Info` per foreground PID (`fps.rs`) |
| Metric source | Afterburner sensors over RTSS shared memory | CorePilot's existing sensors/NVML/PDH, polled ~1 Hz by `OsdOverlay` |
| Game detection | Global hook + per-exe profiles + detection level | **None yet** — overlay is shown/hidden manually; FPS just follows whatever owns the foreground window |
| Injection / anti-cheat risk | Present (mitigated by maturity + allowlisting) | **None** — no code runs inside the game |

In short: CorePilot's overlay is correct and safe for the **modern default**
(borderless/windowed, DWM-composed) and already has the *right measurement primitive*
(ETW presents). Its two gaps versus RTSS are (a) it has **no automatic game detection**,
and (b) it **cannot draw in exclusive fullscreen / direct-scanout** because it is an
external window, not an injected renderer. `osd.rs` and `fps.rs` both already document
these limits in their module comments.

---

## 5. Recommendation for CorePilot

### 5a. Feasible now — borrow these

1. **Automatic foreground-game auto-detection (highest value, low risk).**
   Reuse the existing ETW present stream as a *game presence signal* rather than only an
   FPS source. A process that is emitting `DxgKrnl Present_Info` events **is** rendering a
   3D frame — that is exactly RTSS's "is this a game?" heuristic, obtained here without
   injection. Combine three cheap signals already available in-process:
   - the **foreground window's PID** (`GetForegroundWindow` → `GetWindowThreadProcessId`,
     already used in `fps.rs`);
   - whether that PID has **recent presents** in the ETW map (extend `fps.rs` with a
     `is_presenting(pid)` / "active present PID" query);
   - a small **allowlist / blocklist** by executable name (user-editable; default-block
     obvious non-games like the shell, browsers, CorePilot itself) mirroring RTSS's
     per-exe profiles and "detection level."

   Use this to **auto show/hide** the overlay window and to label *which* game is being
   measured. This closes the biggest UX gap versus Afterburner+RTSS and is almost entirely
   reuse of code that exists today.

2. **Keep the Tauri overlay for borderless/windowed.** Borderless windowed is the common
   default for modern titles, and the current transparent click-through window
   (`osd.rs` + `OsdOverlay`/`OsdPlate`) handles it well at negligible overhead. No change
   to the rendering approach is needed for that majority case.

3. **Lean harder on ETW for the frame metrics the spec wants.** The same `DxgKrnl`/DXGI
   ETW data that yields FPS also yields **frametime**, **1% / 0.1% lows**, and the basis
   for **presentation-mode** and latency readouts — all currently stubbed `supported:
   false` in `src/lib/osd.ts` (`fps.frametime`, etc.). Computing these from the present
   timestamps already collected in `fps.rs` (retain a longer per-PID history and derive
   percentiles) is a pure backend extension, no injection, and directly fills the OSD spec.

### 5b. Major undertaking — document, do **not** implement now

A **true injected overlay** to support **exclusive fullscreen / direct-scanout** — i.e.,
matching RTSS's core capability. This is a large, separate effort and should be a
deliberate future decision, not a quick add.

**What it would take:**
- A **native injectable DLL** (C/C++ or Rust `cdylib`), entirely outside the Tauri/WebView
  world, that:
  - installs **present hooks per graphics API** — DXGI `Present`/`Present1` (D3D10/11/12),
    D3D9 `Present`/`EndScene`, GL `wglSwapBuffers`, Vulkan `vkQueuePresentKHR` — via a
    detour library (e.g. MinHook / Microsoft Detours) or COM vtable patching;
  - **renders the overlay into the back buffer** using the game's own device/context for
    each API (a non-trivial amount of per-API D3D/GL/VK drawing code, plus device-loss /
    resize / multi-swapchain handling).
- An **injector** (e.g. `CreateRemoteThread` + `LoadLibrary`, or a global `WH_*` hook) and
  the **detection logic** to decide which processes to inject — reusing the present-based
  detection from 5a.
- An **IPC channel** from CorePilot to the injected DLL (RTSS uses **shared memory**; that
  is the natural choice) to feed it the live metric strings the overlay should show, since
  the metric *source* (NVML/PDH/sidecar) stays in the main app. This is the same
  sensor-source-vs-injected-renderer split RTSS uses.
- A **rendering/IPC contract** and versioning so the DLL and host stay compatible.

**Risks and costs (why this is a separate module and a real decision):**
- **Anti-cheat.** Kernel/usermode anti-cheat (EAC, BattlEye, Vanguard, etc.) treats
  foreign present hooks and remote injection as cheating and may ban accounts or refuse to
  launch. This alone makes injection unsuitable as an always-on default.
- **Antivirus / SmartScreen / EDR.** `CreateRemoteThread`+`LoadLibrary` and prologue
  patching are textbook malware techniques and are frequently flagged; expect
  false-positive friction and signing/reputation overhead.
- **Stability and support load.** A bug in injected code crashes the **game**, not
  CorePilot. Per-API, per-driver, per-title edge cases (fullscreen toggles, alt-tab,
  device reset, HDR, multi-GPU) are a long maintenance tail — exactly the surface RTSS has
  spent many years hardening.
- **Architecture.** It cannot live in the Rust/WebView process; it is a distinct native
  artifact with its own build, signing, lifecycle, and crash-isolation story.
- **Scope.** Effectively re-implementing the hard 20% of RTSS. Consider instead
  **interoperating with an existing renderer** (e.g. detect/recommend RTSS, or integrate a
  vetted open overlay) before committing to a bespoke hook DLL.

---

## Bottom line

**Borrow RTSS's *detection* idea now via ETW presents + foreground PID + an allow/blocklist
and keep the click-through Tauri overlay (plus ETW frametime/1%-lows) for borderless games;
treat a true injected present-hook overlay for exclusive fullscreen as a high-risk,
separate native module to revisit later, not build now.**
