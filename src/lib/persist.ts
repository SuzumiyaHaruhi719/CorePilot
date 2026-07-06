import { invoke } from "@tauri-apps/api/core";
import type { StateStorage } from "zustand/middleware";

/**
 * Durable, file-backed persistence for all zustand stores.
 *
 * WebView2's `localStorage` is buffered by Chromium and only flushed to disk
 * periodically / on graceful close, so a crash or hard kill loses recent
 * writes. We previously used `tauri-plugin-store`, but its `save()` is a
 * non-atomic truncate-then-write: a hard reset landing mid-write corrupted
 * `corepilot.store.json` and silently wiped every profile/group/setting on
 * the next launch. The backend now owns the IO (`src-tauri/src/persist.rs`):
 * same file, same format, but atomic writes + a last-known-good backup that
 * is auto-restored when the live file is corrupt or missing.
 *
 * All stores share one file, keyed by their persist `name`. On first read of
 * a key, we migrate any value left behind by the old localStorage persistence
 * so pre-plugin-store settings are still preserved.
 */
export const tauriStorage: StateStorage = {
  getItem: async (name) => {
    const value = await invoke<string | null>("persist_get", { name });
    if (value != null) return value;
    // One-time migration from the previous localStorage-based persistence.
    try {
      const legacy = localStorage.getItem(name);
      if (legacy != null) {
        await invoke("persist_set", { name, value: legacy });
        return legacy;
      }
    } catch {
      /* localStorage unavailable — ignore */
    }
    return null;
  },
  setItem: async (name, value) => {
    await invoke("persist_set", { name, value });
  },
  removeItem: async (name) => {
    await invoke("persist_delete", { name });
  },
};
