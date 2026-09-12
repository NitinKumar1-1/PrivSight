/**
 * Local Browser Agent / Controller state transitions with fake ports. No
 * chrome.*, no network, no OCR: this tests the bounded orchestration alone.
 */

import { describe, expect, it, vi } from "vitest";
import { MAX_ROUNDS, runAgent, type AgentEvent, type AgentPorts } from "../../src/agent/controller";
import type { ApprovedPayload, FirewallVerdict } from "../../src/privacy/types";
import type { ExecuteActionResult, ExtractPageResult } from "../../src/shared/messages";
import type { OcrResult } from "../../src/vision/types";

const TASK = "Find the cheapest black shirt and click Buy Now";
const BUY_TRACE = { action: "click", target: "Buy Now", resolution: "ps-id" as const, match: "button el_buy_c", validation: "PASS" as const, execution: "PASS" as const, postAction: "url_changed" };
const OCR: OcrResult = { engine: "test-ocr", imageWidth: 10, imageHeight: 10, lines: [], timings: { loadMs: 5, recognizeMs: 40 }, usedJsHeapMb: 12 };

const allowed: FirewallVerdict = {
  verdict: "allowed",
  // The fake page is a checkout page, so a verified "Buy Now" click can complete a purchase task.
  body: JSON.stringify({ task: TASK, page: { url: "https://shop.example/checkout", title: "Checkout", elements: [], text: "" }, placeholders: [] }) as ApprovedPayload,
  checks: [{ name: "structure", passed: true }],
};
const blocked: FirewallVerdict = { verdict: "blocked", reason: "Privacy Firewall blocked request: EMAIL leakage detected", checks: [] };

function extracted(firewall: FirewallVerdict): ExtractPageResult {
  return {
    ok: true,
    summary: { placeholders: ["[EMAIL_1]"], types: { "[EMAIL_1]": "EMAIL" }, detections: [] },
    firewall,
    visualPrivacy: { ocrLines: 3, observationsSent: 1, redactedObservations: 1, maskRegions: [{ type: "EMAIL", bbox: { x: 0, y: 0, width: 5, height: 5 } }], conflicts: [], fusion: { duplicatesDropped: 1, visualOnly: 1, buttonsMapped: 1, conflictsDropped: 0 } },
  };
}

interface Harness {
  ports: AgentPorts;
  events: AgentEvent[];
  calls: Record<string, number>;
}

function harness(overrides: Partial<AgentPorts> = {}): Harness {
  const events: AgentEvent[] = [];
  const calls: Record<string, number> = {};
  const count = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);
  let clock = 0;
  const ports: AgentPorts = {
    ensureContentScript: async () => void count("ensure"),
    capture: async () => (count("capture"), { dataUrl: "data:image/png;base64,AAAA", devicePixelRatio: 1 }),
    perceive: async () => (count("perceive"), OCR),
    visionInfo: async () => ({ engine: "test-ocr", backend: "wasm", webgpu: "n/a" }),
    extract: async () => (count("extract"), extracted(allowed)),
    // The click is marked final; the controller verifies it on the resulting page, where the reasoner confirms with done.
    reason: async () => (count("reason"), calls.reason === 1 ? { action: "click", target: "el_buy_c", confidence: 0.9, reason: "r", final: true } : { action: "done", confidence: 1, reason: "bought" }),
    execute: async () => (count("execute"), { ok: true, message: "Clicked el_buy_c", validation: "pass", trace: BUY_TRACE } as ExecuteActionResult),
    renderMask: async () => (count("mask"), "data:image/png;base64,MASK"),
    report: (event) => void events.push(event),
    now: () => (clock += 10),
    ...overrides,
  };
  return { ports, events, calls };
}

const stages = (h: Harness) => h.events.filter((e): e is Extract<AgentEvent, { kind: "stage" }> => e.kind === "stage").map((e) => `${e.stage}:${e.state}`);

describe("runAgent happy path", () => {
  it("runs OBSERVE -> PERCEIVE/SANITIZE -> REASON -> VALIDATE/EXECUTE once and completes", async () => {
    const h = harness();
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome).toMatchObject({ status: "completed", code: "COMPLETED", rounds: 2, steps: 2, cloudContacted: true, browserActed: true });
    // Two rounds: the final click, then the verification observation on which the reasoner says done.
    expect(h.calls).toMatchObject({ ensure: 2, capture: 2, perceive: 2, extract: 2, reason: 2, execute: 2, mask: 2 });
    expect(stages(h).slice(0, 11)).toEqual([
      "vision:pass", "dom:pass", "detect:pass", "visual-redaction:pass", "leakage:pass", "firewall:pass",
      "reason:pending", "reason:pass", "validate:pending", "validate:pass", "execute:pass",
    ]);
  });

  it("reports metrics measured from the ports, including OCR timings and heap", async () => {
    const h = harness();
    await runAgent(TASK, h.ports);
    const metrics = h.events.find((e) => e.kind === "metrics");
    expect(metrics && metrics.kind === "metrics" ? metrics.metrics : null).toMatchObject({
      round: 1, ocrLoadMs: 5, ocrRecognizeMs: 40, usedJsHeapMb: 12, engine: "test-ocr", observationsSent: 1, maskRegions: 1,
    });
  });

  it("sends the local previews to the popup only (an event, never a port that reaches the network)", async () => {
    const h = harness();
    await runAgent(TASK, h.ports);
    const preview = h.events.find((e) => e.kind === "preview");
    expect(preview).toMatchObject({ kind: "preview", maskCount: 1, maskedDataUrl: "data:image/png;base64,MASK" });
  });

  it("passes only the firewall-approved body to reason", async () => {
    const reason = vi.fn(async () => ({ action: "done", confidence: 1, reason: "x" }));
    const h = harness({ reason });
    await runAgent(TASK, h.ports);
    expect(reason).toHaveBeenCalledWith(allowed.body);
  });
});

