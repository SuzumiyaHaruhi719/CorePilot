# CorePilot OSD (In-Game Overlay) — Spec

Reference: GamePP "游戏内监控" screenshots (2026-06-02 08:37). Goal: a **beautiful**
(外观精美) and **low-overhead** (占用低) on-screen display overlay for games, driven
by CorePilot's existing sensors/NVML data.

## Requirements captured from each reference screenshot

### 083740 — main config screen ("游戏内监控")
- **Styles (样式):** 横向模式 (horizontal bar), 竖排模式 (vertical list), 简洁模式
  (compact), 自由模式 (free placement). Plus simple/rich density.
- **Live preview** of the OSD over a game frame: `CPU 100% 100℃ 9999Mhz · GPU 100% 100℃`.
- **Font/scale (字体大小):** presets 480 / 720 / 1080 / 2K / 4K (i.e. scale by target res).
- **Corner radius (圆角设置)**, **monitor on/off (监控数据)**, **OLED 防烧屏** (periodic
  position nudge to avoid burn-in).
- **Hotkeys:** toggle content (Ctrl+Shift+Tab), toggle OSD (Ctrl+Shift+F10).
- **FPS content:** FPS, FPS Low 1%, FPS Low 0.1%, 当前帧时 (frametime ms),
  延迟 (latency ms), 下载速度 (KB/s), 上传速度 (KB/s).

### 083743 — CPU content
温度 (°C) · 占用率 (%) · 热功耗 (W) · 风扇转速 (RPM) · 频率 (MHz) · 电压 (V)

### 083747 — GPU content (per GPU, multi-GPU aware: "GPU [#1] NVIDIA …", "GPU [#2] AMD …")
温度 (°C) · 核心热点温度 (°C) · 占用率 (D3D/Total) · 频率 (MHz) · 热功耗 (W) ·
风扇转速 (RPM) · 显存占用 (%) · 显存占用量 (used/total) · 显存温度 (°C) · 显存频率 (MHz)

### 083755 — Memory content
占用率 (%) · 温度 (°C)

### (Disk — not screenshotted) inferred
读取/写入速度 · 占用率 (%) · 温度 (°C)

## What CorePilot can source today (reliable, no PresentMon)
- CPU: util% (metrics.cpuOverall), temp/power (sidecar), freq (—, add later), fan/voltage (—).
- GPU (NVML): util%, temp, hotspot (NVML if supported), power, fan%, core/mem clock, vram used/total, vram%.
- Memory: util%, used/total. Temp (—, DIMM temp rarely exposed).
- Disk: read/write bytes/s, active% (PDH).
- Network: up/down bytes/s.

## FPS — needs PresentMon (ETW present timing)
FPS / FPS Low 1% / 0.1% / frametime / latency require per-present timing. Scaffold the
config + overlay slots; back with a `osd_fps()` hook returning None until a PresentMon
consumer is added. Hardware metrics ship working now; FPS marked "需 PresentMon".

## Architecture
- **Overlay window:** Tauri `WebviewWindowBuilder` — transparent, no decorations,
  always-on-top, skip-taskbar, non-resizable, no shadow; `set_ignore_cursor_events(true)`
  for click-through. Loads main entry with `?osd` so React renders `OsdOverlay`.
- **Routing:** `main.tsx` renders `<OsdOverlay/>` when `location.search` has `osd`, else `<App/>`.
- **Config store:** `src/store/osd.ts` (persisted) — enabled, style, scale, opacity,
  cornerRadius, position (corner), oledShift, and a `Set` of enabled metric keys.
- **Overlay data:** poll a single lightweight command (reuse get_sensors+get_metrics+gpu_oc_info,
  or add `osd_sample`) at ~2 Hz for low overhead; render compact, no heavy animation.
- **Config UI:** new NavRail tab "游戏监控/OSD" mirroring the reference (style + content tabs).
- **Low overhead:** overlay DOM minimal; interval polling (not rAF); GPU-cheap CSS; window
  hidden when disabled.
