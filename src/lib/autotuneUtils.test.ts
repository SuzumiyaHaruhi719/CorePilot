import { describe, expect, test } from "vitest";
import type { FanConfig } from "../store/fanProfiles";
import type { TunedFanCurve } from "./ipc";
import { classifyFan, clampTuneParams, curvesDiverge } from "./autotuneUtils";

describe("classifyFan", () => {
  test("pump headers are excluded — a pump must never follow a temp curve", () => {
    expect(classifyFan("AIO Pump")).toBe("excluded");
    expect(classifyFan("W_PUMP+")).toBe("excluded");
    expect(classifyFan("水泵")).toBe("excluded");
  });
  test("cpu-ish headers go to the cpu group", () => {
    expect(classifyFan("CPU Fan")).toBe("cpu");
    expect(classifyFan("CPU_OPT")).toBe("cpu");
    expect(classifyFan("AIO Fan 1")).toBe("cpu");
  });
  test("everything else is a case fan", () => {
    expect(classifyFan("Chassis Fan 2")).toBe("case");
    expect(classifyFan("System Fan")).toBe("case");
    expect(classifyFan("Fan #4")).toBe("case");
  });
});

describe("clampTuneParams", () => {
  test("clamps into spec ranges", () => {
    const p = clampTuneParams({ targetTempC: 95, targetGpuTempC: 40, quietFloorPct: 80, noiseCeilPct: 20, groups: {} });
    expect(p.targetTempC).toBe(88);
    expect(p.targetGpuTempC).toBe(60);
    expect(p.quietFloorPct).toBe(60);
    expect(p.noiseCeilPct).toBeGreaterThanOrEqual(p.quietFloorPct + 15);
  });
});

describe("curvesDiverge", () => {
  const tuned: TunedFanCurve[] = [
    {
      controlId: "a",
      group: "cpu",
      curve: [{ tempC: 20, duty: 25 }, { tempC: 85, duty: 80 }],
      curve2: [],
      minDuty: 25,
      spinUpPct: 70,
      spinDownPct: 30,
    },
  ];
  const matching: Record<string, FanConfig> = {
    a: {
      mode: "curve",
      manualPct: 50,
      tempSourceId: "t",
      curve: [{ tempC: 20, duty: 25 }, { tempC: 85, duty: 80 }],
      minDuty: 25,
      spinUpPct: 70,
      spinDownPct: 30,
      curve2: [],
      tempSourceId2: null,
    },
  };
  test("identical configs do not diverge", () => {
    expect(curvesDiverge(matching, tuned)).toBe(false);
  });
  test("a hand-edited point diverges", () => {
    const edited = { ...matching, a: { ...matching.a, curve: [{ tempC: 20, duty: 40 }, { tempC: 85, duty: 80 }] } };
    expect(curvesDiverge(edited, tuned)).toBe(true);
  });
  test("switching the fan to manual diverges", () => {
    const manual = { ...matching, a: { ...matching.a, mode: "manual" as const } };
    expect(curvesDiverge(manual, tuned)).toBe(true);
  });
});
