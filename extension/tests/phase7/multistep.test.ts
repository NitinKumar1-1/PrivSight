/**
 * Phase 7: the controller's bounded multi-step loop, with fake ports.
 */

import { describe, expect, it } from "vitest";
import { MAX_STEPS, runAgent, type AgentEvent, type AgentPorts } from "../../src/agent/controller";
import type { ActionRecord } from "../../src/shared/contract";
import type { ApprovedPayload, FirewallVerdict } from "../../src/privacy/types";
import type { ExecuteActionResult, ExtractPageResult } from "../../src/shared/messages";

interface Script {
  /** Reasoner outputs per call. */
  actions: unknown[];
  /** Executor results per call; defaults to ok. */
  results?: ExecuteActionResult[];
}

function harness(script: Script) {
  const events: AgentEvent[] = [];
  const executed: unknown[] = [];
  const histories: ActionRecord[][] = [];
  let reasonCalls = 0;
  let settles = 0;
  let clock = 0;
  const firewall: FirewallVerdict = { verdict: "allowed", body: JSON.stringify({ task: "t", page: { url: "https://shop.example/", title: "Shop", elements: [], text: "" }, placeholders: [] }) as ApprovedPayload, checks: [] };
  const extracted: ExtractPageResult = { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall, visualPrivacy: null };
  const ports: AgentPorts = {
    ensureContentScript: async () => undefined,
    capture: async () => null,
    perceive: async () => null,
    visionInfo: async () => null,
    extract: async (_task, _ocr, history) => {
      histories.push([...history]);
      return extracted;
    },
    reason: async () => script.actions[Math.min(reasonCalls++, script.actions.length - 1)],
    execute: async (action) => {
      executed.push(action);
      return script.results?.[executed.length - 1] ?? { ok: true, message: "ok", validation: "pass" };
    },
    renderMask: async () => null,
    settle: async () => void settles++,
    report: (e) => void events.push(e),
    now: () => (clock += 1),
  };
  return { ports, events, executed, histories, settleCount: () => settles };
}

const TYPE = { action: "type", target: "el_q", value: "black shirt", confidence: 0.9, reason: "search" };
const GO = { action: "click", target: "el_go", confidence: 0.9, reason: "submit search" };
const OPEN = { action: "click", target: "el_black_shirt_c", confidence: 0.9, reason: "cheapest" };
const ADD = { action: "click", target: "el_add_to_cart", confidence: 0.9, reason: "add" };
/** The executor's report for a verified add-to-cart click: the cart count went up. */
const ADDED: ExecuteActionResult = { ok: true, message: "Clicked el_add_to_cart", validation: "pass", trace: { action: "click", target: "Add to cart", resolution: "ps-id", match: "button", validation: "PASS", execution: "PASS", postAction: "dom_changed" }, cartEvidence: { countBefore: 0, countAfter: 1, confirmationAppeared: false, goToCartAppeared: false, dialogAppeared: false, added: true } };
const OK: ExecuteActionResult = { ok: true, message: "ok", validation: "pass" };
const DONE = { action: "done", confidence: 1, reason: "added Black Shirt C at 699 to the cart" };

describe("multi-step loop", () => {
  it("executes each returned action, settles between steps, carries the history, and completes on done", async () => {
    const h = harness({ actions: [TYPE, GO, OPEN, ADD, DONE], results: [OK, OK, OK, ADDED] });
    const outcome = await runAgent("search and add to cart", h.ports);
    expect(outcome.status).toBe("completed");
    expect(outcome.steps).toBe(5);
    expect(h.executed).toEqual([TYPE, GO, OPEN, ADD, DONE]);
    expect(h.settleCount()).toBe(4); // no settle after done
    expect(h.histories[0]).toEqual([]);
    expect(h.histories[4]).toMatchObject([
      { action: "type", target: "el_q", value: "black shirt" },
      { action: "click", target: "el_go", value: null },
      { action: "click", target: "el_black_shirt_c", value: null },
      { action: "click", target: "el_add_to_cart", value: null },
    ]);
    const steps = h.events.filter((e) => e.kind === "step");
    expect(steps).toHaveLength(5);
  });

  it("an action marked final is verified: the resulting page is observed once and the reasoner confirms with done", async () => {
    const h = harness({ actions: [{ ...GO, final: true }, DONE] });
    const outcome = await runAgent("click Go once", h.ports);
    expect(outcome.status).toBe("unverified"); // executed, but "click Go once" names no end state the page can confirm
    expect(outcome.code).toBe("COMPLETION_UNVERIFIED");
    expect(outcome.steps).toBe(2);
    expect(h.executed).toEqual([{ ...GO, final: true }, DONE]);
    expect(h.settleCount()).toBe(1);
    expect(h.histories[1]).toMatchObject([{ action: "click", target: "el_go" }]);
  });

  it("stops after MAX_STEPS without done", async () => {
    const h = harness({ actions: [{ action: "scroll", value: "down", confidence: 0.5, reason: "" }, { action: "scroll", value: "up", confidence: 0.5, reason: "" }] });
    // a fresh target every step, so neither the repeat nor the cycle detector fires first
    let n = 0;
    h.ports.reason = async () => ({ action: "click", target: `el_item_${n++}`, confidence: 0.5, reason: "" });
    const outcome = await runAgent("keep scrolling", h.ports);
    expect(outcome.status).toBe("blocked");
    expect(outcome.steps).toBe(MAX_STEPS);
    expect(outcome.message).toContain(`${MAX_STEPS} steps`);
  });

  it("stops when the reasoner repeats the identical action", async () => {
    const h = harness({ actions: [GO, GO, GO] });
    const outcome = await runAgent("t", h.ports);
    expect(outcome.status).toBe("blocked");
    expect(outcome.steps).toBe(2);
    expect(outcome.message).toMatch(/repeated the same action/);
  });

  it("a consequential block is never performed: the reasoner gets one chance to use an allowed path, then the task is blocked", async () => {
    const refused = { ok: false, message: 'Click on "Buy Now" blocked: it is a purchase action and the task does not ask for one', validation: "blocked" as const, code: "consequential_action" as const };
    const h = harness({ actions: [{ action: "click", target: "el_buy_now", confidence: 1, reason: "" }], results: [refused, refused] });
    const outcome = await runAgent("add to cart, do not buy", h.ports);
    expect(outcome.status).toBe("blocked");
    expect(outcome.code).toBe("SAFETY_BLOCK");
    expect(outcome.steps).toBe(0); // nothing was ever executed
    expect(h.executed).toHaveLength(2); // refused, guided once, refused again
    expect(outcome.message).toMatch(/purchase action/);
  });

  it("a stale target is retried within the step, then the next step continues", async () => {
    const h = harness({
      actions: [GO, GO, DONE],
      results: [
        { ok: false, message: "Target element not found on the current page", validation: "blocked", code: "unknown_target" },
        { ok: true, message: "Clicked el_go", validation: "pass" },
        { ok: true, message: "Task reported as done", validation: "pass" },
      ],
    });
    const outcome = await runAgent("t", h.ports);
    expect(["completed", "unverified"]).toContain(outcome.status);
    expect(outcome.rounds).toBe(3);
    expect(outcome.steps).toBe(2);
  });
});
