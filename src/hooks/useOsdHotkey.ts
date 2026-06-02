import { useEffect } from "react";
import type { ShortcutEvent } from "@tauri-apps/plugin-global-shortcut";
import { api } from "../lib/ipc";
import { useOsd } from "../store/osd";

/** Global accelerator that toggles the in-game OSD overlay. */
const OSD_HOTKEY = "CommandOrControl+Shift+F10";

/**
 * Registers a process-wide hotkey (Ctrl+Shift+F10) to toggle the OSD overlay,
 * so it can be flipped on/off without leaving a fullscreen / borderless game.
 * Mirrors the config panel's toggle: flips the persisted `enabled` flag and
 * shows/hides the overlay window.
 *
 * The global-shortcut plugin is loaded **dynamically inside the effect** (not a
 * static top-level import) and wrapped in try/catch, so if the plugin can't be
 * loaded/registered it degrades silently — it can never crash the app at render.
 * The binding is released on unmount.
 */
export function useOsdHotkey(): void {
  useEffect(() => {
    let dispose = () => {};
    void (async () => {
      try {
        const gs = await import("@tauri-apps/plugin-global-shortcut");
        await gs.register(OSD_HOTKEY, (event: ShortcutEvent) => {
          // Fire once per physical press, not on the paired "Released" event.
          if (event.state !== "Pressed") return;
          const next = !useOsd.getState().enabled;
          useOsd.getState().setEnabled(next);
          api.osdSetVisible(next).catch(() => {});
        });
        dispose = () => {
          gs.unregister(OSD_HOTKEY).catch(() => {});
        };
      } catch {
        /* plugin unavailable (e.g. accelerator already claimed, or not loadable)
           — the hotkey is simply disabled; the rest of the app is unaffected. */
      }
    })();
    return () => dispose();
  }, []);
}
