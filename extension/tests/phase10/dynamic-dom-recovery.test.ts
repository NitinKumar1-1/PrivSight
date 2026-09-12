/**
 * Phase 10: controlled dynamic-DOM recovery. Target identity is not DOM node
 * identity: a recreated node is re-identified from current evidence, a
 * volatile label (countdown) never makes a live node "changed", and a target
 * that is really gone stays fail-closed. Proof lines are printed per round.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, type AgentEvent, type AgentPorts } from "../../src/agent/controller";
import { handleExecuteAction, handleExtractPage } from "../../src/content/handlers";
import { sameStableName, stripVolatile } from "../../src/content/volatile";
import type { ExecuteActionResult } from "../../src/shared/messages";

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => ({ width: 200, height: 40, top: 10, left: 10, right: 210, bottom: 50, x: 10, y: 10, toJSON: () => ({}) });
  Element.prototype.scrollIntoView = vi.fn();
});

const ids = (extracted: Awaited<ReturnType<typeof handleExtractPage>>) =>
  extracted.ok ? (JSON.parse(extracted.firewall.body).page.elements as Array<{ id: string; text: string }>) : [];

describe("volatile labels", () => {
  it("strips countdowns, counters and relative times; keeps the descriptive words", () => {
    expect(stripVolatile("6 more 01h 55m 48s Classy Ravish Men Shirt ₹299")).toBe("classy ravish men shirt ₹299");
    expect(stripVolatile("6 more 01h 55m 45s Classy Ravish Men Shirt ₹299")).toBe("classy ravish men shirt ₹299");
  });

  it("same control with a ticked timer is the same name; a relabelled control is not", () => {
    expect(sameStableName(stripVolatile("6 more 01h 55m 48s Classy Ravish"), stripVolatile("6 more 01h 55m 45s Classy Ravish"))).toBe(true);
    expect(sameStableName("add to cart", "go to cart")).toBe(false);
    expect(sameStableName("classy ravish men shirt ₹299 free delivery", "classy ravish men shirt ₹299")).toBe(true);
  });
});

describe("controlled dynamic-DOM tests through the live handlers", () => {
  it("static button: observe, click, executed once", async () => {
    document.body.innerHTML = `<button data-test-product="shirt">Red Shirt</button>`;
    await handleExtractPage("open the red shirt");
    const clicks = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicks);
    const result = await handleExecuteAction({ action: "click", target: "el_red_shirt", confidence: 1, reason: "" });
    expect(result.ok).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("node replaced after observation: old node discarded, CURRENT node re-identified, validated and clicked", async () => {
    document.body.innerHTML = `<div id="list"><button data-test-product="shirt">Red Shirt</button></div>`;
    const first = ids(await handleExtractPage("open the red shirt"));
    expect(first[0].id).toBe("el_red_shirt");
    const old = document.querySelector("button") as HTMLButtonElement;
    const oldClicks = vi.fn();
    old.addEventListener("click", oldClicks);
    document.getElementById("list")!.innerHTML = `<button data-test-product="shirt">Red Shirt</button>`; // the original node is now detached
    expect(old.isConnected).toBe(false);
    const fresh = document.querySelector("button") as HTMLButtonElement;
    const freshClicks = vi.fn();
    fresh.addEventListener("click", freshClicks);
    const result = await handleExecuteAction({ action: "click", target: "el_red_shirt", confidence: 1, reason: "" });
    expect(result.ok).toBe(true);
    expect(freshClicks).toHaveBeenCalledTimes(1);
    expect(oldClicks).not.toHaveBeenCalled(); // the stale node is never executed
    expect(fresh.getAttribute("data-ps-id")).toBe("el_red_shirt"); // the current node now carries the identity
  });

  it("volatile label: a card whose countdown ticks between observation and execution is NOT stale", async () => {
    document.body.innerHTML = `<a href="#p">6 more 01h 55m 48s Classy Ravish Men Shirt</a>`;
    const seen = ids(await handleExtractPage("select a suitable red shirt"));
    expect(seen[0].id).toBe("el_classy_ravish_men_shirt"); // the id carries no timer
    document.querySelector("a")!.textContent = "6 more 01h 55m 45s Classy Ravish Men Shirt"; // the timer ticked
    const clicks = vi.fn();
    document.querySelector("a")!.addEventListener("click", clicks);
    const result = await handleExecuteAction({ action: "click", target: seen[0].id, confidence: 1, reason: "" });
    expect(result.ok).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("re-observation assigns the same id to a re-rendered card with a different timer value", async () => {
    document.body.innerHTML = `<div id="list"><a href="#p">6 more 01h 55m 48s Classy Ravish Men Shirt</a></div>`;
    const a = ids(await handleExtractPage("select a suitable red shirt"))[0].id;
    document.getElementById("list")!.innerHTML = `<a href="#p">6 more 01h 55m 20s Classy Ravish Men Shirt</a>`;
    const b = ids(await handleExtractPage("select a suitable red shirt"))[0].id;
    expect(b).toBe(a);
  });

  it("relabelled control is still stale; a control that is really gone stays fail-closed", async () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    await handleExtractPage("add it to the cart");
    document.querySelector("button")!.textContent = "Go to cart";
    expect((await handleExecuteAction({ action: "click", target: "el_add_to_cart", confidence: 1, reason: "" })).code).toBe("unknown_target");
    document.body.innerHTML = `<p>Nothing here</p>`;
    expect((await handleExecuteAction({ action: "click", target: "el_add_to_cart", confidence: 1, reason: "" })).code).toBe("unknown_target");
  });
});

describe("controller proof: a stale round is followed by a fresh observation and a NEW target, never the same one", () => {
  it("prints ROUND 1 stale -> ROUND 2 new target executed", async () => {
    const proof: string[] = [];
    const bodies = ["A", "B"];
    let extracts = 0;
    let reasons = 0;
    const ports: AgentPorts = {
      ensureContentScript: async () => undefined,
      capture: async () => null,
      perceive: async () => null,
      visionInfo: async () => null,
      extract: async () => {
        const version = bodies[Math.min(extracts++, 1)];
        proof.push(`ROUND ${extracts}: observation rebuilt = YES (version ${version})`);
        return { ok: true, summary: { placeholders: [], types: {}, detections: [] }, firewall: { verdict: "allowed", body: JSON.stringify({ task: "t", page: { url: version === "A" ? "https://shop.example/results" : "https://shop.example/checkout", title: version, elements: [{ id: version === "A" ? "el_card_a" : "el_card_b", tag: "div", text: "Red shirt", role: "button" }], text: "" }, placeholders: [] }) as never, checks: [] }, visualPrivacy: null };
      },
      reason: async (body) => {
        const id = (JSON.parse(body).page.elements as Array<{ id: string }>)[0].id; // the model targets what the CURRENT observation lists
        reasons++;
        proof.push(`ROUND ${reasons}: reasoner target = ${id}`);
        return reasons < 3 ? { action: "click", target: id, confidence: 1, reason: "" } : { action: "done", confidence: 1, reason: "checkout" };
      },
      execute: async (action) => {
        const target = (action as { target?: string }).target;
        if (target === "el_card_a") {
          proof.push("ROUND 1: validator = STALE (el_card_a discarded)");
          return { ok: false, message: "Target element changed after it was observed", validation: "blocked", code: "unknown_target" } as ExecuteActionResult;
        }
        if (target === "el_card_b") {
          proof.push("ROUND 2: validator = PASS, executor = CALLED, click = SUCCESS (el_card_b)");
          return { ok: true, message: "Clicked el_card_b", validation: "pass", postAction: { effect: "url_changed", mutations: 1, urlChanged: true, titleChanged: true, controlsChanged: true, modalAppeared: false, modalClosed: false, waitedMs: 10 }, trace: { action: "click", target: "Buy now", resolution: "ps-id", match: "div el_card_b", validation: "PASS", execution: "PASS", postAction: "url_changed" } } as ExecuteActionResult;
        }
        return { ok: true, message: "done", validation: "pass" };
      },
      renderMask: async () => null,
      report: (e: AgentEvent) => { if (e.kind === "status" && /TASK RESULT/.test(e.text)) proof.push(e.text); },
      now: () => 0,
    };
    const outcome = await runAgent("Buy the red shirt", ports);
    console.log(proof.join("\n"));
    expect(proof.some((p) => p.startsWith("ROUND 1: validator = STALE"))).toBe(true);
    expect(proof.some((p) => p.startsWith("ROUND 2: validator = PASS"))).toBe(true);
    expect(proof.filter((p) => /reasoner target = el_card_a/.test(p))).toHaveLength(1); // the stale target is never re-sent
    expect(outcome.status).toBe("completed");
  });
});
