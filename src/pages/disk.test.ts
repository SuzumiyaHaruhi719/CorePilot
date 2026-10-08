import { describe, expect, it, vi } from "vitest"
vi.mock("../ui/kit", () => ({}))
vi.mock("./Processes", () => ({}))
vi.mock("../lib/store", () => ({ tf: (zh: string) => zh, useT: () => (zh: string) => zh }))
import { layout } from "./Disk"
import type { TreeNode } from "../lib/ipc"

const node = (id: number, parent: number, name: string, size: number, dir = false, hasMore = false): TreeNode =>
  ({ id, parent, name, logicalSize: size, allocSize: size, fileCount: 0, flags: dir ? 1 : 0, hasMore, path: dir ? `C:\\${name}` : null })

describe("treemap layout", () => {
  // root 100: chain a(60) → b(60) → {c 40, d 20}, file e 30, and 10 the slice dropped
  const view = { scanId: "x", generation: 1, focusPath: "C:\\", truncated: true, nodes: [
    { ...node(0, 0, "C:", 100, true, true), path: "C:\\" },
    node(1, 0, "a", 60, true), node(2, 1, "b", 60, true), node(3, 2, "c.bin", 40), node(4, 2, "d.bin", 20),
    node(5, 0, "e.bin", 30),
  ] }
  const boxes = layout(view, 1000, 600)

  it("folds a single-child folder into its parent's header", () => {
    const a = boxes.find((b) => b.n.name === "a")!
    expect(a.chain?.map((n) => n.name)).toEqual(["b"])
    expect(boxes.some((b) => b.n.name === "b")).toBe(false)
    expect(boxes.find((b) => b.n.name === "c.bin")!.path).toBe("C:\\b\\c.bin")
  })

  it("keeps dropped children as a real-sized rest tile instead of stretching the others", () => {
    const rest = boxes.find((b) => b.kind === "rest")!
    expect(rest.n.allocSize).toBe(10)
    const e = boxes.find((b) => b.n.name === "e.bin")!
    // e is 30% of the root, not 30/90
    expect((e.w + 2) * (e.h + 2) / (1000 * 600)).toBeCloseTo(0.3, 2)
  })
})

describe("treemap readability", () => {
  // 400 children of 2 bytes each next to one big file: the crumbs can't be read at
  // 1000×600, so they fold into one real-sized rest tile instead of a mush
  const nodes: TreeNode[] = [{ ...node(0, 0, "C:", 100000, true), path: "C:\\" }, node(1, 0, "big.bin", 99200)]
  for (let i = 0; i < 400; i++) nodes.push(node(2 + i, 0, `c${i}`, 2))
  const boxes = layout({ scanId: "x", generation: 1, focusPath: "C:\\", truncated: false, nodes }, 1000, 600)
  it("folds unreadable children into the rest tile", () => {
    expect(boxes.filter((b) => b.n.name.startsWith("c")).length).toBe(0)
    expect(boxes.find((b) => b.kind === "rest")!.n.allocSize).toBe(800)
  })
})
