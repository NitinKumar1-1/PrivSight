/**
 * Phase 10: general multi-step orchestration. The loop continues until the
 * user's goal is verified, a page-supported blocker survives recovery, a
 * safety/privacy stop, or the execution budget. "done" from the reasoner is
 * a claim, never a verdict. Fake ports; no chrome, no network.
 */

import { describe, expect, it } from "vitest";
import { assessBlockerClaim } from "../../src/agent/completion";
import { DEFAULT_MAX_RECOVERIES, DEFAULT_MAX_STEPS, runAgent, type AgentEvent, type AgentPorts } from "../../src/agent/controller";
import type { ActionRecord } from "../../src/shared/contract";
import { verifySerializedPayload } from "../../src/privacy/leakage";
import type { ApprovedPayload, FirewallVerdict } from "../../src/privacy/types";
import type { ExecuteActionResult, ExtractPageResult } from "../../src/shared/messages";

type Page = { url?: string; title?: string; text?: string; labels?: string[] };
const body = (page: Page = {}) =>
  JSON.stringify({
    task: "t",
    page: { url: page.url ?? "https://shop.example/", title: page.title ?? "Shop", elements: (page.labels ?? []).map((text, i) => ({ id: `el_${i}`, tag: "a", text, role: "link" })), text: page.text ?? "" },
    placeholders: [],
  });

const post = (effect: "url_changed" | "dom_changed" | "no_change"): ExecuteActionResult["postAction"] => ({ effect, mutations: effect === "no_change" ? 0 : 2, urlChanged: effect === "url_changed", titleChanged: false, controlsChanged: effect !== "no_change", modalAppeared: false, modalClosed: false, waitedMs: 5 });
const clicked = (label: string, effect: "url_changed" | "dom_changed" | "no_change" = "dom_changed"): ExecuteActionResult => ({ ok: true, message: `Clicked ${label}`, validation: "pass", postAction: post(effect), trace: { action: "click", target: label, resolution: "ps-id", match: "button", validation: "PASS", execution: "PASS", postAction: effect } });
const OK: ExecuteActionResult = { ok: true, message: "ok", validation: "pass", postAction: post("dom_changed") };
const click = (target: string, reason = "", final = false) => ({ action: "click", target, confidence: 1, reason, final });
const done = (reason = "done", value: string | null = null) => ({ action: "done", value, confidence: 1, reason, final: true });

/**
 * Scripted reasoner: `script[i]` is the answer to the i-th cloud call (the
 * last one repeats). `pages[i]` is the sanitized page of the i-th observation
 * (the last one repeats). `results` map executed actions to executor results
 * by target.
 */
function harness(script: unknown[], pages: Page[] = [{}], results: Record<string, ExecuteActionResult> = {}) {
  const events: AgentEvent[] = [];
  const executed: unknown[] = [];
  const histories: ActionRecord[][] = [];
  const guidances: Array<string | undefined> = [];
  const calls = { reason: 0, extract: 0 };
  let clock = 0;
  const ports: AgentPorts = {
    ensureContentScript: async () => undefined,
    capture: async () => null,
    perceive: async () => null,
    visionInfo: async () => null,
    extract: async (_task, _ocr, history, guidance) => {
      histories.push(history.map((h) => ({ ...h })));
      guidances.push(guidance);
      const page = pages[Math.min(calls.extract++, pages.length - 1)];
      const firewall: FirewallVerdict = { verdict: "allowed", body: body(page) as ApprovedPayload, checks: [] };
      return { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall, visualPrivacy: null } satisfies ExtractPageResult;
    },
    reason: async () => script[Math.min(calls.reason++, script.length - 1)],
    execute: async (action) => {
      executed.push(action);
      const target = (action as { target?: string }).target ?? "";
      return results[target] ?? OK;
    },
    renderMask: async () => null,
    settle: async () => undefined,
    report: (e) => void events.push(e),
    now: () => (clock += 1),
  };
  const states = () => events.filter((e): e is Extract<AgentEvent, { kind: "state" }> => e.kind === "state").map((e) => e.state);
  return { ports, events, executed, histories, guidances, calls, states };
}

