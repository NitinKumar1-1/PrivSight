import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { millisecondsSinceLoad, waitForDomSettle } from "../../src/content/settle";

/**
 * Unit tests for the bounded DOM settle wait (dynamic-DOM robustness).
 * jsdom has no navigation timing entry, so "freshly loaded" is simulated by
 * stubbing performance.getEntriesByType.
 */

function simulateFreshLoad(): void {
  const loadEventEnd = performance.now();
  vi.spyOn(performance, "getEntriesByType").mockImplementation(((type: string) =>
    type === "navigation" ? [{ loadEventEnd } as PerformanceNavigationTiming] : []) as typeof performance.getEntriesByType);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="root"><button id="buy_a">Buy Now A</button></div>`;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("millisecondsSinceLoad", () => {
  it("reports a very old load when no navigation timing exists on a complete document", () => {
    expect(millisecondsSinceLoad()).toBe(Number.POSITIVE_INFINITY);
  });

  it("reports the time since the load event when navigation timing exists", () => {
    simulateFreshLoad();
    expect(millisecondsSinceLoad()).toBeLessThan(50);
  });
});

describe("waitForDomSettle", () => {
  it("on an already-loaded page: no grace period, resolves after one quiet window", async () => {
    let done: { settled: boolean; waitedMs: number } | null = null;
    waitForDomSettle(300, 3500, 2000).then((r) => (done = r));
    await advance(299);
    expect(done).toBeNull();
    await advance(1);
    expect(done).toEqual({ settled: true, waitedMs: 300 });
  });

  it("on a freshly loaded page: waits out the grace period, then a quiet window", async () => {
    simulateFreshLoad();
    let done: { settled: boolean } | null = null;
    waitForDomSettle(300, 3500, 1000).then((r) => (done = r));
    await advance(1000);
    expect(done).toBeNull(); // grace just ended, quiet window still running
    await advance(300);
    expect(done).toEqual({ settled: true, waitedMs: expect.any(Number) });
  });

  it("includes an element inserted during the grace period (dynamic.html case)", async () => {
    simulateFreshLoad();
    const root = document.getElementById("root") as HTMLElement;
    setTimeout(() => {
      const button = document.createElement("button");
      button.id = "buy_c";
      root.appendChild(button);
    }, 1500);

    let done = false;
    waitForDomSettle(300, 3500, 2000).then(() => (done = true));
    await advance(2300);
    expect(done).toBe(true);
    expect(document.getElementById("buy_c")).not.toBeNull();
  });

  it("a mutation re-arms the quiet window", async () => {
    const root = document.getElementById("root") as HTMLElement;
    let done: { settled: boolean } | null = null;
    waitForDomSettle(300, 3500, 0).then((r) => (done = r));
    setTimeout(() => root.appendChild(document.createElement("span")), 200);
    await advance(450); // would have settled at 300 without the mutation at 200
    expect(done).toBeNull();
    await advance(60);
    expect(done).toEqual({ settled: true, waitedMs: expect.any(Number) });
  });

  it("is bounded: a page that never stops mutating resolves at the cap with settled=false", async () => {
    const root = document.getElementById("root") as HTMLElement;
    const interval = setInterval(() => root.appendChild(document.createElement("i")), 100);
    let result: { settled: boolean; waitedMs: number } | null = null;
    waitForDomSettle(300, 2000, 0).then((r) => (result = r));
    await advance(2100);
    clearInterval(interval);
    expect(result).not.toBeNull();
    expect(result!.settled).toBe(false);
    expect(result!.waitedMs).toBeGreaterThanOrEqual(2000);
  });
});
