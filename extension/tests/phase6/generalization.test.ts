/**
 * Phase 6: the controller and fusion carry no page-specific decisions.
 *
 * 1. Whatever the reasoner returns is what reaches the validator/executor;
 *    the controller never substitutes, remaps or invents a target.
 * 2. Page facts shown in the popup come from the sanitized body only.
 * 3. Name/price pairing works for general price lines, not only "Price:".
 */

import { describe, expect, it } from "vitest";
import { runAgent, type AgentEvent, type AgentPorts } from "../../src/agent/controller";
import { domProductPrices } from "../../src/content/fusion";
import type { ApprovedPayload, FirewallVerdict } from "../../src/privacy/types";
import type { ExecuteActionResult, ExtractPageResult } from "../../src/shared/messages";

const BODY = {
  task: "Find the search box",
  page: { url: "https://example.org/some/path", title: "Example Site", elements: [{ id: "el_search", tag: "input", text: "", role: "textbox" }, { id: "el_home", tag: "a", text: "Home", role: "link" }], text: "Example Site Home" },
  placeholders: ["[EMAIL_1]"],
  visual: { engine: "test-ocr", observations: [{ type: "text", text: "Example", bbox: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9, target: null }], conflicts: [] },
};

function ports(reasonerOutput: unknown, executed: unknown[], events: AgentEvent[]): AgentPorts {
  const firewall: FirewallVerdict = { verdict: "allowed", body: JSON.stringify(BODY) as ApprovedPayload, checks: [] };
  const extracted: ExtractPageResult = { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall, visualPrivacy: null };
  let clock = 0;
  let reasonCalls = 0;
  return {
    ensureContentScript: async () => undefined,
    capture: async () => null,
    perceive: async () => null,
    visionInfo: async () => null,
    extract: async () => extracted,
    // The first answer is the output under test; a final action is then verified on the next observation, where the reasoner confirms.
    reason: async () => (reasonCalls++ === 0 ? reasonerOutput : { action: "done", confidence: 1, reason: "confirmed" }),
    execute: async (action) => {
      executed.push(action);
      return { ok: true, message: "ok", validation: "pass" } as ExecuteActionResult;
    },
    renderMask: async () => null,
    report: (event) => void events.push(event),
    now: () => (clock += 1),
  };
}

describe("controller passes the reasoner's action through untouched", () => {
  it.each([
    { action: "click", target: "el_search", confidence: 0.8, reason: "search box", final: true },
    { action: "scroll", value: "down", confidence: 0.7, reason: "look further", final: true },
    { action: "done", confidence: 1, reason: "heading found: Example Site" },
    { action: "click", target: "el_home", confidence: 0.5, reason: "home link", final: true },
  ])("$action -> executor receives exactly that object", async (output) => {
    const executed: unknown[] = [];
    const outcome = await runAgent("any task", ports(output, executed, []));
    expect(["completed", "unverified"]).toContain(outcome.status); // the fake page offers no completion evidence
    expect(executed[0]).toEqual(output);
  });

  it("a validator block on the returned target is reported as blocked, never replaced by another target", async () => {
    const executed: unknown[] = [];
    const events: AgentEvent[] = [];
    const p = ports({ action: "click", target: "el_missing", confidence: 0.9, reason: "" }, executed, events);
    p.reason = async () => ({ action: "click", target: "el_missing", confidence: 0.9, reason: "" }); // the same answer every round
    p.execute = async (action) => {
      executed.push(action);
      return { ok: false, message: "Target element not found on the current page", validation: "blocked", code: "unknown_target" };
    };
    const outcome = await runAgent("any task", p);
    expect(outcome.status).toBe("blocked");
    expect(new Set(executed.map((a) => JSON.stringify(a))).size).toBe(1); // same object every round, no substitution
  });

  it("reports page facts from the sanitized body: host, counts, no raw text", async () => {
    const events: AgentEvent[] = [];
    await runAgent("any task", ports({ action: "done", confidence: 1, reason: "" }, [], events));
    const page = events.find((e) => e.kind === "page");
    expect(page).toEqual({ kind: "page", title: "Example Site", host: "example.org", elements: 2, placeholders: 1, visualObservations: 1 });
    expect(JSON.stringify(page)).not.toContain("some/path");
  });
});

describe("domProductPrices is layout-general", () => {
  it("pairs a name with a bare currency amount on the next line", () => {
    const prices = domProductPrices("Wireless Mouse\n₹1,299\nMechanical Keyboard\nRs 4,999\nUSB Cable\n$20");
    expect(prices.get("wireless mouse")).toBe(1299);
    expect(prices.get("mechanical keyboard")).toBe(4999);
    expect(prices.get("usb cable")).toBe(20);
  });

  it("still pairs the labelled form and ignores a name followed by prose", () => {
    const prices = domProductPrices("Black Shirt A\nPrice: ₹799\nAbout us\nWe ship everywhere");
    expect(prices.get("black shirt a")).toBe(799);
    expect(prices.has("about us")).toBe(false);
  });
});
