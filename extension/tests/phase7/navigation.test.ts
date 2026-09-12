/**
 * Phase 7: task-authorised navigation and the off-page round.
 */

import { describe, expect, it } from "vitest";
import { runAgent, type AgentEvent, type AgentPorts } from "../../src/agent/controller";
import { executeOffPage, isOffPageUrl, observeOffPage, OFF_PAGE_TEXT } from "../../src/agent/offpage";
import { navigationBlockReason, siteLabel } from "../../src/content/navigation";
import type { ExecuteActionResult } from "../../src/shared/messages";

describe("siteLabel", () => {
  it.each([
    ["www.amazon.in", "amazon"],
    ["www.amazon.co.uk", "amazon"],
    ["amazon.com", "amazon"],
    ["en.wikipedia.org", "wikipedia"],
    ["localhost:8080", "localhost"],
    ["keep.google.com", "google"],
    ["shop.example.co.in", "example"],
  ])("%s -> %s", (host, label) => {
    expect(siteLabel(host)).toBe(label);
  });
});

describe("navigationBlockReason", () => {
  it("allows a site the task names, in any wording", () => {
    expect(navigationBlockReason("https://www.amazon.in/", "on amazon ,add PS-5 to cart", "chrome://newtab/")).toBeNull();
    expect(navigationBlockReason("https://www.amazon.in/s?k=ps5", "Go to Amazon and add a PS5 to the cart", "about:blank")).toBeNull();
    expect(navigationBlockReason("http://localhost:8080/shop.html", "Open localhost:8080/shop.html and search", "about:blank")).toBeNull();
  });

  it("allows staying on the site that is already open", () => {
    expect(navigationBlockReason("https://www.amazon.in/s?k=black+shirt", "add the cheapest black shirt to the cart", "https://www.amazon.in/")).toBeNull();
  });

  it("blocks a site the task does not name", () => {
    expect(navigationBlockReason("https://www.flipkart.com/", "on amazon, add PS-5 to cart", "chrome://newtab/")).toMatch(/does not name this website/);
    expect(navigationBlockReason("https://evil.example/", "add the cheapest black shirt to the cart", "https://www.amazon.in/")).toMatch(/does not name/);
    expect(navigationBlockReason("javascript:alert(1)", "on amazon", "about:blank")).toMatch(/only http and https|not valid/);
  });

  it("does not match a label inside another word", () => {
    expect(navigationBlockReason("https://amazon.in/", "find the cheapest tamazonite ring", "about:blank")).toMatch(/does not name/);
  });
});

describe("off-page round", () => {
  it("isOffPageUrl recognises browser pages", () => {
    for (const u of ["chrome://newtab/", "chrome://new-tab-page/", "about:blank", "", undefined, "edge://settings"]) expect(isOffPageUrl(u)).toBe(true);
    for (const u of ["https://www.amazon.in/", "http://localhost:8080/shop.html"]) expect(isOffPageUrl(u)).toBe(false);
  });

  it("observeOffPage yields a sanitized, firewall-approved body that says nothing is open", () => {
    const observed = observeOffPage("on amazon, add PS-5 to cart for demo@example.com", "chrome://newtab/", []);
    expect(observed.ok).toBe(true);
    if (!observed.ok || observed.firewall.verdict !== "allowed") throw new Error("expected an allowed body");
    const body = JSON.parse(observed.firewall.body) as { task: string; page: { text: string; elements: unknown[] } };
    expect(body.page.text).toBe(OFF_PAGE_TEXT);
    expect(body.page.elements).toEqual([]);
    expect(body.task).toContain("[EMAIL_1]");
    expect(observed.firewall.body).not.toContain("demo@example.com");
  });

  it("observeOffPage adds the browser language line when a locale is given, and nothing else about the user", () => {
    const observed = observeOffPage("on amazon, add PS-5 to cart", "chrome://newtab/", [], "en-IN");
    if (!observed.ok || observed.firewall.verdict !== "allowed") throw new Error("expected an allowed body");
    const body = JSON.parse(observed.firewall.body) as { page: { text: string } };
    expect(body.page.text.endsWith("Browser language: en-IN")).toBe(true);
    expect(body.page.text.startsWith(OFF_PAGE_TEXT)).toBe(true);
  });

  it("executeOffPage approves an authorised navigate, refuses others, and accepts done", () => {
    const task = "on amazon, add PS-5 to cart";
    const ok = executeOffPage({ action: "navigate", value: "https://www.amazon.in/", confidence: 1, reason: "" }, task, "chrome://newtab/");
    expect(ok.ok).toBe(true);
    expect(ok.navigateTo).toBe("https://www.amazon.in/");
    const other = executeOffPage({ action: "navigate", value: "https://www.flipkart.com/", confidence: 1, reason: "" }, task, "chrome://newtab/");
    expect(other.code).toBe("navigation_not_authorised");
    const click = executeOffPage({ action: "click", target: "el_x", confidence: 1, reason: "" }, task, "chrome://newtab/");
    expect(click.validation).toBe("blocked");
    expect(executeOffPage({ action: "done", confidence: 1, reason: "no site named" }, task, "chrome://newtab/").ok).toBe(true);
  });

  it("controller: from a new tab, navigates first, then continues on the page", async () => {
    const events: AgentEvent[] = [];
    const calls: string[] = [];
    let url = "chrome://newtab/";
    const actions: unknown[] = [
      { action: "navigate", value: "https://www.amazon.in/", confidence: 1, reason: "open amazon", final: false },
      { action: "done", confidence: 1, reason: "on amazon now", final: true },
    ];
    let n = 0;
    let clock = 0;
    const ports: AgentPorts = {
      ensureContentScript: async () => void calls.push("ensure"),
      capture: async () => (calls.push("capture"), null),
      perceive: async () => null,
      visionInfo: async () => null,
      extract: async () => {
        calls.push("extract");
        const observed = observeOffPage("on amazon, add PS-5 to cart", "https://www.amazon.in/", []);
        return observed;
      },
      reason: async () => actions[n++],
      execute: async () => (calls.push("execute"), { ok: true, message: "Task reported as done", validation: "pass" } as ExecuteActionResult),
      renderMask: async () => null,
      pageUrl: async () => url,
      observeOffPage: async (t, h) => (calls.push("observeOffPage"), observeOffPage(t, url, h)),
      executeOffPage: async (a) => (calls.push("executeOffPage"), executeOffPage(a, "on amazon, add PS-5 to cart", url)),
      navigate: async (u) => {
        calls.push(`navigate:${u}`);
        url = u;
      },
      settle: async () => undefined,
      report: (e) => void events.push(e),
      now: () => (clock += 1),
    };
    const outcome = await runAgent("on amazon, add PS-5 to cart", ports);
    expect(["completed", "unverified"]).toContain(outcome.status);
    expect(outcome.steps).toBe(2);
    // After the navigation the reasoner claims done on a cart task with nothing added; the claim is rejected
    // locally once (a DOM-only re-observation, no capture) and the run ends unverified rather than complete.
    expect(calls.slice(0, 8)).toEqual(["ensure", "observeOffPage", "executeOffPage", "navigate:https://www.amazon.in/", "ensure", "capture", "extract", "execute"]);
    expect(calls.slice(8).every((c) => c === "extract" || c === "execute")).toBe(true); // recovery rounds are DOM-only re-observations
    expect(outcome.status).toBe("unverified");
    const vision = events.filter((e) => e.kind === "stage" && e.stage === "vision").map((e) => (e.kind === "stage" ? e.state : ""));
    expect(vision[0]).toBe("skipped"); // nothing to capture on a new tab
  });
});
