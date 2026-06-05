# CorePilot Fan Control ("FanXpert 4 内置") — Design

Date: 2026-06-04
Status: Approved by owner for autonomous build ("能就做"). Author works without
further approval gates; owner reviews the result.

## Goal

Build a **FanXpert-4-equivalent** fan-control feature directly into CorePilot:

- Read motherboard fan **RPMs** and board **temperatures** live.
- **Manual** per-fan PWM duty (0–100%).
- Temperature-driven **fan curves** (selectable temperature source → duty points,
  interpolated), the way FanXpert / FanControl work.
- Persist per-fan configuration; optionally re-apply on startup.
- **Graceful degradation**: on boards whose firmware locks the Super-I/O fan
  registers (the README already calls this out for some B850 boards), reads still
  work, control is reported unavailable, and nothing is faked.

> We can **not** literally embed ASUS's proprietary, closed-source FanXpert 4
> binary (part of AI Suite 3 / Armoury Crate — not redistributable). "内置
> FanXpert4" is therefore implemented as a built-in equivalent.

## Why it's feasible

CorePilot already bundles **LibreHardwareMonitor** (the `sensord` .NET 8 sidecar,
`LibreHardwareMonitorLib` 0.9.4). LHM reads Super-I/O chips (Nuvoton / ITE /
Fintek — including the chips on ASUS AM5 boards) and supports **fan PWM control**
via `ISensor.Control` → `IControl.SetSoftware(value)` / `SetDefault()`. This is
the exact engine the popular open-source *FanControl* app uses. The sidecar's
existing `--list` diagnostic already enumerates `Control` / `Fan` / `Temperature`
sensors and checks `sensor.Control != null`. So ~80% of the hard plumbing exists.

## Architecture (reuse the single existing sidecar — one LHM driver load)

```
React FanControl page ──fan_set_config──▶ Rust fan.rs (FAN_CONFIG)
        ▲                                      │ curve engine thread (~2s)
        │ fan_info (poll)                       │ send "set <id> <pct>" / "auto <id>"
        │                                       ▼
   FAN_STATE  ◀── ingest_line ── sensors.rs reader ◀── stdout JSON ── sensord (.NET)
                                  register_sidecar_stdin ──▶ stdin commands ──▶ LHM IControl
```

### 1. `sensord` sidecar (Program.cs) — extended
- Open `Computer` with `IsMotherboardEnabled = true`, `IsControllerEnabled = true`
  (keep CPU/GPU). Build a `controlId → ISensor` map at open.
- Each 1 s poll, emit one JSON line that **keeps** the existing
  `cpuPower/cpuTemp/gpuPower/gpuTemp` keys (the current Rust consumer) **and adds**:
  - `fans: [{id,name,rpm}]`
  - `temps: [{id,name,c}]`
  - `controls: [{id,name,pct,controllable,hw}]`
- A **stdin command thread** reads one command per line (thread-safe via a lock):
  - `set <controlId> <0..100>` → `IControl.SetSoftware(pct)`
  - `auto <controlId>` → `IControl.SetDefault()`
  - `autoall` → reset every control touched this session
- On stdin EOF / shutdown: **reset all touched controls to default** (never leave a
  fan pinned if CorePilot exits).
- Switch payload to `System.Text.Json` (BCL, no new dependency).

### 2. Rust `fan.rs` (new module)
- Statics: `FAN_STATE: Mutex<FanSnapshot>`, `SIDECAR_STDIN: Mutex<Option<ChildStdin>>`,
  `FAN_CONFIG: Mutex<FanConfig>`.
- `register_sidecar_stdin(ChildStdin)` and `ingest_line(&str)` are called from
  `sensors.rs` (which owns the single sidecar process).
- `send_command(&str)` writes a line to the sidecar stdin.
- Commands: `fan_info() -> FanState`, `fan_set_config(Vec<FanChannelConfig>)`.
- **Curve engine thread** (`start_engine`, launched from `lib.rs` setup): every ~2 s,
  for each configured control — `auto` ⇒ send `auto` once; `manual` ⇒ re-assert
  `set id pct`; `curve` ⇒ read the chosen temp source from `FAN_STATE`, interpolate
  the curve, apply a small hysteresis, send `set id pct`. PWM always clamped 0–100.

### 3. `sensors.rs` — minimal change
- `.stdin(Stdio::null())` → `.stdin(Stdio::piped())`; hand the child stdin to
  `fan::register_sidecar_stdin`; in the reader loop also call `fan::ingest_line`.
  The existing 4-field parse is unchanged (extra JSON keys are ignored by it).

### 4. Frontend
- `lib/ipc.ts`: `FanChannel`, `FanTempSource`, `FanInfo`, `FanChannelConfig` +
  `api.fanInfo()` / `api.fanSetConfig()`.
- `store/fanProfiles.ts`: persisted (tauri-store) per-control config; pushes config
  to the backend on change and on startup hydration (mirrors `gpuProfiles`).
- `tabs/FanControl.tsx`: FanXpert-style — live fan cards (RPM + duty), per-fan mode
  (自动/手动/曲线), manual slider, an SVG draggable **curve editor** with a
  temp-source dropdown, apply/reset, "启动时应用". Board-locked empty state when no
  control is `controllable`.
- `store/ui.ts` add `"fans"` tab; `App.tsx` register page; `NavRail.tsx` add 风扇 nav
  item (lucide `Fan`).

## Pairing fans ↔ controls
LHM does not formally pair an RPM `Fan` sensor with its `Control`. We pair by the
trailing integer in the names (e.g. "Fan #2" ↔ "Fan Control #2"), else by order.
Each UI "channel" = one Control (+ best-matching Fan RPM, shown when found).

## Safety
- Clamp 0–100; per-curve minimum duty (default floor) so a fan is never forced to a
  stall the user didn't ask for.
- Empty/invalid curve ⇒ treat as `auto`.
- Sidecar resets all touched controls to BIOS default on exit.
- App still runs elevated (already required); control simply no-ops on locked boards.

## Out of scope (this iteration)
- FanXpert "auto-tuning" (physically ramps each fan to characterize RPM range). The
  control plumbing supports adding it later; not built now.
- OSD overlay fan fields (FanXpert has no OSD; avoids an IPC-version bump + DLL rebuild).

## Verification
Per owner instruction: **do not exercise fan control on hardware**. Completion =
the whole project **builds** green: `dotnet build` (sidecar), `cargo check`
(workspace), `tsc`/`vite build` (frontend). Functional testing is deferred until
the owner explicitly asks.
