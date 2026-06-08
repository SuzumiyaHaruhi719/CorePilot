import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { OsdOverlay } from "./osd/OsdOverlay";
import "./index.css";

// The transparent overlay window loads the same bundle with `?osd`; render only
// the lightweight overlay there (and make the page background transparent).
const isOsd = new URLSearchParams(window.location.search).has("osd");
if (isOsd) document.documentElement.classList.add("osd-window");

// Global safety net: log any uncaught error/rejection to the console (visible in
// the dev terminal / WebView devtools) and, for the main window, surface a fatal
// error on-page instead of failing to a silent blank screen.
function logFatal(label: string, detail: string) {
  // eslint-disable-next-line no-console
  console.error(`[CorePilot] ${label}\n${detail}`);
  if (isOsd) return; // never paint an error plate over the transparent overlay
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isOsd ? <OsdOverlay /> : <App />}</React.StrictMode>,
);