const TASK = "Find the wireless headphones on the shop and complete the checkout";

describe("1-5. the loop does not stop on a successful action or on an unverified done", () => {
  it("clicks a product, the reasoner says done, the claim is rejected and the run continues to a verified checkout", async () => {
    const h = harness(
      [click("el_product"), done("product page reached"), click("el_buy", "buy now"), done("on checkout")],
      [{ url: "https://shop.example/s?q=headphones" }, { url: "https://shop.example/p/1" }, { url: "https://shop.example/p/1" }, { url: "https://shop.example/checkout" }],
      { el_product: clicked("Wireless Headphones", "url_changed"), el_buy: clicked("Buy now", "url_changed") },
    );
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome).toMatchObject({ status: "completed", code: "COMPLETED" });
    expect(h.executed.map((a) => (a as { action: string }).action)).toEqual(["click", "done", "click", "done"]);
    expect(outcome.steps).toBe(3); // click, click, done; the rejected done is not a step
    // the reasoner was told, in the request itself, why its claim was rejected
    expect(h.guidances[2]).toMatch(/TASK NOT COMPLETE.*not complete.*recover/i);
    // action success was logged as such, task result as "not complete"
    const first = h.states()[0];
    expect(first).toMatchObject({ step: 1, actionResult: "success", taskResult: "not complete", page: "shop.example" });
  });

  it("the guidance text never carries the reasoner's free text or page values", async () => {
    const h = harness([done("The item is out of stock, contact 9876543210"), done("still out of stock")], [{ text: "out of stock" }]);
    await runAgent(TASK, h.ports);
    for (const g of h.guidances.filter(Boolean)) expect(g).not.toMatch(/9876543210/);
  });
});

describe("6-7. step budget is a limit, not a plan", () => {
  it("executes more than 12 steps when the task needs them and the budget allows", async () => {
    const script: unknown[] = [];
    for (let i = 1; i <= 14; i++) script.push(click(`el_next_${i}`, "next page"));
    script.push(click("el_buy", "buy"), done("checkout reached"));
    // 14 list pages are observed before the 14 "next" clicks, one product page before the buy click, then checkout for the done.
    const pages: Page[] = Array.from({ length: 15 }, (_, i) => ({ url: `https://shop.example/list?page=${i}` }));
    pages.push({ url: "https://shop.example/checkout" });
    const results: Record<string, ExecuteActionResult> = { el_buy: clicked("Buy now", "url_changed") };
    for (let i = 1; i <= 14; i++) results[`el_next_${i}`] = clicked("Next", "url_changed");
    const h = harness(script, pages, results);
    const outcome = await runAgent(TASK, h.ports, { maxSteps: 40 });
    expect(outcome.status).toBe("completed");
    expect(outcome.steps).toBe(16);
    expect(h.states().length).toBeGreaterThanOrEqual(15);
  });

  it("the default budget is well above the old twelve and a run that exhausts it ends as STEP_LIMIT, never SUCCESS", async () => {
    expect(DEFAULT_MAX_STEPS).toBeGreaterThanOrEqual(30);
    let n = 0;
    const h = harness([]);
    h.ports.reason = async () => click(`el_${n++}`, "keep going");
    const outcome = await runAgent(TASK, h.ports, { maxSteps: 7 });
    expect(outcome).toMatchObject({ status: "blocked", code: "STEP_LIMIT", steps: 7 });
  });
});

