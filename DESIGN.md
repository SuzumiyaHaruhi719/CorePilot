# CorePilot — design system

An instrument with a pulse: live numbers are the hero, color always means
something, surfaces have texture and light, and the app visibly *responds* — to
the machine's state and to every optimization — without costing frames while
hidden. "No AI slop" means no clichés, not a stripped-down UI.

## Principles

1. **Theme styles, one token set.** Six presets via `[data-style]` on `<html>`:
   赛博朋克 cyberpunk · 午夜 midnight (default) · 石墨 graphite · 终端 terminal ·
   瓷白 porcelain · 砂岩 sandstone. Each defines surfaces, ink, lines, the accent
   (`--acc`/`--acc-2`, `--on-acc` for text on accent) and the per-metric palette.
2. **Color is signal.** Each metric owns one color per style — `--fps --cpu --gpu
   --mem --disk --net` — shared by the app, the OSD plate, the injected overlay
   and the taskbar plate (`lib/themes.ts` `PALETTE`). Canvas colors are hex.
3. **Texture, never flat.** Every surface carries a top sheen (`--sheen`) — no
   noise grain (it turns into 2×2 speckle on high-DPI screens); panels are slightly translucent
   (`--panel-a`) over the ambient light with soft depth (`--panel-shadow`). Each
   style has its own texture identity in `--tex` (`.app::after`): stars (午夜),
   neon grid + scanlines (赛博朋克), brushed metal (石墨), phosphor scanlines +
   dots (终端), dot grid (瓷白), linen (砂岩).
4. **The machine has a mood.** `lib/boot.ts moodOf` → `calm | busy | game | hot`
   (with hysteresis) on `<html data-mood>`; `--mood` (a registered color that
   transitions) tints the ambient light, the titlebar seam, the Overview orb.
5. **Glow is a dial.** Everything luminous scales with `--glow-o`
   (Settings → 光晕强度: off / soft / medium / intense).
6. **Numbers are the hero.** Bahnschrift (Windows' DIN) with tabular numerals;
   readouts spring-tween (`AnimatedNumber`), the FPS hero rolls (`Roll`).
7. **Chinese-first, warm voice.** Every string is `t(zh, en)`; the Overview greets
   by time of day and says how the machine is doing.

## Motion & feedback

- Ambient: three slow light blobs (`.ambient`) + twinkling stars on 午夜 —
  transform/opacity only; paused hidden (`[data-live="0"]` pauses every CSS
  animation), in low-GPU mode, under reduced motion and with frosted glass on.
- Hover light (`.rv`): a glow + lit edge follows the pointer on interactive
  surfaces (nav, tiles, cards, list items). Shell writes `--mx/--my`.
- Nav rail: lit spring pill (`layoutId`), glowing active icon, icon lift.
- Pages: staged reveals (`Page`, `Panel`, `swapVariants`), direction follows the
  rail; sub-views slide toward the tab you picked (AnimatePresence `custom`).
- Lists: re-sorting animates for a moment (`VList flip`) — rows glide, newly
  revealed rows cascade; scrolling and live re-sorts never animate.
- **Optimizations always celebrate** (`ui/fx.ts`): `celebrate(el, power)` = sparks
  + shockwave on one self-removing canvas, and a light sweep over the `.fx-card`.
  一键优化 (`ui/OneClick.tsx`) is the signature: light orbits the border while it
  runs, each step chip lights and sparks as it lands, then a burst and the
  results count up. `AsyncButton fx` gives any optimization button the check +
  sparks moment; tweak switches and 核心优化 spark when turned on.
- Theme switch: View Transition wash from the click point (`setStyle`).
- `reduceMotion` sets `[data-motion=reduced]` and `MotionConfig reducedMotion="always"`;
  effects become no-ops.

## Layout

- Shell: 46 px titlebar (drag region, GAME/REC pills, Ctrl K palette, mood seam) ·
  92 px icon rail (icon + label, live badges, CPU/GPU/RAM rings when height
  allows) · status ticker. Chrome is translucent over the ambient light.
- Page heads: a section emblem tile (the nav icon) + title + subtitle; Overview
  replaces it with the greeting hero and the living-core orb.
- Spacing: page 24/32 px, grid gap 18, panel padding 20/22, radii 4 / 6 / 8 / 12.
- Charts: big live scopes (`Scope`), and Task-Manager-style framed mini graphs
  (`Mini`, fixed window, samples enter at the right) for per-core / per-engine.

## OSD plate

Single horizontal row by default (column optional), grouped by device in the
fixed order FPS · CPU · GPU · RAM · DISK · NET, six dock positions (tl tc tr bl
bc br), background opacity 0–100 %, optional rounding, labels in the style's
metric palette. The studio is the target monitor in miniature (true scale).

## Taskbar plate

Native Win32 (`taskbar_mon.rs`). Per device: the label stands vertically
(letters stacked upright — C / P / U — in the device colour) beside its readings in two calm white rows;
single-line mode falls back to a horizontal label. Settings shows a live mock.
