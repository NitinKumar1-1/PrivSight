/**
 * Phase 9 (hardening): completion is a verified state. The model claims;
 * local evidence decides. Pure verifier tests plus the controller wiring.
 */

import { describe, expect, it } from "vitest";
import { cartCount, goalOf, pageFactsFromBody, verifyCompletion, type PageFacts } from "../../src/agent/completion";
import { runAgent, type AgentEvent, type AgentPorts } from "../../src/agent/controller";
import type { ActionRecord } from "../../src/shared/contract";
import type { ApprovedPayload, FirewallVerdict } from "../../src/privacy/types";
import type { ExecuteActionResult, ExtractPageResult } from "../../src/shared/messages";

const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ url: "https://shop.example/", title: "shop", labels: [], text: "", ...over });
const rec = (over: Partial<ActionRecord>): ActionRecord => ({ action: "click", target: "el_x", value: null, effect: "dom_changed", ...over });

describe("goal recognition (generic wording, no sites)", () => {
  it.each([
    ["Search for black shirt on the website", "search"],
    ["find the cheapest black shirt", "search"],
    ["Add the black shirt to cart", "cart"],
    ["put a black shirt in my basket", "cart"],
    ["Buy the cheapest black shirt", "purchase"],
    ["Buy me a black shirt and add it to cart", "cart"],
    ["open the Alan Turing article", "open"],
    ["what is the price on this page", "other"],
  ])("%s -> %s", (task, goal) => expect(goalOf(task)).toBe(goal));
});

describe("search completion", () => {
  it("typing without submission is NOT completion", () => {
    const v = verifyCompletion("Search for black shirt", [rec({ action: "type", value: "black shirt", effect: "no_change" })], [facts(), facts()]);
    expect(v.state).toBe("not_complete");
    expect(v.missing).toMatch(/never submitted/);
  });

  it("a submitted search that navigated to a results url is verified", () => {
    const history = [rec({ action: "type", value: "black shirt", effect: "no_change" }), rec({ action: "press", value: "Enter", effect: "url_changed" })];
    const v = verifyCompletion("Search for black shirt", history, [facts(), facts({ url: "https://shop.example/search?q=black+shirt" })]);
    expect(v.state).toBe("verified");
    expect(v.evidence.join(" ")).toMatch(/results page|search query/);
  });

  it("a submitted search whose results rendered in place (url unchanged) is verified by the results text", () => {
    const history = [rec({ action: "type", value: "black shirt", effect: "no_change" }), rec({ action: "click", label: "Search", effect: "dom_changed" })];
    const v = verifyCompletion("Search for black shirt", history, [facts(), facts({ text: "showing 120 results for black shirt" })]);
    expect(v.state).toBe("verified");
  });

  it("a click after typing that changed the page but shows no results is unverified, not complete", () => {
    const history = [rec({ action: "type", value: "black shirt", effect: "no_change" }), rec({ action: "click", label: "Menu", effect: "dom_changed" })];
    const v = verifyCompletion("Search for black shirt", history, [facts(), facts()]);
    expect(v.state).toBe("unverified");
  });

  it("a false done with no action at all is not complete", () => {
    const v = verifyCompletion("Search for black shirt", [], [facts()]);
    expect(v.state).toBe("not_complete");
  });

  it("a results page already open (query in url) counts even without actions", () => {
    const v = verifyCompletion("find black shirts", [], [facts({ url: "https://shop.example/s?k=black+shirt", text: "results for black shirt" })]);
    expect(v.state).toBe("verified");
  });
});

