import { beforeEach, describe, expect, it, vi } from "vitest";

// The store persists through Tauri IPC, which doesn't exist under vitest. Stub
// the storage so creating the store doesn't reach for a backend.
vi.mock("../lib/persist", () => ({
  tauriStorage: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

const { useUi } = await import("./ui");

describe("ui store sort actions", () => {
  beforeEach(() => {
    useUi.setState({ procSortKey: "cpu", procSortDir: "desc", coreSortKey: "cpu", coreSortDir: "desc" });
  });

  it("flips direction when the SAME column is clicked again", () => {
    useUi.getState().setProcSort("cpu");
    expect(useUi.getState()).toMatchObject({ procSortKey: "cpu", procSortDir: "asc" });
    useUi.getState().setProcSort("cpu");
    expect(useUi.getState()).toMatchObject({ procSortKey: "cpu", procSortDir: "desc" });
  });

  it("gives a NEW column its natural default: text ascending, numbers descending", () => {
    useUi.getState().setProcSort("name");
    expect(useUi.getState()).toMatchObject({ procSortKey: "name", procSortDir: "asc" });
    useUi.getState().setProcSort("mem");
    expect(useUi.getState()).toMatchObject({ procSortKey: "mem", procSortDir: "desc" });
    useUi.getState().setCoreSort("group");
    expect(useUi.getState()).toMatchObject({ coreSortKey: "group", coreSortDir: "asc" });
  });

  it("keeps the 核心分配 and 任务管理器 tables independent", () => {
    // Regression guard: sharing one sort pair would make sorting one tab's table
    // silently re-sort the other's.
    useUi.getState().setProcSort("name");
    expect(useUi.getState()).toMatchObject({ coreSortKey: "cpu", coreSortDir: "desc" });
  });

  it("keeps view state OUT of the persisted slice", () => {
    // Guards rule 4 from the other direction: if a view field ever lands in
    // `partialize`, the store shape changes and `version` (still 1) would have
    // to grow a migrate. Keeping these session-only is what makes that unneeded.
    const persisted = useUi.persist.getOptions().partialize?.(useUi.getState()) ?? {};
    expect(Object.keys(persisted).sort()).toEqual(["amdTuningUnlocked", "optimizeOnStartup"]);
  });
});
