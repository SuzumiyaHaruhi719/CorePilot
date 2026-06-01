import { LazyStore } from "@tauri-apps/plugin-store";
import type { StateStorage } from "zustand/middleware";

/**
 * Durable, file-backed persistence for all zustand stores.
 *
 * WebView2's `localStorage` is buffered by Chromium and only flushed to disk
 * periodically / on graceful close, so a crash or hard kill loses recent
 * writes — which broke "settings auto-save". `tauri-plugin-store` writes to a
 * JSON file and we `save()` on every change, so each setting is persisted
 * immediately and survives crashes.
 *
 * All stores share one file, keyed by their persist `name`. On first read of a
 * key, we migrate any value left behind by the old localStorage persistence so
 * existing settings / groups / GPU profiles are preserved.
 */
const store = new LazyStore("corepilot.store.json");

export const tauriStorage: StateStorage = {
  getItem: async (name) => {
    const value = await store.get<string>(name);
    if (value != null) return value;
    // One-time migration from the previous localStorage-based persistence.
    try {
      const legacy = localStorage.getItem(name);
      if (legacy != null) {
        await store.set(name, legacy);
        await store.save();
        return legacy;
      }
    } catch {
      /* localStorage unavailable — ignore */
    }
    return null;
  },
  setItem: async (name, value) => {
    await store.set(name, value);
    await store.save();
  },
  removeItem: async (name) => {
    await store.delete(name);
    await store.save();
  },
};
