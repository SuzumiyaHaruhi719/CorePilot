import { describe, expect, it, vi } from "vitest";
import { memoOnce } from "./memoOnce";

describe("memoOnce", () => {
  it("calls the backend once and reuses the result", async () => {
    const fn = vi.fn(async () => 42);
    const once = memoOnce(fn);
    expect(await once()).toBe(42);
    expect(await once()).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight call between concurrent callers", async () => {
    // Two tabs mounting at the same time must not both hit the backend.
    const fn = vi.fn(() => new Promise<number>((r) => setTimeout(() => r(7), 5)));
    const once = memoOnce(fn);
    const [a, b] = await Promise.all([once(), once()]);
    expect([a, b]).toEqual([7, 7]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a rejection", async () => {
    // A failure at startup usually means the backend wasn't ready yet; caching
    // it would leave the tab empty until the app restarts.
    let calls = 0;
    const once = memoOnce(async () => {
      calls += 1;
      if (calls === 1) throw new Error("backend not ready");
      return "ok";
    });
    await expect(once()).rejects.toThrow("backend not ready");
    expect(await once()).toBe("ok");
    expect(calls).toBe(2);
  });

  it("re-fetches after invalidate (the manual refresh path)", async () => {
    const fn = vi.fn(async () => Math.random());
    const once = memoOnce(fn);
    const first = await once();
    once.invalidate();
    const second = await once();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });
});