describe("8, 15. blockers: recover first, block only when the page shows it and recovery fails", () => {
  const OUT_OF_STOCK = { url: "https://shop.example/p/ch520", text: "Wireless Headphones CH520 currently out of stock" };

  it("an out-of-stock product triggers replanning: back to results, another listing, checkout", async () => {
    const h = harness(
      [click("el_ch520"), done("The selected headphones are out of stock", "INSUFFICIENT_EVIDENCE"), click("el_back"), click("el_ch720"), click("el_buy"), done("checkout")],
      [{ url: "https://shop.example/s?q=headphones" }, OUT_OF_STOCK, OUT_OF_STOCK, { url: "https://shop.example/s?q=headphones" }, { url: "https://shop.example/p/ch720" }, { url: "https://shop.example/checkout" }],
      { el_ch520: clicked("CH520", "url_changed"), el_back: clicked("Back to results", "url_changed"), el_ch720: clicked("CH720", "url_changed"), el_buy: clicked("Buy now", "url_changed") },
    );
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome.status).toBe("completed");
    expect(h.executed.map((a) => (a as { target?: string }).target ?? "done")).toEqual(["el_ch520", "done", "el_back", "el_ch720", "el_buy", "done"]);
    expect(h.guidances[2]).toMatch(/blocker \(out of stock\) and the current page shows it/);
  });

  it("a blocker the page does NOT show is treated as an unsupported claim; after the recovery budget the run ends without a fake blocker", async () => {
    const h = harness([click("el_p"), done("out of stock", "INSUFFICIENT_EVIDENCE")], [{ url: "https://shop.example/p/1", text: "In stock. Buy now" }], { el_p: clicked("Product", "url_changed") });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "INSUFFICIENT_EVIDENCE" });
    expect(outcome.message).toMatch(/not shown on the page/);
    expect(h.calls.reason).toBe(2 + DEFAULT_MAX_RECOVERIES);
  });

  it("a page-supported blocker that survives every recovery attempt ends as TASK_BLOCKED with the observed reason", async () => {
    const h = harness([click("el_p"), done("Out of stock: notify me", "INSUFFICIENT_EVIDENCE")], [OUT_OF_STOCK], { el_p: clicked("Product", "url_changed") });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "TASK_BLOCKED" });
    expect(outcome.message).toMatch(/shown on the current page/);
    expect(outcome.message).toMatch(/3 recovery attempt/);
    const final = h.events.filter((e) => e.kind === "status").map((e) => (e.kind === "status" ? e.text : "")).find((t) => t.startsWith("TASK RESULT"));
    expect(final).toMatch(/^TASK RESULT: BLOCKED/);
  });

  it("assessBlockerClaim checks the claimed wording against the current page only", () => {
    const facts = { url: "https://shop.example/p", title: "shop", labels: ["notify me"], text: "this item is currently out of stock" };
    expect(assessBlockerClaim("The headphones are out of stock", facts)).toMatchObject({ claimed: true, supported: true, phrase: "out of stock" });
    expect(assessBlockerClaim("The headphones are out of stock", { ...facts, labels: [], text: "in stock, ships tomorrow" })).toMatchObject({ claimed: true, supported: false });
    expect(assessBlockerClaim("I cannot find genuine products", facts)).toMatchObject({ claimed: true, supported: false, phrase: null });
    expect(assessBlockerClaim("", facts).claimed).toBe(false);
  });
});