describe("cart completion", () => {
  it("a click alone is not enough; the cart count going up is", () => {
    const click = rec({ label: "Add to cart" });
    const noEvidence = verifyCompletion("Add the black shirt to cart", [click], [facts({ labels: ["cart"] }), facts({ labels: ["cart"] })]);
    expect(noEvidence.state).toBe("unverified");
    const counted = verifyCompletion("Add the black shirt to cart", [click], [facts({ labels: ["0 items in cart"] }), facts({ labels: ["1 item in cart"] })]);
    expect(counted.state).toBe("verified");
    expect(counted.evidence).toContain("the cart count went up");
  });

  it("an added-to-cart confirmation or a go-to-cart control appearing verifies the add", () => {
    const click = rec({ label: "Add to cart" });
    expect(verifyCompletion("add it to cart", [click], [facts(), facts({ text: "added to cart successfully" })]).state).toBe("verified");
    expect(verifyCompletion("add it to cart", [click], [facts({ labels: ["add to cart"] }), facts({ labels: ["go to cart"] })]).state).toBe("verified");
  });

  it("executor-measured cart evidence on the click record verifies without page facts", () => {
    const v = verifyCompletion("add it to cart", [rec({ label: "Add to cart", cartAdded: true })], [null, null]);
    expect(v.state).toBe("verified");
  });

  it("done without any add-to-cart click is not complete; a no-effect add-to-cart click is not complete", () => {
    expect(verifyCompletion("add it to cart", [rec({ label: "Open product" })], [facts(), facts()]).state).toBe("not_complete");
    expect(verifyCompletion("add it to cart", [rec({ label: "Add to cart", effect: "no_change" })], [facts(), facts()]).state).toBe("not_complete");
  });

  it("reads cart counts from labels in several shapes", () => {
    expect(cartCount(facts({ labels: ["cart (3)"] }))).toBe(3);
    expect(cartCount(facts({ labels: ["2 items in cart"] }))).toBe(2);
    expect(cartCount(facts({ labels: ["basket 5"] }))).toBe(5);
    expect(cartCount(facts({ labels: ["cart"] }))).toBeNull();
  });
});

describe("purchase completion", () => {
  it("a buy click that reached checkout is verified; a click that went nowhere is unverified; no click is not complete", () => {
    const buy = rec({ label: "Buy now", effect: "url_changed" });
    expect(verifyCompletion("Buy the cheapest black shirt", [buy], [facts(), facts({ url: "https://shop.example/checkout" })]).state).toBe("verified");
    expect(verifyCompletion("Buy the cheapest black shirt", [buy], [facts(), facts()]).state).toBe("unverified");
    expect(verifyCompletion("Buy the cheapest black shirt", [rec({ label: "Open" })], [facts(), facts()]).state).toBe("not_complete");
  });
});

describe("page facts come only from the sanitized body", () => {
  it("parses url, title, labels and text; tolerates garbage", () => {
    const body = JSON.stringify({ task: "t", page: { url: "https://x.example/A", title: "Shop", elements: [{ id: "el_1", tag: "a", text: "Cart (1)", role: "link" }], text: "Hello" }, placeholders: [] });
    expect(pageFactsFromBody(body)).toEqual({ url: "https://x.example/a", title: "shop", labels: ["cart (1)"], text: "hello" });
    expect(pageFactsFromBody("{not json")).toBeNull();
  });
});

// --- controller wiring -------------------------------------------------------------

function ports(actions: unknown[], bodies: string[], results: Array<ExecuteActionResult | undefined> = []) {
  const events: AgentEvent[] = [];
  const executed: unknown[] = [];
  let reasonCalls = 0;
  let extractCalls = 0;
  let clock = 0;
  const p: AgentPorts = {
    ensureContentScript: async () => undefined,
    capture: async () => null,
    perceive: async () => null,
    visionInfo: async () => null,
    extract: async () => {
      const body = bodies[Math.min(extractCalls++, bodies.length - 1)] as ApprovedPayload;
      const firewall: FirewallVerdict = { verdict: "allowed", body, checks: [] };
      return { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall, visualPrivacy: null } satisfies ExtractPageResult;
    },
    reason: async () => actions[Math.min(reasonCalls++, actions.length - 1)],
    execute: async (action) => {
      executed.push(action);
      return results[executed.length - 1] ?? { ok: true, message: "ok", validation: "pass" };
    },
    renderMask: async () => null,
    report: (e) => void events.push(e),
    now: () => (clock += 1),
  };
  return { p, events, executed };
}
const body = (page: Record<string, unknown>) => JSON.stringify({ task: "t", page: { url: "https://shop.example/", title: "Shop", elements: [], text: "", ...page }, placeholders: [] });

