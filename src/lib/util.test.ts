import { expect, test } from "vitest"
import { bytes, cpusOf, curveAt, maskOf, squarify } from "./util"

test("masks survive bits above 2^53", () => {
  const m = maskOf([0, 3, 63])
  expect(m.toString()).toBe("9223372036854775817")
  expect(cpusOf(m.toString(), 64)).toEqual([0, 3, 63])
})

test("squarify tiles the rect exactly", () => {
  const r = { x: 0, y: 0, w: 600, h: 400 }
  const vals = [6, 6, 4, 3, 2, 2, 1]
  const rs = squarify(vals, r)
  const area = rs.reduce((a, q) => a + q.w * q.h, 0)
  expect(area).toBeCloseTo(600 * 400, 3)
  rs.forEach((q, i) => expect(q.w * q.h).toBeCloseTo((vals[i] / 24) * 240000, 3))
  for (const q of rs) expect(q.x + q.w).toBeLessThanOrEqual(600.0001)
})

test("curve interpolation is flat past the ends", () => {
  const c = [{ tempC: 40, duty: 20 }, { tempC: 80, duty: 100 }]
  expect(curveAt(c, 20)).toBe(20)
  expect(curveAt(c, 60)).toBe(60)
  expect(curveAt(c, 95)).toBe(100)
})

test("bytes formatting", () => {
  expect(bytes(512)).toBe("512 B")
  expect(bytes(1536)).toBe("1.5 KB")
  expect(bytes(null)).toBe("—")
})