describe("9-13. current page, no stale context, state survives navigation and tabs", () => {
  it("the state log names the hostname of the page each step acted on, following navigation", async () => {
    const h = harness([click("el_a"), click("el_b"), done("x")], [{ url: "https://www.flipkart.com/search?q=x" }, { url: "https://www.flipkart.com/p/1" }, { url: "https://www.flipkart.com/checkout" }], { el_a: clicked("A", "url_changed"), el_b: clicked("Buy now", "url_changed") });
    await runAgent("buy the item on flipkart", h.ports);
    expect(h.states().map((s) => s.page)).toEqual(["www.flipkart.com", "www.flipkart.com"]);
  });

  it("the page facts used for verification always come from the latest observation, never an earlier host", async () => {
    // Observation 1 is on one host, observation 2 on another: the completion check reads the latest.
    const h = harness([click("el_go"), done("checkout")], [{ url: "https://www.meesho.com/" }, { url: "https://www.flipkart.com/checkout" }], { el_go: clicked("Buy now", "url_changed") });
    const outcome = await runAgent("buy the item", h.ports);
    // step 1 acted on the first host (logged as such); the done claim was verified against the latest page only
    expect(h.states()[0].page).toBe("www.meesho.com");
    expect(outcome.status).toBe("completed");
    expect(outcome.message).toMatch(/checkout, payment or order page/);
  });

  it("a previous task's history never reaches a new task: each run starts with an empty history", async () => {
    const first = harness([click("el_a"), done("x")], [{ url: "https://one.example/" }], { el_a: clicked("A") });
    await runAgent("open one", first.ports);
    const second = harness([done("nothing")], [{ url: "https://two.example/" }]);
    await runAgent("what is on this page", second.ports);
    expect(second.histories[0]).toEqual([]);
  });

  it("navigation (url change) does not reset the history or the step counter", async () => {
    const h = harness([click("el_a"), click("el_b"), click("el_c"), done("x")], [{ url: "https://a.example/" }, { url: "https://a.example/2" }, { url: "https://a.example/3" }, { url: "https://a.example/checkout" }], { el_a: clicked("A", "url_changed"), el_b: clicked("B", "url_changed"), el_c: clicked("Buy now", "url_changed") });
    await runAgent("buy it", h.ports);
    expect(h.histories.map((x) => x.length)).toEqual([0, 1, 2, 3]);
    expect(h.states().map((s) => s.step)).toEqual([1, 2, 3]);
  });

  it("a cancelled run stops at the next step boundary with CANCELLED and never claims success", async () => {
    let cancelled = false;
    const h = harness([click("el_a"), click("el_b"), done("x")], [{}], { el_a: clicked("A"), el_b: clicked("B") });
    h.ports.isCancelled = () => cancelled;
    h.ports.execute = async (action) => {
      cancelled = true; // a new task starts while this one is acting
      return clicked((action as { target: string }).target);
    };
    const outcome = await runAgent("do things", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "CANCELLED", steps: 1 });
  });
});

describe("14. failed actions trigger recovery, then fail closed", () => {
  it("a failed click is reported to the reasoner as guidance and the run continues", async () => {
    const failed: ExecuteActionResult = { ok: false, message: "The field did not accept the typed text", validation: "pass", code: "action_failed" };
    const h = harness([click("el_bad"), click("el_buy"), done("checkout")], [{ url: "https://shop.example/p" }, { url: "https://shop.example/p" }, { url: "https://shop.example/checkout" }], { el_bad: failed, el_buy: clicked("Buy now", "url_changed") });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome.status).toBe("completed");
    expect(h.guidances[1]).toMatch(/last action failed.*Choose a different way/i);
    expect(h.states()[0]).toMatchObject({ actionResult: "failed", taskResult: "not complete" });
  });

  it("after the failure budget the run ends as ACTION_FAILED", async () => {
    const failed: ExecuteActionResult = { ok: false, message: "did not accept", validation: "pass", code: "action_failed" };
    let n = 0;
    const h = harness([], [{}]);
    h.ports.reason = async () => click(`el_${n++}`);
    h.ports.execute = async () => failed;
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome).toMatchObject({ status: "failed", code: "ACTION_FAILED" });
    expect(n).toBe(3); // two recoveries, then the third failure ends the run
  });
});

describe("16. success only after verification", () => {
  it("a done with the goal visible is SUCCESS with the evidence in the message and in the log", async () => {
    const h = harness([click("el_buy"), done("checkout")], [{ url: "https://shop.example/p" }, { url: "https://shop.example/checkout" }], { el_buy: clicked("Buy now", "url_changed") });
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome).toMatchObject({ status: "completed", code: "COMPLETED" });
    expect(outcome.message).toMatch(/verified: .*checkout/);
    const final = h.events.filter((e) => e.kind === "status").map((e) => (e.kind === "status" ? e.text : "")).find((t) => t.startsWith("TASK RESULT"));
    expect(final).toMatch(/^TASK RESULT: SUCCESS/);
  });
});

