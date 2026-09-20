import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { OsdOverlay } from "./osd/OsdOverlay";
import { useOsd, useOsdTargets } from "./store/osd";
import { useSettings, type Theme, type ThemeStyle } from "./store/settings";
import "./index.css";

// The transparent overlay window loads the same bundle with `?osd` (corner/free
// OSD); render only the lightweight overlay there and make the page background
// transparent. (The taskbar monitor is a native GDI window — see
// src-tauri/src/taskbar_mon.rs — not a webview, so it has no entry here.)
const params = new URLSearchParams(window.location.search);
const isOsd = params.has("osd");
const isOverlay = isOsd;
if (isOverlay) {
  document.documentElement.classList.add("osd-window");

  // The OSD webview MIRRORS the config; it must never author it. The config
  // panel lives in the main webview and pushes edits here as `osd:cfg` /
  // `osd:targets` events, which OsdOverlay applies with `setState` — and
  // zustand's persist middleware writes the whole key on EVERY setState. So
  // each event turned into a `persist_set` from this window too: the preview
  // drag in OsdConfig.tsx emits one event per pointer move *precisely to avoid*
  // store writes, and this window then wrote the store on every move, with the
  // two webviews racing to clobber the same key with each other's stale state.
  // Swapping in a no-op storage kills the write path only: the stores' initial
  // hydrate() already fired at module-eval (above) with the real storage, and
  // zustand reads `storage` lazily per write, so the config still loads from
  // disk and only the writes become no-ops.
  const noopStorage: StateStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  useOsd.persist.setOptions({ storage: createJSONStorage(() => noopStorage) });
  useOsdTargets.persist.setOptions({ storage: createJSONStorage(() => noopStorage) });
  useSettings.persist.setOptions({ storage: createJSONStorage(() => noopStorage) });

  // App (which owns the theme effect) never mounts in the OSD webview, so apply
  // the persisted theme to this window's <html> here — then the overlay's accent
  // tokens match the chosen theme. The main window emits "osd:theme" on a theme
  // change (and on mount) so an already-open OSD recolors live.
  const applyOsdTheme = (theme: Theme, themeStyle: ThemeStyle) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeStyle = themeStyle;
  };
  // Read the two strings straight out of the store file instead of importing
  // `store/settings`: pulling that module in would hydrate AND subscribe a
  // second copy of the settings store inside this window (another persist_get,
  // another write path racing the main window) just to read a theme. Key and
  // envelope come from src/store/settings.ts (`name: "corepilot-settings"`) and
  // src/lib/persist.ts (`{ state, version }`); `theme`/`themeStyle` have existed
  // since v1, so the blob is readable without running the store's `migrate`.
  void invoke<string | null>("persist_get", { name: "corepilot-settings" })
    .then((raw) => {
      const s = raw
        ? (JSON.parse(raw) as { state?: Partial<{ theme: Theme; themeStyle: ThemeStyle }> }).state
        : undefined;
      // Fall back to the store's own defaults, so a first run with nothing
      // persisted paints exactly what the main window would — leaving
      // data-theme-style unset would drop the graphite accent overrides.
      applyOsdTheme(s?.theme ?? "dark", s?.themeStyle ?? "graphite");
    })
    // A missing/corrupt blob must never leave the overlay unthemed (or throw
    // into the unhandledrejection net below, which is silent for the overlay).
    .catch(() => applyOsdTheme("dark", "graphite"));

  void listen<{ theme: Theme; themeStyle: ThemeStyle }>("osd:theme", (e) =>
    applyOsdTheme(e.payload.theme, e.payload.themeStyle),
  );
}

// Global safety net: log any uncaught error/rejection to the console (visible in
// the dev terminal / WebView devtools) and, for the main window, surface a fatal
// error on-page instead of failing to a silent blank screen.
function logFatal(label: string, detail: string) {
  // eslint-disable-next-line no-console
  console.error(`[CorePilot] ${label}\n${detail}`);
  if (isOverlay) return; // never paint an error plate over a transparent overlay
  const el = document.getElementById("root");
  if (el && !el.querySelector("[data-fatal]")) {
    // Build the error plate with safe DOM APIs. The label/detail are set via
    // `textContent` so an attacker-controlled error message can NEVER be parsed
    // as HTML (this webview is elevated and can call privileged `invoke`).
    const pre = document.createElement("pre");
    pre.setAttribute("data-fatal", "");
    pre.style.cssText =
      "color:var(--color-danger);background:var(--color-surface);padding:16px;white-space:pre-wrap;font:12px ui-monospace,monospace;height:100%;overflow:auto;margin:0";
    pre.textContent = `CorePilot — ${label}\n\n${detail}`;
    el.replaceChildren(pre);
  }
}
window.addEventListener("error", (e) => logFatal(e.message, (e.error && e.error.stack) || ""));
window.addEventListener("unhandledrejection", (e) =>
  logFatal("Unhandled rejection", String((e.reason && e.reason.stack) || e.reason)),
);

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (isOsd) {
  root.render(
    <React.StrictMode>
      <OsdOverlay />
    </React.StrictMode>,
  );
} else {
  // App is loaded ONLY by the main window, via a dynamic import so Vite emits it
  // as its own chunk. A static `import App from "./App"` put the entire app graph
  // in the shared entry chunk, so the transparent OSD webview parsed and ran all
  // of it — tabs → PerfHistory → store/perfHistory (which hydrates the ~22 MB
  // history key over IPC) plus the group/fan-profile/autotune/tweak/gpu-profile
  // stores it never uses — at startup AND again on every GDI recycle of that
  // window (see src-tauri/src/osd.rs), on the main thread's window-create path.
  void import("./App")
    .then(({ default: App }) =>
      root.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      ),
    )
    // Without this a failed chunk fetch leaves the boot splash on screen forever
    // (a dynamic import's rejection is a rejected promise, not a window error).
    .catch((e: unknown) =>
      logFatal("Failed to load app", String((e instanceof Error && e.stack) || e)),
    );
}
