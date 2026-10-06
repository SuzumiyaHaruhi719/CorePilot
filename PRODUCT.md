# Product

## Register

product

## Users

PC enthusiasts and gamers on Windows 11 (Chinese-first, English second) who own high-end hardware — multi-CCD Ryzen X3D / Intel hybrid CPUs, big NVIDIA cards, boards with controllable fan headers. CorePilot runs elevated and 24/7: usually parked on a second monitor or in the tray while a game runs, glanced at mid-session, then opened deliberately to tune something (pin a game to the V-Cache CCD, shape a fan curve, offset GPU clocks) or to read a post-game performance report. Often a dim room lit by monitors.

## Product Purpose

One trustworthy cockpit for a gaming PC: a task manager that knows the CPU topology, live telemetry, an in-game OSD, GPU and fan tuning, one-click cleanup, and a disk analyzer. Success is the user trusting the numbers enough to act on them, and the app staying invisible (cheap, quiet, never stuttering the game) when not in use.

## Brand Personality

Precise, calm, expert. A bench instrument, not an arcade cabinet. Confidence comes from exact numbers and restraint, not neon. It should feel native to Windows 11 and as dependable as the hardware it measures.

## Anti-references

- Gaming-peripheral software (Armoury Crate, Synapse, iCUE): neon glow, angular chamfers, display fonts in labels, RGB gradients.
- The previous CorePilot "Premium Gaming HUD": Orbitron labels, corner-tick frames, glow on everything, uppercase tracked eyebrows, gradient icon tiles on every header.
- Generic SaaS dashboards: hero-metric tiles with gradient accents, identical icon-card grids, cards nested in cards.

## Design Principles

1. **Numbers are the interface.** Telemetry carries the typographic hierarchy; chrome recedes.
2. **Color means something.** Neutral chrome, one accent for action/selection, fixed hues per data series, ok/warn/danger only for state.
3. **Structure over containers.** Alignment and hairlines group things; a panel is earned, never nested.
4. **Motion confirms state.** Short, ease-out, no bounce, no hover theatrics; nothing animates while nobody is looking.
5. **Native first.** Windows 11 conventions (caption buttons, Segoe, Bahnschrift) over invented chrome.

## Accessibility & Inclusion

WCAG 2.2 AA contrast for text in every theme preset (light and dark). Every interactive element keyboard-reachable with a visible focus ring. In-app 减弱动画 (reduce motion) switch is the motion authority (users often disable Windows animations but still want app motion). State is never color-only: pair dots/hues with text or icons. Bilingual layouts must survive longer English strings.