describe("17-18. privacy stays in front of every round", () => {
  it("a firewall block on any round stops the run before the cloud is called for that round", async () => {
    const h = harness([click("el_a"), click("el_b")], [{}], { el_a: clicked("A") });
    let n = 0;
    h.ports.extract = async () => {
      n++;
      const firewall: FirewallVerdict = n === 2 ? { verdict: "blocked", reason: "Privacy Firewall blocked request: EMAIL leakage detected", checks: [] } : { verdict: "allowed", body: body({}) as ApprovedPayload, checks: [] };
      return { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall, visualPrivacy: null };
    };
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "PRIVACY_BLOCK" });
    expect(h.calls.reason).toBe(1);
  });

  it("the guidance field is verified by the leakage checker like every other field", () => {
    const ok = JSON.stringify({ task: "t", page: { url: "u", title: "t", elements: [], text: "" }, placeholders: [], guidance: "TASK NOT COMPLETE: recover" });
    expect(verifySerializedPayload(ok, []).safe).toBe(true);
    const tooLong = JSON.stringify({ task: "t", page: { url: "u", title: "t", elements: [], text: "" }, placeholders: [], guidance: "x".repeat(401) });
    expect(verifySerializedPayload(tooLong, []).safe).toBe(false);
    const leaking = JSON.stringify({ task: "t", page: { url: "u", title: "t", elements: [], text: "" }, placeholders: [], guidance: "call 9876543210" });
    expect(verifySerializedPayload(leaking, []).safe).toBe(false);
  });
});

describe("occluded and stale targets are explained to the reasoner on re-observation", () => {
  it("an overlay refusal sends guidance about the overlay before the next observation, and the task then proceeds", async () => {
    const occluded: ExecuteActionResult = { ok: false, message: "Target field cannot be reached: a full-page overlay is covering it", validation: "blocked", code: "target_occluded" };
    const h = harness(
      [{ action: "type", target: "el_q", value: "headphones", confidence: 1, reason: "", final: false }, click("el_close"), click("el_buy"), done("checkout")],
      [{ url: "https://shop.example/" }, { url: "https://shop.example/" }, { url: "https://shop.example/p" }, { url: "https://shop.example/checkout" }],
      { el_q: occluded, el_close: clicked("Close", "dom_changed"), el_buy: clicked("Buy now", "url_changed") },
    );
    const outcome = await runAgent(TASK, h.ports);
    expect(outcome.status).toBe("completed");
    expect(h.guidances[1]).toMatch(/overlay.*close it/i);
    expect(h.guidances[2]).toBeUndefined(); // guidance is per round, never carried over
  });
});

describe("a consequential refusal is fail-closed but not fatal on the first occurrence", () => {
  const refused: ExecuteActionResult = { ok: false, message: 'Click on "Buy Now" blocked: it is a purchase action and the task does not ask for one', validation: "blocked", code: "consequential_action" };

  it("the refused click is never performed; the reasoner is guided to an allowed path and the task completes", async () => {
    const h = harness(
      [click("el_buy_now"), click("el_cart"), click("el_proceed_to_checkout"), done("checkout")],
      [{ url: "https://shop.example/p/1" }, { url: "https://shop.example/p/1" }, { url: "https://shop.example/cart" }, { url: "https://shop.example/checkout" }],
      { el_buy_now: refused, el_cart: clicked("Cart", "url_changed"), el_proceed_to_checkout: clicked("Proceed to checkout", "url_changed") },
    );
    const outcome = await runAgent("Find the wireless headphones and complete the checkout", h.ports);
    expect(outcome.status).toBe("completed");
    expect(h.guidances[1]).toMatch(/refused by the local policy and NOT performed.*proceed-to-checkout/);
    expect(h.states()[0]).toMatchObject({ actionResult: "blocked", taskResult: "not complete" });
    expect(outcome.steps).toBe(3);
  });

  it("a second refusal ends the run as SAFETY_BLOCK", async () => {
    const h = harness([click("el_buy_now"), click("el_place_order")], [{ url: "https://shop.example/p/1" }], { el_buy_now: refused, el_place_order: { ...refused, message: 'Click on "Place order" blocked: it is a purchase action and the task does not ask for one' } });
    const outcome = await runAgent("Find the wireless headphones and complete the checkout", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "SAFETY_BLOCK", browserActed: false });
    expect(h.executed).toHaveLength(2);
  });
});

