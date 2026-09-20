import { describe, expect, it } from "vitest";
import { sameRow } from "./useProcesses";
import type { ProcInfo } from "../lib/ipc";

function proc(patch: Partial<ProcInfo> = {}): ProcInfo {
  return {
    pid: 1234,
    name: "chrome.exe",
    cpu: 3.5,
    mem: 512_000_000,
    threads: 42,
    gpu: 1.25,
    power: 7,
    affinity: 0xffn,
    gpuMem: 64_000_000,
    handles: 900,
    cpuTime: 128.5,
    gpuEngine: "3D",
    ...patch,
  };
}

// `sameRow` decides whether the poller may hand a memoized row its PREVIOUS
// object instead of the freshly-decoded one. Anything it wrongly calls equal
// gets frozen on screen, so every field a table paints has to be in it.
describe("sameRow", () => {
  it("reuses a row when nothing displayed moved", () => {
    expect(sameRow(proc(), proc())).toBe(true);
  });

  it("refuses to reuse across a recycled PID", () => {
    // Windows hands PIDs out again fast. A brand-new process can arrive with
    // the same pid and the same idle defaults; without the name check the dead
    // process's row object (and its NAME) would keep being shown.
    const dead = proc({ cpu: 0, gpu: 0, power: 0, name: "installer.exe" });
    const reborn = proc({ cpu: 0, gpu: 0, power: 0, name: "game.exe" });
    expect(sameRow(dead, reborn)).toBe(false);
  });

  it.each([
    ["cpu", { cpu: 3.6 }],
    ["gpu", { gpu: 1.26 }],
    ["mem", { mem: 512_000_001 }],
    ["power", { power: 8 }],
    ["threads", { threads: 43 }],
    ["affinity", { affinity: 0xfn }],
    ["gpuMem", { gpuMem: 64_000_001 }],
    // handles / cpuTime move independently of cpu on an idle process — if they
    // were left out, the Details table's 句柄 / CPU时间 columns would freeze.
    ["handles", { handles: 901 }],
    ["cpuTime", { cpuTime: 128.6 }],
    ["gpuEngine", { gpuEngine: "Video Encode" }],
    ["pid", { pid: 1235 }],
  ] as const)("re-renders when %s changes", (_field, patch) => {
    expect(sameRow(proc(), proc(patch))).toBe(false);
  });
});
