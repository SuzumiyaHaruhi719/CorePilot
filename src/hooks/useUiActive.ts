import { create } from "zustand";

interface UiActiveState {
  /** True while the UI is worth spending frames on. */
  active: boolean;
  setActive: (active: boolean) => void;
}

/**
 * The single "is anyone actually looking at the UI?" flag.
 *
 * Everything that burns frames purely for the user's benefit (spring
 * animations, chart redraws, continuous CSS motion) gates on this ONE store, so
 * the whole app can go quiet together the moment the window is hidden,
 * minimized or fully covered by a fullscreen game. A WebView2 that keeps
 * springing numbers behind a game still costs renderer + gpu-process time —
 * that is the background cost users blamed on CorePilot while gaming.
 *
 * Deliberately NOT persisted and deliberately `true` by default: this is pure
 * session state derived from live window events, and a store that loaded back
 * `false` (or sat `false` before the visibility watcher has reported once)
 * would leave the UI frozen on stale numbers with no way to recover. Until the
 * window-visibility watcher wires `setActive`, `active` stays true and every
 * consumer behaves exactly as it did before this store existed.
 */
export const useUiActive = create<UiActiveState>()((set) => ({
  active: true,
  // Skip the notify when nothing changed: the visibility watcher re-reports the
  // same state on every window event, and each real change re-renders (and
  // restarts the springs of) every gated component. zustand's setState bails out
  // entirely when the updater returns the current state object.
  setActive: (active) => set((s) => (s.active === active ? s : { active })),
}));