describe("cycles are no progress; a verified goal ends a cycle as success", () => {
  it("A-B-A-B alternation without the goal ends as NO_PROGRESS", async () => {
    let n = 0;
    const h = harness([], [{ url: "https://wiki.example/a" }, { url: "https://wiki.example/b" }]);
    h.ports.reason = async () => click(n++ % 2 === 0 ? "el_a" : "el_b");
    h.ports.execute = async (action) => clicked((action as { target: string }).target, "url_changed");
    const outcome = await runAgent("Find the wireless headphones and complete the checkout", h.ports);
    expect(outcome).toMatchObject({ status: "blocked", code: "NO_PROGRESS" });
    expect(outcome.message).toMatch(/cycling/);
    expect(outcome.steps).toBeLessThanOrEqual(6);
  });

  it("A-B-A-B alternation on a page that already verifies the goal ends as SUCCESS on the evidence", async () => {
    let n = 0;
    const h = harness([], [{ url: "https://shop.example/checkout" }]);
    h.ports.reason = async () => click(n++ % 2 === 0 ? "el_a" : "el_b");
    h.ports.execute = async (action) => clicked((action as { target: string }).target === "el_a" ? "Buy now" : "Details", "url_changed");
    const outcome = await runAgent("Find the wireless headphones and complete the checkout", h.ports);
    expect(outcome).toMatchObject({ status: "completed", code: "COMPLETED" });
    expect(outcome.message).toMatch(/Goal verified/);
  });
});

describe("late renders: an effect the executor missed is corrected from the next observation", () => {
  it("a click recorded as no_change becomes dom_changed when the next observation differs, before the reasoner sees the history", async () => {
    const h = harness(
      [click("el_view"), click("el_buy"), done("checkout")],
      [{ url: "https://shop.example/list", labels: ["View A", "View B"] }, { url: "https://shop.example/list", labels: ["View A", "View B", "Buy now", "Add to cart"] }, { url: "https://shop.example/checkout" }],
      { el_view: clicked("View A", "no_change"), el_buy: clicked("Buy now", "url_changed") },
    );
    const outcome = await runAgent("Find the wireless headphones and complete the checkout", h.ports);
    expect(outcome.status).toBe("completed");
    // the round's request was rebuilt locally after the correction: a later extraction carries the corrected record
    expect(h.histories.some((hist) => hist[0]?.effect === "dom_changed" && /late render/.test(hist[0].note ?? ""))).toBe(true);
    expect(h.histories[1][0].effect).toBe("no_change"); // the first, uncorrected extraction
  });
});

describe("an identical repeat is first answered with guidance, not executed", () => {
  it("type, then the same type again: the second is skipped with guidance; the reasoner then submits and the task completes", async () => {
    const type = { action: "type", target: "el_q", value: "red shirt", confidence: 1, reason: "", final: false };
    const press = { action: "press", target: "el_q", value: "Enter", confidence: 1, reason: "", final: false };
    const h = harness([type, type, press, click("el_buy"), done("checkout")], [{ url: "https://shop.example/" }, { url: "https://shop.example/" }, { url: "https://shop.example/" }, { url: "https://shop.example/s?q=red+shirt" }, { url: "https://shop.example/checkout" }], { el_q: { ok: true, message: "typed", validation: "pass", postAction: post("no_change") }, el_buy: clicked("Buy now", "url_changed") });
    h.ports.execute = async (action) => {
      h.executed.push(action);
      const a = action as { action: string; target?: string };
      if (a.action === "press") return { ok: true, message: "pressed", validation: "pass", postAction: post("url_changed") };
      if (a.target === "el_buy") return clicked("Buy now", "url_changed");
      return { ok: true, message: "typed", validation: "pass", postAction: post("no_change") };
    };
    const outcome = await runAgent("search for a red shirt and complete the checkout", h.ports);
    expect(h.executed.map((a) => (a as { action: string }).action)).toEqual(["type", "press", "click", "done"]); // the repeat was never executed
    expect(h.guidances.some((g) => /same action you just performed/.test(g ?? ""))).toBe(true);
    expect(outcome.status).toBe("completed");
  });
});
