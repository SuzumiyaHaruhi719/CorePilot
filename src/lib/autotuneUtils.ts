// Pure helpers for the fan auto-tune UI. No tauri imports — unit-testable.
import type { FanConfig } from "../store/fanProfiles";
import type { AutoTuneParams, FanCurvePoint, FanGroup, TunedFanCurve } from "./ipc";

/** Default group for a fan header by its (label or chip) name. Pumps are
 *  excluded outright: a pump on a temperature curve can destroy an AIO. */
export function classifyFan(name: string): FanGroup | "excluded" {
  const n = name.toLowerCase();
  if (/pump|水泵/.test(n)) return "excluded";
  if (/cpu|aio|opt/.test(n)) return "cpu";
  return "case";
}

/** Clamp params into spec §2 ranges and keep ceiling ≥ floor + 15. */
export function clampTuneParams(p: AutoTuneParams): AutoTuneParams {
  const targetTempC = Math.min(88, Math.max(60, p.targetTempC));
  const targetGpuTempC = Math.min(87, Math.max(60, p.targetGpuTempC));
  const quietFloorPct = Math.min(60, Math.max(0, p.quietFloorPct));
  const noiseCeilPct = Math.min(100, Math.max(Math.max(40, quietFloorPct + 15), p.noiseCeilPct));
  return { ...p, targetTempC, targetGpuTempC, quietFloorPct, noiseCeilPct };
}

function pointsDiffer(a: FanCurvePoint[] | undefined, b: FanCurvePoint[]): boolean {
  const aa = a ?? [];
  if (aa.length !== b.length) return true;
  return aa.some((p, i) => Math.abs(p.tempC - b[i].tempC) > 0.05 || Math.abs(p.duty - b[i].duty) > 0.55);
}

/** True when the live configs no longer match the tuned output — the user
 *  hand-edited something, so passive learning must pause (spec §7). */
export function curvesDiverge(configs: Record<string, FanConfig>, tuned: TunedFanCurve[]): boolean {
  for (const t of tuned) {
    const c = configs[t.controlId];
    if (!c) return true;
    if (c.mode !== "curve") return true;
    if (pointsDiffer(c.curve, t.curve)) return true;
    if (pointsDiffer(c.curve2 ?? [], t.curve2)) return true;
    if (Math.abs((c.minDuty ?? 0) - t.minDuty) > 0.55) return true;
  }
  return false;
}
