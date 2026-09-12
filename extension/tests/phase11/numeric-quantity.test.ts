/**
 * Phase 11 (evaluator demos): numeric fields are distinct. A requested
 * quantity is preserved through the run and verified on the page; a price
 * target is a documented policy the reasoner is reminded of every round.
 */

import { describe, expect, it } from "vitest";
import { shownQuantity, verifyCompletion, type PageFacts } from "../../src/agent/completion";
import { runAgent, type AgentPorts } from "../../src/agent/controller";
import { priceTargetOf, requestedQuantityOf, taskConstraintsGuidance } from "../../src/agent/task-facts";
import type { ActionRecord } from "../../src/shared/contract";
import { verifySerializedPayload } from "../../src/privacy/leakage";
import type { ApprovedPayload } from "../../src/privacy/types";
import type { ExecuteActionResult } from "../../src/shared/messages";

const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ url: "https://shop.example/", title: "shop", labels: [], text: "", ...over });
const rec = (over: Partial<ActionRecord>): ActionRecord => ({ action: "click", target: "el_x", value: null, effect: "dom_changed", ...over });

describe("task facts: quantity and price target are separate fields", () => {
  it.each([
    ["Find a red men's shirt around ₹500 and add 500 units to the cart.", 500, { kind: "around", amount: 500, currency: "₹" }],
    ["Buy the cheapest red men's shirt and add 500 units to the cart.", 500, null],
    ["Find a shirt around ₹500.", null, { kind: "around", amount: 500, currency: "₹" }],
    ["Add 500 units of the selected shirt to the cart.", 500, null],
    ["Find a shirt for ₹500.", null, { kind: "exact", amount: 500, currency: "₹" }],
    ["shirts under 800 rupees, quantity 3", 3, { kind: "max", amount: 800, currency: "₹" }],
    ["Add the black shirt to the cart", null, null],
  ])("%s", (task, quantity, price) => {
    expect(requestedQuantityOf(task)).toBe(quantity);
    expect(priceTargetOf(task)).toEqual(price);
  });

  it("the guidance names the policy and never treats the quantity as a price", () => {
    const g = taskConstraintsGuidance("Find a red men's shirt around ₹500 and add 500 units to the cart.");
    expect(g).toMatch(/price target ₹500: only ₹400-₹600 qualifies/);
    expect(g).toMatch(/requested quantity 500: a QUANTITY, not a price/);
    expect(g.length).toBeLessThanOrEqual(300);
    expect(taskConstraintsGuidance("open the news")).toBe("");
  });
});

describe("quantity verification: attempted is not accepted", () => {
  const added = rec({ label: "Add to Cart", cartAdded: true });
  it("verified only when the page shows the requested quantity", () => {
    expect(shownQuantity(facts({ text: "Qty: 500 in stock" }))).toBe(500);
    expect(verifyCompletion("add 500 units to the cart", [added], [facts(), facts({ text: "qty: 500 added to cart" })]).state).toBe("verified");
  });
  it("the page showing 250 after asking for 500 is NOT complete", () => {
    const v = verifyCompletion("add 500 units to the cart", [added], [facts(), facts({ text: "Qty: 250 added to cart" })]);
    expect(v.state).toBe("not_complete");
    expect(v.missing).toMatch(/shows quantity 250, not the requested 500/);
  });
  it("an add with no quantity shown is unverified, never success", () => {
    expect(verifyCompletion("add 500 units to the cart", [added], [facts(), facts({ text: "added to cart" })]).state).toBe("unverified");
  });
  it("without a requested quantity the cart rule is unchanged", () => {
    expect(verifyCompletion("add it to the cart", [added], [facts(), facts({ text: "added to cart" })]).state).toBe("verified");
  });
});

describe("controller: constraints reach the reasoner every round and pass the leakage verifier", () => {
  it("the guidance field carries the price policy and the quantity on round 1 and later rounds", async () => {
    const guidances: Array<string | undefined> = [];
    let n = 0;
    const ports: AgentPorts = {
      ensureContentScript: async () => undefined,
      capture: async () => null,
      perceive: async () => null,
      visionInfo: async () => null,
      extract: async (_t, _o, _h, guidance) => {
        guidances.push(guidance);
        const body = JSON.stringify({ task: "t", page: { url: "https://shop.example/", title: "Shop", elements: [], text: "" }, placeholders: [], ...(guidance ? { guidance } : {}) });
        expect(verifySerializedPayload(body, []).safe).toBe(true);
        return { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall: { verdict: "allowed", body: body as ApprovedPayload, checks: [] }, visualPrivacy: null };
      },
      reason: async () => (n++ === 0 ? { action: "click", target: "el_p", confidence: 1, reason: "", final: false } : { action: "done", confidence: 1, reason: "", final: true }),
      execute: async () => ({ ok: true, message: "ok", validation: "pass" } as ExecuteActionResult),
      renderMask: async () => null,
      report: () => undefined,
      now: () => 0,
    };
    await runAgent("Find a red men's shirt around ₹500 and add 500 units to the cart.", ports);
    expect(guidances.length).toBeGreaterThanOrEqual(2);
    for (const g of guidances) expect(g).toMatch(/TASK CONSTRAINTS: price target ₹500.*requested quantity 500/);
  });
});

describe("goal recognition ignores negated sentences", () => {
  it("'add ... to the cart. Do not buy anything.' is a cart goal, not a purchase goal", async () => {
    const { goalOf } = await import("../../src/agent/completion");
    expect(goalOf("Search for a black shirt and add the cheapest black shirt to the cart. Do not buy anything.")).toBe("cart");
    expect(goalOf("Add the black shirt to the cart. Do not proceed to checkout.")).toBe("cart");
    expect(goalOf("Buy the cheapest black shirt.")).toBe("purchase");
  });
});