describe("controller: DONE is verified locally", () => {
  it("false DONE on a cart task with nothing added is rejected once, then ends as insufficient evidence, never Complete", async () => {
    const { p, executed } = ports([{ action: "done", confidence: 1, reason: "added", final: true }], [body({})]);
    const outcome = await runAgent("Add the black shirt to cart", p);
    expect(outcome).toMatchObject({ status: "blocked", code: "INSUFFICIENT_EVIDENCE", browserActed: false });
    expect(executed.length).toBeGreaterThanOrEqual(2); // the claim was sent back with recovery guidance, never accepted
  });

  it("a cart task completes only when the observation after the click shows cart evidence", async () => {
    const click = { action: "click", target: "el_atc", confidence: 1, reason: "add", final: true };
    const clicked: ExecuteActionResult = { ok: true, message: "Clicked el_atc", validation: "pass", trace: { action: "click", target: "Add to cart", resolution: "ps-id", match: "button", validation: "PASS", execution: "PASS", postAction: "dom_changed" }, postAction: { effect: "dom_changed", mutations: 2, urlChanged: false, titleChanged: false, controlsChanged: true, modalAppeared: false, modalClosed: false, waitedMs: 10 } };
    const done = { action: "done", confidence: 1, reason: "added", final: true };
    const { p } = ports([click, done], [body({ elements: [{ id: "el_c", tag: "a", text: "Cart (0)", role: "link" }] }), body({ elements: [{ id: "el_c", tag: "a", text: "Cart (1)", role: "link" }] })], [clicked]);
    const outcome = await runAgent("Add the black shirt to cart", p);
    expect(outcome).toMatchObject({ status: "completed", code: "COMPLETED" });
    expect(outcome.message).toMatch(/cart count went up/);
  });

  it("the same cart flow without any cart signal on the page ends unverified with the friendly code", async () => {
    const click = { action: "click", target: "el_atc", confidence: 1, reason: "add", final: true };
    const clicked: ExecuteActionResult = { ok: true, message: "Clicked el_atc", validation: "pass", trace: { action: "click", target: "Add to cart", resolution: "ps-id", match: "button", validation: "PASS", execution: "PASS", postAction: "dom_changed" }, postAction: { effect: "dom_changed", mutations: 2, urlChanged: false, titleChanged: false, controlsChanged: true, modalAppeared: false, modalClosed: false, waitedMs: 10 } };
    const { p } = ports([click, { action: "done", confidence: 1, reason: "added", final: true }], [body({})], [clicked]);
    const outcome = await runAgent("Add the black shirt to cart", p);
    expect(outcome).toMatchObject({ status: "unverified", code: "COMPLETION_UNVERIFIED", browserActed: true });
  });

  it("search: typing then DONE is rejected; after Enter navigates to a results url the DONE is verified", async () => {
    const type = { action: "type", target: "el_q", value: "black shirt", confidence: 1, reason: "", final: false };
    const press = { action: "press", target: "el_q", value: "Enter", confidence: 1, reason: "", final: false };
    const done = { action: "done", confidence: 1, reason: "results shown", final: true };
    const typed: ExecuteActionResult = { ok: true, message: "typed", validation: "pass", postAction: { effect: "no_change", mutations: 0, urlChanged: false, titleChanged: false, controlsChanged: false, modalAppeared: false, modalClosed: false, waitedMs: 5 } };
    const pressed: ExecuteActionResult = { ok: true, message: "pressed", validation: "pass", postAction: { effect: "url_changed", mutations: 9, urlChanged: true, titleChanged: true, controlsChanged: true, modalAppeared: false, modalClosed: false, waitedMs: 50 } };
    const { p, executed } = ports([type, done, press, done], [body({}), body({}), body({}), body({ url: "https://shop.example/search?q=black+shirt", text: "results for black shirt" })], [typed, undefined, pressed]);
    const outcome = await runAgent("Search for black shirt", p);
    expect(outcome).toMatchObject({ status: "completed", code: "COMPLETED", steps: 3 });
    expect(executed.map((a) => (a as { action: string }).action)).toEqual(["type", "done", "press", "done"]);
  });

  it("the rejected done is shown to the reasoner as a history note and does not count as a step", async () => {
    const type = { action: "type", target: "el_q", value: "black shirt", confidence: 1, reason: "", final: false };
    const done = { action: "done", confidence: 1, reason: "typed", final: true };
    const histories: ActionRecord[][] = [];
    const { p } = ports([type, done, done], [body({})]);
    p.extract = (async (_t, _o, history) => {
      histories.push(history.map((h) => ({ ...h })));
      return { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall: { verdict: "allowed", body: body({}) as ApprovedPayload, checks: [] }, visualPrivacy: null };
    }) as AgentPorts["extract"];
    const outcome = await runAgent("Search for black shirt", p);
    expect(histories[2].map((h) => h.action)).toEqual(["type", "done"]);
    expect(histories[2][1].note).toMatch(/rejected locally/);
    expect(outcome.steps).toBe(2); // type + the final done
    expect(outcome.status).toBe("unverified");
  });
});