describe("runAgent fallbacks", () => {
  it("continues DOM-only when capture is unavailable", async () => {
    const h = harness({ capture: async () => null });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome.status).toBe("completed");
    expect(stages(h)).toContain("vision:fallback");
    expect(h.calls.perceive).toBeUndefined();
  });

  it("continues DOM-only when the OCR engine throws", async () => {
    const h = harness({ perceive: async () => { throw new Error("wasm failed to load"); } });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome.status).toBe("completed");
    const fallback = h.events.find((e) => e.kind === "stage" && e.stage === "vision" && e.state === "fallback");
    expect(fallback && fallback.kind === "stage" ? fallback.detail : "").toContain("wasm failed to load");
  });
});

describe("runAgent stop conditions (fail safe)", () => {
  it("stops when the firewall blocks: no reasoning, no execution", async () => {
    const h = harness({ extract: async () => extracted(blocked) });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "PRIVACY_BLOCK", rounds: 1, steps: 0, message: blocked.reason, cloudContacted: false, browserActed: false });
    expect(h.calls.reason).toBeUndefined();
    expect(h.calls.execute).toBeUndefined();
    expect(stages(h)).toEqual(expect.arrayContaining(["firewall:fail", "reason:skipped", "validate:skipped", "execute:skipped"]));
  });

  it("stops when extraction fails", async () => {
    const h = harness({ extract: async () => ({ ok: false, error: "no body" }) });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome.status).toBe("failed");
    expect(h.calls.reason).toBeUndefined();
  });

  it("stops when cloud reasoning fails", async () => {
    const h = harness({ reason: async () => { throw new Error("Backend returned 502"); } });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome).toMatchObject({ status: "failed", rounds: 1 });
    expect(outcome.message).toContain("502");
    expect(h.calls.execute).toBeUndefined();
  });

  it("stops immediately on a non-retryable validation block (unsupported action)", async () => {
    const execute = vi.fn(async () => ({ ok: false, message: "Unsupported action blocked", validation: "blocked", code: "unsupported_action" } as ExecuteActionResult));
    const h = harness({ execute });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome.status).toBe("blocked");
    expect(outcome.rounds).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.calls.capture).toBe(1);
  });

  it("stops when execution itself fails", async () => {
    const h = harness({ execute: async () => ({ ok: false, message: "No element found", validation: "pass" }) });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome.status).toBe("failed");
  });
});

describe("runAgent bounded re-observation", () => {
  it("re-observes on a stale target and succeeds on the next round", async () => {
    let attempt = 0;
    const execute = vi.fn(async () => {
      attempt++;
      return attempt === 1
        ? ({ ok: false, message: "Target element not found on the current page", validation: "blocked", code: "unknown_target" } as ExecuteActionResult)
        : ({ ok: true, message: "Clicked el_buy_c", validation: "pass", trace: BUY_TRACE } as ExecuteActionResult);
    });
    const h = harness({ execute });
    // The reasoner asks for the click twice (the first attempt was stale), then confirms done.
    h.ports.reason = async () => (h.calls.reason = (h.calls.reason ?? 0) + 1, h.calls.reason <= 2 ? { action: "click", target: "el_buy_c", confidence: 0.9, reason: "r", final: true } : { action: "done", confidence: 1, reason: "bought" });
    const outcome = await runAgent(TASK, h.ports);
    // Round 1: stale; round 2: the click runs (final); round 3: done, verified on the checkout page.
    expect(outcome).toMatchObject({ status: "completed", code: "COMPLETED", rounds: 3, steps: 2 });
    expect(h.calls.capture).toBe(3);
    expect(h.calls.extract).toBe(3);
    expect(h.calls.reason).toBe(3);
  });

  it("never exceeds MAX_ROUNDS when the target keeps disappearing", async () => {
    const execute = vi.fn(async () => ({ ok: false, message: "Target element not found on the current page", validation: "blocked", code: "unknown_target" } as ExecuteActionResult));
    const h = harness({ execute });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome.status).toBe("blocked");
    expect(outcome.rounds).toBe(MAX_ROUNDS);
    expect(execute).toHaveBeenCalledTimes(MAX_ROUNDS);
    expect(h.calls.capture).toBe(MAX_ROUNDS);
  });
});
