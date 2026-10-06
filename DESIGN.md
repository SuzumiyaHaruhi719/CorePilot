# CorePilot Design System — "Instrument"

CorePilot reads like a precision bench instrument native to Windows 11: calm chrome, exact numbers, one signal color. Strategy and principles live in `PRODUCT.md`; this file is the visual contract. Tokens and utilities: `src/index.css`. Primitives: `src/components/ui/*`. Reference implementation: `src/tabs/GpuTune.tsx`.

## Layers (darkest → lightest in dark themes)

| Token | Role |
|---|---|
| `chrome` | Title bar, sidebar, status strip (the window frame) |
| `base` | The content canvas (rounded top-left, like Windows 11 Settings) |
| `surface` | Panels (`.glass` / `<Panel>`) |
| `surface2` | Controls, inputs, hover fills, nested groups |
| `surface3` | Pressed / selected-neutral, meter tracks |
| `elevated` | Floating layers only (`.float`: menus, popovers, dialogs) |
| `line` / `line-strong` | Hairlines (1px). Grouping is done with these, not boxes |

Ink: `ink` (primary), `muted` (secondary, ≥4.5:1), `dim` (tertiary/labels/units — never body copy).

## Color — meaning only

- `accent` = action, selection, focus, the primary metric (CPU). Never decoration. ≤10% of any screen.
- Data series (fixed across the app): CPU `accent` · memory `cyan` · GPU `vcache` · disk `freq` · power `warn` · V-Cache CCD `vcache` · frequency CCD `freq`. Group colors come from `lib/colors.ts`.
- State: `ok` (running/healthy), `warn` (attention), `danger` (destructive/critical). Always paired with text or an icon.
- Text on an accent fill uses `text-on-accent` (light/dark varies per preset). Never hard-code white.
- Six presets (石墨 graphite default, 午夜, 终端, 赛博朋克, 瓷白, 砂岩) only swap token values. Components never branch on theme.

## Type — all native Windows, zero web fonts

| Use | Face | Class |
|---|---|---|
| UI text, labels, Chinese | Segoe UI Variable Text + Microsoft YaHei UI | default (`font-sans`) |
| Page / dialog titles | Segoe UI Variable Display | `font-title` |
| Every number, unit, short Latin readout | Bahnschrift (DIN 1451), tabular | `.nums` (dense: `.nums-tight`) |
| PIDs, masks, paths, command lines | Cascadia Mono | `font-mono` |

Scale (fixed px, ratio ~1.15): 11 · 11.5 · 12 · 12.5 · 13 (body) · 15 · 20 (page title, md readout) · 28 (lg readout, light) · 40 (xl readout, light). Labels are sentence case. No uppercase-tracked eyebrows, no letter-spaced Latin.

## Spacing & shape

- Page: `TabHeader` (`px-6 pt-5 pb-4`) → optional `SecondaryTabs` → scroll body `px-6 pb-6`, `space-y-4` between panels.
- Panel padding 16px; rows inside panels separated by `border-t border-line` with `py-3.5`–`py-4`.
- Radii: controls `rounded-md` (6) / `rounded-lg` (8), panels `rounded-xl` (10), floating `rounded-2xl` (12).
- Control heights: 28 (`size="sm"`), 32 (default), fields 30.

## Components (use these; don't fork their styles per tab)

- `TabHeader` — title + subtitle + actions. No icon tile.
- `Panel` — the one container (`title`, `desc`, `actions`, `flush`). Never nest a Panel in a Panel.
- `Readout` — label over a Bahnschrift value with unit/sub (`size` sm/md/lg/xl, `color` for data hue). Missing value renders "—".
- `Meter` — 4px usage bar, compositor-animated.
- `Badge` — small status label (`tone`, optional `dot`).
- `Button` — `primary` (one per view) · `ghost` (secondary, default) · `subtle` (text) · `danger`; `size` sm/md.
- `Toggle` (Win11 switch), `Segmented` (gliding thumb), `SecondaryTabs` (gliding underline), `RangeInput` / `Slider`, `Modal`, `ContextMenu`, `ColorPicker`.
- CSS utilities: `.field` (inputs/selects/search), `.skeleton` (loading), `.live-dot` (live indicator), `.float` (floating layer).

## Patterns

- **Instrument cluster** (replaces hero-metric tile grids): one `Panel flush`, readouts in a grid of hairline-divided cells (`border-l border-t border-line` + `-ml-px -mt-px` on the grid, `overflow-hidden` wrapper). See GpuTune `Cell`.
- **Setting / tuning row**: title + one-line description left; value, then control right; optional rail below. Rows separated by hairlines inside one Panel.
- **Lists & tables**: Panel `flush`; header row 11.5px `text-dim` font-medium; rows 32–36px; hover `bg-surface2/60`; selected `bg-accent/10`; numbers right-aligned `.nums`; no zebra stripes.
- **Selection lists**: radio-style rows (filled accent dot when active), delete affordance revealed on hover/focus.
- **Banners**: `rounded-lg bg-{tone}/10 text-{tone} ring-1 ring-inset ring-{tone}/25`, icon + sentence + actions. Never a colored side stripe.
- **Empty states**: one icon (22px), one line of what's missing, one line of how to fix it, optional action.
- **Loading**: `.skeleton` blocks shaped like the content; spinners only inside buttons.

## Motion

- House curve: exponential ease-out (`easeOut` in `lib/motion.ts`). Springs are critically damped (`springSmooth`, bounce 0).
- 150–250 ms for state changes; exits ~half the enter. Page switch: 200 ms fade + 6px rise.
- What moves: selection indicators (nav pill, segmented thumb, tab underline), toggles, popover/dialog entrances, values (`AnimatedNumber`), meters, the theme-switch reveal.
- What doesn't: hover lifts/scales, ripples, idle pulsing, decorative loops. Press feedback is `scale 0.97` at most.
- Everything respects the in-app 减弱动画 switch (MotionConfig + `data-reduce-motion`) and pauses while the window is hidden (`data-ui-idle`).

## Bans

Gradient text · colored side-stripe borders · glow on resting elements · corner-tick frames / chamfers · uppercase tracked eyebrows (`· MEMORY`, `ACTIONS`) · icon tiles on every heading · identical icon-card grids · hero-metric tiles · cards inside cards · hover lift/scale · bounce/elastic easing · display fonts in labels · raw hex in components · color-only state.

## i18n

User-visible strings are Chinese source strings run through `t()` (dictionary) or `tf(zh, en)` (inline). New copy uses `tf`.
