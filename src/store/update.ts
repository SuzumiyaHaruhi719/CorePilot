import { create } from "zustand";
import type { UpdateInfo, UpdateStateEvent } from "../lib/ipc";

/**
 * Live self-update state. Deliberately NOT persisted — every field is about
 * this session (what the last check found, how far a download got). What must
 * survive a restart (auto-check on/off, the skipped version, the debounce
 * anchor) lives in `store/settings.ts` instead.
 *
 * Shared because two places need the same answer: the launch prompt in `App`
 * and the 更新 card in Settings. A manual check from the card therefore also
 * fills the prompt, and neither can run a second check while one is in flight.
 */
interface UpdateState {
  /** Result of the most recent check, or null if none has completed. */
  info: UpdateInfo | null;
  /** A check is in flight (guards against overlapping checks). */
  checking: boolean;
  /** An install is in flight — from the click until the app exits or fails. */
  installing: boolean;
  /** Last failure, ready to display. Cleared when a new attempt starts. */
  error: string | null;
  /** Latest phase reported by `update://state`. */
  phase: UpdateStateEvent["phase"];
  downloaded: number;
  total: number | null;
  /** Whether the update modal is on screen. */
  promptOpen: boolean;

  setChecking: (checking: boolean) => void;
  setInfo: (info: UpdateInfo | null) => void;
  setError: (error: string | null) => void;
  setInstalling: (installing: boolean) => void;
  setPhase: (phase: UpdateStateEvent["phase"]) => void;
  setProgress: (downloaded: number, total: number | null) => void;
  openPrompt: () => void;
  closePrompt: () => void;
}

export const useUpdate = create<UpdateState>()((set) => ({
  info: null,
  checking: false,
  installing: false,
  error: null,
  phase: "idle",
  downloaded: 0,
  total: null,
  promptOpen: false,

  setChecking: (checking) => set({ checking }),
  setInfo: (info) => set({ info }),
  setError: (error) => set({ error }),
  setInstalling: (installing) => set({ installing }),
  setPhase: (phase) => set({ phase }),
  setProgress: (downloaded, total) => set({ downloaded, total }),
  openPrompt: () => set({ promptOpen: true }),
  closePrompt: () => set({ promptOpen: false }),
}));
