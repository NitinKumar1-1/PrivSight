/**
 * Waits until the DOM has stopped changing, so delayed or streamed elements
 * are part of the observation.
 *
 * Two rules, both bounded:
 *   - a freshly loaded page gets a grace period after its load event, because
 *     many pages insert content shortly after load without any earlier
 *     mutation to observe;
 *   - after that, the DOM must be quiet (no mutations) for `quietMs`.
 * Resolves after `maxWaitMs` regardless, so a page that never settles cannot
 * stall the agent.
 */

export const DEFAULT_QUIET_MS = 300;
export const DEFAULT_LOAD_GRACE_MS = 2000;
export const DEFAULT_MAX_WAIT_MS = 3500;

export interface SettleResult {
  settled: boolean;
  waitedMs: number;
}

export function waitForDomSettle(
  quietMs = DEFAULT_QUIET_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  loadGraceMs = DEFAULT_LOAD_GRACE_MS,
): Promise<SettleResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    if (typeof MutationObserver === "undefined" || !document.body) {
      resolve({ settled: true, waitedMs: 0 });
      return;
    }

    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let graceOver = false;
    const observer = new MutationObserver(() => armQuietTimer());

    const finish = (settled: boolean) => {
      observer.disconnect();
      if (quietTimer) clearTimeout(quietTimer);
      if (graceTimer) clearTimeout(graceTimer);
      clearTimeout(maxTimer);
      resolve({ settled, waitedMs: Date.now() - start });
    };

    const armQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (graceOver) finish(true);
      }, quietMs);
    };

    const maxTimer = setTimeout(() => finish(false), maxWaitMs);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

    const remainingGrace = Math.max(0, loadGraceMs - millisecondsSinceLoad());
    graceTimer = setTimeout(() => {
      graceOver = true;
      armQuietTimer();
    }, Math.min(remainingGrace, maxWaitMs));
  });
}

/** Time since the document's load event, or a large number when unknown or not yet loaded. */
export function millisecondsSinceLoad(): number {
  if (typeof performance === "undefined") return Number.POSITIVE_INFINITY;
  const navigation = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!navigation || navigation.loadEventEnd <= 0) return document.readyState === "complete" ? Number.POSITIVE_INFINITY : 0;
  return performance.now() - navigation.loadEventEnd;
}
