import { expect, test, vi } from "vitest"

vi.mock("./ipc", () => ({ logUi: vi.fn(), api: {}, on: vi.fn() }))
vi.stubGlobal("addEventListener", () => {})

test("mood enters high, leaves low (no flicker at a threshold)", async () => {
  const { moodOf } = await import("./boot")
  expect(moodOf("calm", 55, 10, 60, 50, false)).toBe("calm")
  expect(moodOf("calm", 61, 10, 60, 50, false)).toBe("busy")
  expect(moodOf("busy", 50, 10, 60, 50, false)).toBe("busy") // still above the 42 % exit
  expect(moodOf("busy", 30, 10, 60, 50, false)).toBe("calm")
  expect(moodOf("busy", 30, 10, 60, 50, true)).toBe("game")
  expect(moodOf("game", 30, 10, 87, 50, true)).toBe("hot") // heat wins over gaming
  expect(moodOf("hot", 30, 10, 82, 50, false)).toBe("hot")
  expect(moodOf("hot", 30, 10, 75, 50, false)).toBe("calm")
})