describe("controller: a refused repeated cart add ends as verified complete when the cart evidence is there", () => {
  it("the model asks to add again; the validator refuses; local evidence (cart count went up) completes the task", async () => {
    const click = { action: "click", target: "el_atc", confidence: 1, reason: "add", final: false };
    const clicked: ExecuteActionResult = { ok: true, message: "Clicked el_atc", validation: "pass", trace: { action: "click", target: "Add to cart", resolution: "ps-id", match: "button", validation: "PASS", execution: "PASS", postAction: "dom_changed" }, postAction: { effect: "dom_changed", mutations: 2, urlChanged: false, titleChanged: false, controlsChanged: true, modalAppeared: false, modalClosed: false, waitedMs: 10 }, cartEvidence: { countBefore: 0, countAfter: 1, confirmationAppeared: false, goToCartAppeared: false, dialogAppeared: false, added: true } };
    const refused: ExecuteActionResult = { ok: false, message: "Repeated action refused: the cart already shows this item was added", validation: "blocked", code: "repeated_action" };
    const { p, executed } = ports([click, { ...click, target: "el_atc2" }], [body({ elements: [{ id: "el_c", tag: "a", text: "0 items in cart", role: "link" }] }), body({ elements: [{ id: "el_c", tag: "a", text: "1 item in cart", role: "link" }] })], [clicked, refused]);
    const outcome = await runAgent("Add the black shirt to cart", p);
    expect(outcome).toMatchObject({ status: "completed", code: "COMPLETED", steps: 1 });
    expect(outcome.message).toMatch(/already verified/);
    expect(executed).toHaveLength(2);
  });

  it("without cart evidence the refused repeat stays a blocked REPEATED_ACTION, never Complete", async () => {
    const click = { action: "click", target: "el_atc", confidence: 1, reason: "add", final: false };
    const clicked: ExecuteActionResult = { ok: true, message: "Clicked el_atc", validation: "pass", trace: { action: "click", target: "Add to cart", resolution: "ps-id", match: "button", validation: "PASS", execution: "PASS", postAction: "dom_changed" } };
    const refused: ExecuteActionResult = { ok: false, message: "Repeated action refused: used 2 times", validation: "blocked", code: "repeated_action" };
    // Two different add-to-cart controls (listing, then dialog) with no cart signal, then a third attempt.
    const { p } = ports([click, { ...click, target: "el_atc_dialog" }, { ...click, target: "el_x" }], [body({})], [clicked, clicked, refused]);
    const outcome = await runAgent("Add the black shirt to cart", p);
    expect(outcome).toMatchObject({ status: "blocked", code: "REPEATED_ACTION" });
  });
});
