/**
 * Phase 8: the controller as a verified state-transition loop, with fake
 * ports: verified done, challenged done after typing, final confirmation,
 * ambiguity handling, targeted re-observation, privacy on every round,
 * safety guard before any cloud call, and friendly outcome codes.
 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_RECOVERIES, MAX_ROUNDS, runAgent, type AgentEvent, type AgentPorts } from "../../src/agent/controller";
import type { ActionRecord } from "../../src/shared/contract";
import type { ApprovedPayload, FirewallVerdict } from "../../src/privacy/types";
import type { ExecuteActionResult, ExtractPageResult } from "../../src/shared/messages";

type Effect = "url_changed" | "dom_changed" | "no_change";

function post(effect: Effect): ExecuteActionResult["postAction"] {
  return { effect, mutations: effect === "no_change" ? 0 : 3, urlChanged: effect === "url_changed", titleChanged: false, controlsChanged: effect !== "no_change", modalAppeared: false, modalClosed: false, waitedMs: 50 };
}

interface Script {
  actions: unknown[];
  results?: Array<ExecuteActionResult | undefined>;
  firewalls?: FirewallVerdict[];
}

function harness(script: Script) {
  const events: AgentEvent[] = [];
  const executed: unknown[] = [];
  const histories: ActionRecord[][] = [];
  const reasonBodies: string[] = [];
  const calls = { capture: 0, perceive: 0, extract: 0, reason: 0 };
  let clock = 0;
  const allowed: FirewallVerdict = { verdict: "allowed", body: JSON.stringify({ task: "t", page: { url: "https://shop.example/", title: "Shop", elements: [], text: "" }, placeholders: [] }) as ApprovedPayload, checks: [{ name: "structure", passed: true }] };
  const ports: AgentPorts = {
    ensureContentScript: async () => undefined,
    capture: async () => (calls.capture++, { dataUrl: "data:image/png;base64,AAAA", devicePixelRatio: 1 }),
    perceive: async () => (calls.perceive++, null),
    visionInfo: async () => null,
    extract: async (_task, _ocr, history) => {
      histories.push(history.map((h) => ({ ...h })));
      const firewall = script.firewalls?.[calls.extract] ?? allowed;
      calls.extract++;
      return { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall, visualPrivacy: null } satisfies ExtractPageResult;
    },
    reason: async (body) => {
      reasonBodies.push(body);
      return script.actions[Math.min(calls.reason++, script.actions.length - 1)];
    },
    execute: async (action) => {
      executed.push(action);
      return script.results?.[executed.length - 1] ?? { ok: true, message: "ok", validation: "pass", postAction: post("dom_changed") };
    },
    renderMask: async () => null,
    settle: async () => undefined,
    report: (e) => void events.push(e),
    now: () => (clock += 1),
  };
  return { ports, events, executed, histories, reasonBodies, calls, allowed };
}

const TYPE = { action: "type", target: "el_q", value: "black shirt", confidence: 0.9, reason: "search", final: false };
const PRESS = { action: "press", target: "el_q", value: "Enter", confidence: 0.9, reason: "submit", final: false };
const CLICK_GO = { action: "click", target: "el_go", confidence: 0.9, reason: "submit", final: false };
const DONE = { action: "done", confidence: 1, reason: "results for black shirt are shown", final: true };
const TYPED = { ok: true, message: "Typed 11 character(s) into el_q", validation: "pass" as const, postAction: post("no_change"), note: "typed text verified in the field; nothing submitted yet" };

describe("E. multi-step: type -> re-observe -> submit -> re-observe -> done", () => {
  it("runs the search flow one verified transition at a time", async () => {
    const h = harness({ actions: [TYPE, PRESS, DONE], results: [TYPED, { ok: true, message: "Pressed Enter in el_q", validation: "pass", postAction: post("url_changed") }] });
    const outcome = await runAgent("Search for black shirt on the website", h.ports);
    expect(outcome).toMatchObject({ status: "completed", code: "COMPLETED", steps: 3, cloudContacted: true, browserActed: true });
    expect(h.executed.map((a) => (a as { action: string }).action)).toEqual(["type", "press", "done"]);
    // The reasoner saw the typing's effect and note before choosing to submit.
    expect(h.histories[1]).toMatchObject([{ action: "type", effect: "no_change", note: expect.stringMatching(/nothing submitted/) }]);
    expect(h.histories[2]).toMatchObject([{ action: "type" }, { action: "press", effect: "url_changed" }]);
  });

  it("the round after typing is a targeted DOM-only re-observation (no capture, no OCR)", async () => {
    const h = harness({ actions: [TYPE, CLICK_GO, DONE], results: [TYPED] });
    await runAgent("Search for black shirt", h.ports);
    expect(h.calls.capture).toBe(2); // rounds 1 and 3; round 2 (after typing) skipped the capture
    expect(h.events.some((e) => e.kind === "stage" && e.stage === "vision" && e.state === "skipped" && /targeted/.test(e.detail ?? ""))).toBe(true);
  });
});

describe("G. done is a verified state", () => {
  it("a done right after unsubmitted typing is challenged once; the reasoner then submits", async () => {
    const h = harness({ actions: [TYPE, DONE, CLICK_GO, DONE], results: [TYPED, undefined, { ok: true, message: "Clicked el_go", validation: "pass", postAction: post("url_changed") }] });
    const outcome = await runAgent("Search for black shirt", h.ports);
    expect(outcome.status).toBe("completed");
    // The premature done (a no-op on the page) did not end the run: the loop continued to the submit click, which navigated.
    expect(h.executed.map((a) => (a as { action: string }).action)).toEqual(["type", "done", "click", "done"]);
    expect(outcome.steps).toBe(3); // type, click, done: the rejected done is not a step
    expect(h.histories[2].map((r) => r.action)).toEqual(["type", "done"]);
    expect(h.histories[2][1].note).toMatch(/rejected locally.*never submitted/);
  });

  it("a done after unsubmitted typing is accepted the second time (the reasoner insists with the evidence in front of it)", async () => {
    const h = harness({ actions: [TYPE, DONE, DONE], results: [TYPED] });
    const outcome = await runAgent("Type black shirt into the search box", h.ports);
    // The reasoner insists through the whole recovery budget; the page still shows no submitted search: never Complete.
    expect(outcome).toMatchObject({ status: "unverified", code: "COMPLETION_UNVERIFIED" });
    expect(h.calls.reason).toBe(2 + DEFAULT_MAX_RECOVERIES);
  });

  it("'final' on a click is verified on the resulting page instead of ending the run", async () => {
    const h = harness({ actions: [{ ...CLICK_GO, final: true }, DONE] });
    const outcome = await runAgent("Click Go", h.ports);
    expect(outcome.status).toBe("unverified"); // executed and confirmed by the model, but no end state to check
    expect(h.calls.reason).toBe(2);
    expect(h.executed).toHaveLength(2);
  });

  it("'final' on typing never completes the task by itself", async () => {
    const h = harness({ actions: [{ ...TYPE, final: true }, PRESS, DONE], results: [TYPED, { ok: true, message: "Pressed", validation: "pass", postAction: post("url_changed") }] });
    const outcome = await runAgent("Search for black shirt", h.ports);
    expect(outcome.steps).toBe(3);
    expect(outcome.status).toBe("completed");
  });

  it("stops as no progress when three actions in a row change nothing", async () => {
    const results = [CLICK_GO, { ...CLICK_GO, target: "el_a" }, { ...CLICK_GO, target: "el_b" }, { ...CLICK_GO, target: "el_c" }];
    const h = harness({ actions: results, results: results.map(() => ({ ok: true, message: "Clicked", validation: "pass", postAction: post("no_change") })) });
    const outcome = await runAgent("Click things", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "NO_PROGRESS" });
    expect(outcome.steps).toBe(3);
  });
});

describe("F. missing or ambiguous data is surfaced, never invented", () => {
  it.each([
    ["MISSING_REQUIRED_DATA", "no price is shown for the shirt"],
    ["AMBIGUOUS_TARGET", "two shirts cost 499 and the task gives no tie-breaker"],
    ["INSUFFICIENT_EVIDENCE", "the cart count did not change"],
  ])("done with %s ends the run as blocked with that code", async (code, reason) => {
    const h = harness({ actions: [{ action: "done", value: code, confidence: 1, reason, final: true }] });
    const outcome = await runAgent("Buy the cheapest shirt", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code });
    expect(outcome.browserActed).toBe(false);
  });
});

describe("K. stale and ambiguous targets", () => {
  it("re-observes on an ambiguous target and fails closed when it stays ambiguous", async () => {
    const ambiguous: ExecuteActionResult = { ok: false, message: "2 controls on the page now match the target; not guessing between them", validation: "blocked", code: "ambiguous_target" };
    const h = harness({ actions: [CLICK_GO], results: [ambiguous, ambiguous, ambiguous] });
    const outcome = await runAgent("Click Go", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "AMBIGUOUS_TARGET", rounds: MAX_ROUNDS, browserActed: false });
    expect(h.calls.extract).toBe(MAX_ROUNDS);
  });

  it("a covered target is re-observed like a stale one and ends as STALE_TARGET", async () => {
    const covered: ExecuteActionResult = { ok: false, message: "Target cannot be clicked: another element is covering it", validation: "blocked", code: "target_not_clickable" };
    const h = harness({ actions: [CLICK_GO], results: [covered, covered, covered] });
    const outcome = await runAgent("Click Go", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "STALE_TARGET" });
  });

  it("when the content script vanishes after a click and the URL changed, the click counts as executed with a navigation", async () => {
    let url = "https://shop.example/";
    const h = harness({ actions: [CLICK_GO, DONE] });
    h.ports.pageUrl = async () => url;
    h.ports.observeOffPage = async () => ({ ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall: h.allowed, visualPrivacy: null });
    h.ports.executeOffPage = async () => ({ ok: true, message: "n/a", validation: "pass" });
    let first = true;
    h.ports.execute = async () => {
      if (first) {
        first = false;
        url = "https://shop.example/results";
        throw new Error("The message port closed before a response was received.");
      }
      return { ok: true, message: "Task reported as done", validation: "pass" };
    };
    const outcome = await runAgent("Click Go", h.ports);
    expect(["completed", "unverified"]).toContain(outcome.status);
    expect(h.histories[1]).toMatchObject([{ action: "click", effect: "url_changed" }]);
  });
});

describe("H. local safety guard before any cloud request", () => {
  it("blocks a harmful task with zero cloud requests and zero browser actions", async () => {
    const h = harness({ actions: [CLICK_GO] });
    const outcome = await runAgent("add a knife to cart to kill my friend", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "SAFETY_BLOCK", cloudContacted: false, browserActed: false, steps: 0 });
    expect(h.calls.reason).toBe(0);
    expect(h.calls.extract).toBe(0);
    expect(h.executed).toHaveLength(0);
  });

  it("does not block a benign task that merely mentions a knife", async () => {
    const h = harness({ actions: [DONE] });
    const outcome = await runAgent("add a chef's knife to the cart for my kitchen", h.ports);
    expect(outcome.code).not.toBe("SAFETY_BLOCK");
    expect(outcome.cloudContacted).toBe(true);
    expect(h.calls.reason).toBeGreaterThanOrEqual(1);
  });
});

describe("I. privacy on every cloud round", () => {
  it("every reasoning round receives exactly the firewall-approved body of that round's observation", async () => {
    const h = harness({ actions: [TYPE, CLICK_GO, DONE], results: [TYPED] });
    await runAgent("Search for black shirt", h.ports);
    expect(h.reasonBodies).toHaveLength(3);
    expect(h.reasonBodies.every((b) => b === h.allowed.body)).toBe(true);
  });

  it("a firewall block on a later round stops the run with no further cloud call", async () => {
    const blocked: FirewallVerdict = { verdict: "blocked", reason: "Privacy Firewall blocked request: EMAIL leakage detected", checks: [] };
    const h = harness({ actions: [TYPE, CLICK_GO, DONE], results: [TYPED], firewalls: [undefined as unknown as FirewallVerdict, blocked] });
    h.ports.extract = (async (_t, _o, history) => {
      h.histories.push(history);
      const firewall = h.calls.extract++ === 0 ? h.allowed : blocked;
      return { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall, visualPrivacy: null };
    }) as AgentPorts["extract"];
    const outcome = await runAgent("Search for black shirt", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "PRIVACY_BLOCK", cloudContacted: true, browserActed: true });
    expect(h.calls.reason).toBe(1);
  });
});

describe("L. cloud failures map to friendly outcome codes", () => {
  it.each([
    ["Request timed out after 30000 ms", "CLOUD_TIMEOUT"],
    ["TypeError: Failed to fetch", "NETWORK_ERROR"],
    ["Backend returned 502: Reasoning provider error", "CLOUD_ERROR"],
    ["Backend returned 502: Invalid action from reasoning provider: response is not valid JSON", "INVALID_MODEL_RESPONSE"],
  ])("%s -> %s", async (error, code) => {
    const h = harness({ actions: [] });
    h.ports.reason = vi.fn(async () => { throw new Error(error); });
    const outcome = await runAgent("Search for black shirt", h.ports);
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe(code);
    expect(outcome.browserActed).toBe(false);
  });

  it("an unusable model answer is retried within the round bound, then fails as INVALID_MODEL_RESPONSE", async () => {
    const h = harness({ actions: [] });
    h.ports.reason = vi.fn(async () => { throw new Error("Backend returned 502: Invalid action from reasoning provider: target is not one of the supplied element IDs"); });
    const outcome = await runAgent("Search", h.ports);
    expect(outcome.code).toBe("INVALID_MODEL_RESPONSE");
    expect(h.ports.reason).toHaveBeenCalledTimes(MAX_ROUNDS);
  });
});

describe("J. malicious model output never reaches the page", () => {
  it("a validator block for executable content is reported as an invalid model response, with no browser action", async () => {
    const h = harness({ actions: [{ action: "click", target: "el_go", confidence: 1, reason: "<script>alert(1)</script>" }], results: [{ ok: false, message: "Executable content in action blocked", validation: "blocked", code: "executable_content" }] });
    const outcome = await runAgent("Click Go", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "INVALID_MODEL_RESPONSE", browserActed: false });
  });

  it("an unsupported action is reported as unsupported", async () => {
    const h = harness({ actions: [{ action: "select", target: "el_size", value: "L", confidence: 1, reason: "" }], results: [{ ok: false, message: 'Action "select" is valid but unsupported by current executor', validation: "blocked", code: "unsupported_by_executor" }] });
    const outcome = await runAgent("Pick size L", h.ports);
    expect(outcome.code).toBe("UNSUPPORTED_ACTION");
  });
});

describe("development trace", () => {
  it("reports a trace event per attempted action with resolution, validation, execution, post-action and final fields", async () => {
    const trace = { action: "click", target: "Go", resolution: "ps-id" as const, match: "button el_go", validation: "PASS" as const, execution: "PASS" as const, postAction: "dom_changed" };
    const h = harness({ actions: [CLICK_GO, DONE], results: [{ ok: true, message: "Clicked el_go", validation: "pass", postAction: post("dom_changed"), trace }] });
    await runAgent("Click Go", h.ports);
    const traces = h.events.filter((e): e is Extract<AgentEvent, { kind: "trace" }> => e.kind === "trace");
    expect(traces[0].trace).toMatchObject({ ...trace, reobserve: "YES", final: "CONTINUE" });
  });
});

describe("history carries the redacted control label locally and passes it to the executor", () => {
  it("the label from the trace goes into the record; the sanitized wire body never carries it", async () => {
    const trace = { action: "click", target: "Add to cart", resolution: "ps-id" as const, match: "button el_atc", validation: "PASS" as const, execution: "PASS" as const, postAction: "dom_changed" };
    const h = harness({ actions: [{ ...CLICK_GO, target: "el_atc" }, DONE], results: [{ ok: true, message: "Clicked el_atc", validation: "pass", postAction: post("dom_changed"), trace }] });
    const seen: unknown[] = [];
    const inner = h.ports.execute;
    h.ports.execute = async (action, history) => { seen.push(history?.map((h) => ({ ...h }))); return inner(action, history); };
    await runAgent("Add a shirt to the cart", h.ports);
    expect(h.histories[1]).toMatchObject([{ action: "click", target: "el_atc", label: "Add to cart" }]);
    expect(seen[1]).toMatchObject([{ label: "Add to cart" }]);
  });
});
