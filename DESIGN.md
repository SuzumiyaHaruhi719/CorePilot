# CorePilot — "Instrument" design language

A precision instrument, not a gaming dashboard. Calm carbon surfaces, hairline
structure, DIN numerals, and color that always *means* something.

## Principles

1. **Color is signal.** One accent (`--acc`, user-selectable) for intent: selection,
   focus, primary action, the active nav bar. Each metric owns one signal color
   everywhere — app, OSD plate, taskbar plate, charts:
   CPU `--cpu` ember · GPU `--gpu` mint · RAM `--mem` sky · Disk `--disk` amber · Net `--net` orchid · FPS `--fps` bone.
   Status: `--ok` / `--warn` / `--crit`. Nothing else gets saturated color.
2. **Numbers are the hero.** Live values use Bahnschrift (Windows' DIN) with
   tabular numerals (`.num`, `.readout`); condensed width for big readouts.
   Units are typeset smaller and dimmer than the value.
3. **Structure by hairlines, not boxes.** Panels are flat with a 1 px `--line`
   border. Hero panels get crop-mark corners (`.ticks`) — the one ornament.
4. **The UI is alive, never noisy.** Motion conveys change: rolling digits on
   values, scopes that glide one sample left per tick, a spring-tracked nav
   indicator, staged page reveals. Anything that updates faster than ~1 Hz
   (scan counters) stays plain text.
5. **Chinese-first.** Every string is `t(zh, en)`; layouts assume CJK widths.

## Tokens (`src/styles.css`)

| Token | Use |
|---|---|
| `--bg` / `--bg-rail` / `--panel` / `--panel-2` / `--raise` | surface ladder, darkest → lightest |
| `--line` / `--line-2` / `--line-3` | hairlines: structure / controls / emphasis |
| `--ink` / `--ink-2` / `--ink-3` / `--ink-4` | text: primary / secondary / labels / disabled |
| `--acc`, `--acc-soft`, `--acc-line` | accent fill / tint / outline |
| `--grid` | chart graticule |
| `--ease` / `--spring` | `cubic-bezier(.2,.8,.2,1)` / expo-out `(.22,1,.36,1)` — no overshoot |

Themes: `[data-theme=dark]` "Carbon" (default), `[data-theme=light]` "Bone".
Accents: `[data-accent=violet|ember|mint|sky]`.

Type: UI `Segoe UI Variable Text` → `Microsoft YaHei UI`; numerals/labels
`Bahnschrift`; paths/PIDs `Cascadia Mono`. Labels (`.label`) are 10.5 px,
uppercase, 0.14em tracking.

Radii: 4 (tags, small buttons) · 6 (controls) · 10 (panels). Spacing on a
4 px base; panels pad 16/18, grids gap 14.

## Components (`src/ui/kit.tsx`)

- `Roll` — odometer digits (CSS transform strips, 700 ms expo-out).
- `Scope` — canvas oscilloscope; rAF runs only while a glide is in flight and
  never while the window is hidden/occluded or reduce-motion is on.
- `Panel` / `PageHead` / `Page` — staggered reveal via Motion variants.
- `Seg` (spring thumb), `Switch`, `Range` (filled track via `--p`), `Field`
  (title / description / control row), `Meter`, `Spark`, `VList`, `confirmDialog`.
- `Chart` (`src/ui/Chart.tsx`) — uPlot themed from CSS vars, synced cursors.

## Shell

Titlebar (drag region, live GAME / REC pills, Ctrl K palette) · left rail whose
nav items carry live readouts (the navigation is itself a dashboard) · status
ticker · toasts bottom-right with a life bar. Ctrl+1…9 jumps sections.

## Motion rules

- Transform/opacity only; no layout-property animation.
- Durations: 140 ms (hover), 200–260 ms (state), 380–420 ms (reveals, treemap zoom).
- `reduceMotion` (Settings) sets `[data-motion=reduced]` (kills CSS motion) and
  `MotionConfig reducedMotion="always"` (kills JS motion).
