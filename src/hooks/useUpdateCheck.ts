import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { api, type UpdateInfo, type UpdateProgressEvent, type UpdateStateEvent } from "../lib/ipc";
import { useSettings } from "../store/settings";
import { useUpdate } from "../store/update";

/** Don't check again within this window of the last completed auto-check. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Delay before the launch check fires. Startup is the app's busiest moment —
 * sampler, telemetry, ETW, sidecar, OSD and the store hydration all come up at
 * once — so the check waits for that to settle rather than adding a network
 * request to the pile.
 */
const LAUNCH_DELAY_MS = 5000;

/** Inputs to the "do we interrupt the user right now?" decision. */
export interface PromptContext {
  /** Version the user pressed 跳过此版本 on, if any. */
  skippedVersion: string | null;
  /** Whether the main window is on screen (false in tray / silent autostart). */
  windowVisible: boolean;
}

/** Inputs to the "may we check at all right now?" decision. */
export interface AutoCheckContext {
  autoCheckUpdates: boolean;
  /** Epoch ms of the last completed auto-check. */
  lastUpdateCheck: number;
  now: number;
}

/** Whether the debounce allows an automatic check right now. */
export function shouldAutoCheck(ctx: AutoCheckContext): boolean {
  if (!ctx.autoCheckUpdates) return false;
  return ctx.now - ctx.lastUpdateCheck >= CHECK_INTERVAL_MS;
}

/**
 * Whether to show the update modal for `info`.
 *
 * Pure and exported so the policy is testable without a backend — the rules it
 * encodes are the difference between a helpful notice and a nuisance:
 *
 * - **A game is in the foreground** → never. Stealing focus with a dialog
 *   mid-match is the worst possible moment, and the check simply runs again
 *   next launch.
 * - **The window is hidden** → never. With 关闭后保留到托盘 + 开机自启动 the app
 *   routinely starts with no window at all; a modal fired at it is a question
 *   nobody can see, let alone answer. The caller notifies instead.
 * - **The user skipped exactly this version** → never. Anything newer still
 *   prompts, so skipping is "not this one", not "never again".
 */
export function shouldPrompt(info: UpdateInfo, ctx: PromptContext): boolean {
  if (!info.available || !info.latestVersion) return false;
  if (info.gameForeground) return false;
  if (!ctx.windowVisible) return false;
  if (ctx.skippedVersion && ctx.skippedVersion === info.latestVersion) return false;
  return true;
}

/** Best-effort Windows notification — the fallback when there's no window to
 *  put a modal on. Never throws. */
async function notifyUpdate(version: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) {
      sendNotification({ title: "CorePilot", body: `新版本 ${version} 可用 — 打开 CorePilot 查看。` });
    }
  } catch {
    /* notifications unavailable — ignore */
  }
}

/**
 * Launch-time update check + the live progress channel.
 *
 * Mounted once from `App`. The check itself is a backend `async` command, so
 * nothing here touches the main thread; a dead or captive network resolves as a
 * rejection after the backend's own 15 s ceiling and is recorded, not thrown.
 */
export function useUpdateCheck(): void {
  useEffect(() => {
    let disposed = false;

    // Live install feedback. Registered before the check so a manual install
    // started from Settings is covered too.
    const unlisteners: Array<() => void> = [];
    void listen<UpdateProgressEvent>("update://progress", (e) => {
      useUpdate.getState().setProgress(e.payload.downloaded, e.payload.total);
    }).then((fn) => (disposed ? fn() : unlisteners.push(fn)));
    void listen<UpdateStateEvent>("update://state", (e) => {
      const { setPhase, setError, setInstalling } = useUpdate.getState();
      setPhase(e.payload.phase);
      if (e.payload.phase === "failed") {
        setError(e.payload.error ?? "更新失败");
        setInstalling(false);
      }
    }).then((fn) => (disposed ? fn() : unlisteners.push(fn)));

    const timer = setTimeout(() => {
      void runLaunchCheck();
    }, LAUNCH_DELAY_MS);

    return () => {
      disposed = true;
      clearTimeout(timer);
      for (const fn of unlisteners) fn();
    };
  }, []);
}

/** The launch check, split out so the delay above stays readable. */
async function runLaunchCheck(): Promise<void> {
  const s = useSettings.getState();
  if (!shouldAutoCheck({ autoCheckUpdates: s.autoCheckUpdates, lastUpdateCheck: s.lastUpdateCheck, now: Date.now() })) {
    return;
  }

  const info = await checkForUpdate();
  if (!info) return;

  // Anchor the debounce on a COMPLETED check only, so a week of failed checks
  // (offline laptop) doesn't silently consume the interval and leave the app
  // never noticing an update once the network comes back.
  useSettings.getState().update({ lastUpdateCheck: Date.now() });
  if (!info.available || !info.latestVersion) return;

  let windowVisible = true;
  try {
    windowVisible = await getCurrentWindow().isVisible();
  } catch {
    /* can't tell — assume visible; a spurious modal beats a silent miss */
  }

  const ctx: PromptContext = {
    skippedVersion: useSettings.getState().skippedVersion,
    windowVisible,
  };

  if (shouldPrompt(info, ctx)) {
    useUpdate.getState().openPrompt();
  } else if (!windowVisible && !info.gameForeground) {
    // No window to ask on, but this is still news worth surfacing once.
    await notifyUpdate(info.latestVersion);
  }
}

/**
 * Run a check and fold the outcome into the store. Shared by the launch check
 * and the Settings 检查更新 button so both report failures identically.
 * Returns the result, or null when the check failed.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const { checking, setChecking, setInfo, setError } = useUpdate.getState();
  if (checking) return null;
  setChecking(true);
  setError(null);
  try {
    const info = await api.updateCheck();
    setInfo(info);
    return info;
  } catch (e: unknown) {
    setInfo(null);
    setError(typeof e === "string" ? e : e instanceof Error ? e.message : "检查更新失败");
    return null;
  } finally {
    useUpdate.getState().setChecking(false);
  }
}

/**
 * Start the install. Resolves only on FAILURE — both flavors exit the app to
 * install, so a success never returns here (see `api.updateInstall`).
 */
export async function installUpdate(): Promise<void> {
  const { setInstalling, setError, setProgress } = useUpdate.getState();
  setInstalling(true);
  setError(null);
  setProgress(0, null);
  try {
    await api.updateInstall();
  } catch (e: unknown) {
    setError(typeof e === "string" ? e : e instanceof Error ? e.message : "更新失败");
    setInstalling(false);
  }
}
