# CorePilot — Design System (MASTER) · Premium Gaming HUD

> Single source of truth for the UI redraw. Every page/component MUST follow this.
> Generated with ui-ux-pro-max (style: Retro-Futurism/Cyberpunk-HUD, Gaming palette,
> Orbitron + JetBrains Mono) and tuned for **premium restraint** (a refined cockpit
> HUD — NOT a loud arcade CRT).

## North star
"一眼就知道这是为游戏而生的优化软件,同时透出高级感。"
- **Gaming cues**: deep indigo-black HUD, neon-violet/cyan accents, telemetry framing
  (gauges, grids, mono numbers, corner ticks), subtle scanline/grid backdrop, glow on
  active/live elements.
- **Premium restraint**: lots of negative space, ONE primary accent per view, glow used
  sparingly (live data + active state only), consistent radii & spacing, smooth spring
  motion. No rainbow soup, no glitch spam, no emoji.

## Color tokens (dark only — defined in `src/index.css` `@theme`, OKLCH)
| Token | Use |
|---|---|
| `--color-base` ≈ #0B0B16 | app background (deepest) |
| `--color-surface` ≈ #13132099 | cards / panels |
| `--color-surface2/3` | nested surfaces, controls |
| `--color-accent` violet `#7C3AED` / `--color-accent-bright` | primary accent, active nav, primary CTA, live data |
| `--color-rose` `#F43F5E` | secondary/energy accent + destructive emphasis |
| `--color-cyan` / `--color-vcache` (teal) / `--color-freq` (amber) | telemetry hues (GPU/CCD/freq) |
| `--color-ok` green / `--color-warn` amber / `--color-danger` red | semantic states |
| `--color-ink / muted / dim` | text hierarchy |
| `--color-line / line-strong` | hairline borders |

Rules: semantic tokens only (no raw hex in components). One primary accent per screen;
rose is for energy highlights / destructive. Telemetry hues map consistently (GPU=cyan,
V-Cache=teal, freq=amber, power=amber/lime, temp=green→amber→red).

## Typography
- `--font-display` = **Orbitron** (700/900) — brand wordmark, big section/stat titles,
  Latin + numbers ONLY (no Chinese coverage). Use UPPERCASE + letter-spacing for HUD labels.
- `--font-mono` = **JetBrains Mono** (400/500) — ALL telemetry numbers, RPM/°C/MHz/%/FPS,
  tabular (`.nums`). 
- `--font-sans` = Inter + Microsoft YaHei/PingFang — all body & Chinese UI text.
- Scale: 11/12/13/14/16/20/28/40. Body 13-14, line-height 1.5. Labels 500, headings 600-700.
- HUD micro-labels: 10-11px, UPPERCASE, tracking-wide, `--color-dim`, often Orbitron/mono.

## Effects (utilities in index.css)
- `.glass` glassmorphism panel (translucent surface + soft shadow + hairline).
- `.glow` / `.glow-sm` / `.glow-text` — neon glow; ONLY on active nav, live values, primary CTA.
- `.hud-frame` — corner-tick framed panel (4 L-shaped corner accents) for "instrument" feel.
- `.chamfer` — clipped/angled top-right corner for tech edge (use sparingly on key panels).
- `.scanlines` / animated grid backdrop — very low opacity (≤6%), behind content only.
- Radii: cards `--radius-2xl` (22) / panels xl (18) / controls 10-12. Keep consistent.

## Motion (Motion/React + tokens)
- 150–260ms micro, ≤400ms transitions. Spring for entrances/active pills.
- ease-out enter, ease-in exit; exit ~65% of enter. Stagger lists 30–50ms.
- Animate transform/opacity only. Respect the in-app 减弱动画 setting (MotionConfig).
- Every animation conveys cause→effect (press scale 0.96–1.04, tab slide, value tick).

## Interaction logic (UX) — "顺便优化交互逻辑"
- Every clickable: `cursor-pointer`, visible hover + pressed (scale/opacity/glow) + focus ring.
- One **primary CTA** per view; secondary actions visually subordinate.
- Async actions: disable + spinner; success/error feedback near the control (toast 3-5s).
- Destructive/dangerous: confirm + danger color + spatially separated (see Tuning danger zone).
- Live values use mono tabular figures (no layout shift); unavailable = "—", never faked.
- Loading >300ms → skeleton/shimmer, not a bare spinner. Empty states give guidance.
- Keyboard: Enter submits, Esc cancels/closes; toggles & sliders reachable.

## Shell layout
- Custom **TitleBar**: Orbitron `CorePilot` wordmark + glow + accent mark; window controls right.
- **NavRail** (left, 88px): icon + label per tab; active = glowing pill + left accent bar + Orbitron-ish label; hover pop. Sections: 核心分配/任务管理器/监控/游戏OSD/GPU/风扇/优化/深度优化/设置.
- **StatusBar** (bottom): live telemetry strip (CPU/RAM/…) in mono, with a subtle HUD divider.
- Page transitions: directional slide + fade (forward up, back down).

## Component contract (shared, in `src/components/ui/*` — DO NOT fork styles per tab)
`Button` (primary/ghost/danger, sizes, loading), `Toggle`, `Slider` (.cp-slider), `Segmented`
(glowing active pill), `Modal` (scrim 50-60%, animate from trigger), `TabHeader` (icon + Orbitron
title + subtitle), `StatTile`/`ControlCard` (HUD-framed), `ContextMenu`. Reuse these everywhere.

## Per-page intent
- **核心分配 (cores)**: flagship — CCD/core grid as a "core map" HUD, group chips with color, live per-core heat.
- **任务管理器 (taskmgr)**: dense data tables, mono numbers, sortable, GPU engine columns.
- **监控 (monitor)**: big gauges + sparklines, HUD instrument cluster vibe.
- **游戏OSD (osd)**: overlay config with live WYSIWYG preview plate.
- **GPU**: tuning dials/sliders + live readout tiles (Afterburner-grade).
- **风扇 (fans)**: fan channel cards + draggable curve editor (already built; restyle to HUD).
- **优化 / 深度优化 (optimize/tuning)**: action cards; tuning keeps SAFE (green) vs DANGER (red) zones with confirm.
- **设置 (settings)**: grouped preference rows.

## Avoid
Emoji icons, raw hex in components, glow everywhere, full CRT scanlines, glitch spam, color-only
meaning, layout-shifting hovers, >500ms animations, horizontal scroll, gray-on-gray text.
