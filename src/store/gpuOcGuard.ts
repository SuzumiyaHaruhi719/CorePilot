import { create } from "zustand";

/**
 * "The startup auto-apply of the GPU overclock was skipped, and why."
 *
 * Set once at launch by App.tsx from `gpu_oc_startup_check`
 * (src-tauri/src/gpu_guard.rs), read by the GPU page to offer a deliberate
 * re-apply. See that module for the full story; the short version is that the
 * machine died twice right after a startup re-arm of a 600 W / +120 MHz profile,
 * and the user could not reach the toggle before the app re-armed it again.
 *
 * NOT PERSISTED, on purpose — and this is the whole design, not an oversight.
 * A marker that outlives the process would survive every ordinary Windows
 * restart (which kills CorePilot outright) and nag the user after each one. The
 * evidence lives in the Windows event log; we re-read it each launch and keep
 * zero state. Because nothing is persisted there is no `version`/`migrate` pair
 * to keep in sync either (rule 4 only bites persisted stores).
 */
export interface GpuOcBlock {
  /** Stable tag from the backend — one of the `REASON_*` values below. */
  reason: string;
  /** Provider + event id of the record that tripped it, e.g. `"nvlddmkm 153"`.
   *  Identifier text, not a translatable sentence. */
  detail: string;
}

/** Mirrors `REASON_UNCLEAN_SHUTDOWN` in src-tauri/src/gpu_guard.rs. */
export const REASON_UNCLEAN_SHUTDOWN = "unclean_shutdown";
/** Mirrors `REASON_DISPLAY_FAULT` in src-tauri/src/gpu_guard.rs. */
export const REASON_DISPLAY_FAULT = "display_driver_fault";

interface GpuOcGuardState {
  /** `null` = nothing was skipped this session (the normal case). */
  block: GpuOcBlock | null;
  setBlock: (block: GpuOcBlock | null) => void;
}

export const useGpuOcGuard = create<GpuOcGuardState>()((set) => ({
  block: null,
  setBlock: (block) => set({ block }),
}));
