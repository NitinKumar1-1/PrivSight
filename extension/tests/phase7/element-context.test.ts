/**
 * Phase 7: generic controls get a local, redacted context so identical
 * buttons can be told apart by the reasoner.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { elementContext } from "../../src/content/element-context";
import { findInteractiveElements, MAX_INTERACTIVE_ELEMENTS, prioritizeViewport } from "../../src/content/element-ids";
import { prepareRequest } from "../../src/content/perception";
import { verifySerializedPayload } from "../../src/privacy/leakage";

// Whitespace between the card's children mirrors the line breaks a browser's innerText puts between blocks.
const LISTING = `
  <div class="card"><h2>J.VER Men's Dress Shirt Long Sleeve</h2> <span>INR 1,813.36</span> <button id="a-autoid-1-announce">Add to cart</button></div>
  <div class="card"><h2>Gildan Men's Crew T-Shirts Multipack</h2> <span>₹952.99</span> <button id="a-autoid-2-announce">Add to cart</button></div>
  <div class="card"><a href="/p/3">EKLENTSON Men's Short Sleeve Cotton Tee</a> <span>Rs 1,240</span> <button id="a-autoid-3-announce">Add to cart</button></div>
  <nav><a href="/">Home</a><button id="menu">Menu</button></nav>
  <div class="card"><h3>Contact demo@example.com</h3><button id="a-autoid-4-announce">Add to cart</button></div>
`;

beforeEach(() => {
  document.body.innerHTML = LISTING;
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
});

describe("elementContext", () => {
  it("names the card's heading and first price for a generic button", () => {
    const b1 = document.getElementById("a-autoid-1-announce") as HTMLElement;
    expect(elementContext(b1, "Add to cart")).toBe("J.VER Men's Dress Shirt Long Sleeve | INR 1,813.36");
    const b2 = document.getElementById("a-autoid-2-announce") as HTMLElement;
    expect(elementContext(b2, "Add to cart")).toBe("Gildan Men's Crew T-Shirts Multipack | ₹952.99");
  });

  it("falls back to a descriptive link when the card has no heading", () => {
    const b3 = document.getElementById("a-autoid-3-announce") as HTMLElement;
    expect(elementContext(b3, "Add to cart")).toBe("EKLENTSON Men's Short Sleeve Cotton Tee | Rs 1,240");
  });

  it("does not read a number after a word ending in 'rs' as a price", () => {
    document.body.innerHTML = `<div><h2>Welcome to Wikipedia</h2><p>7,238,551 articles by registered users7,238,551</p><button id="x">Got it</button></div>`;
    const x = document.getElementById("x") as HTMLElement;
    expect(elementContext(x, "Got it")).toBe("Welcome to Wikipedia");
  });

  it("gives no context to distinctive labels or to controls with no card around them", () => {
    const menu = document.getElementById("menu") as HTMLElement;
    expect(elementContext(menu, "Menu")).toBe("");
    const b1 = document.getElementById("a-autoid-1-announce") as HTMLElement;
    expect(elementContext(b1, "A label that is long enough to be distinctive on its own")).toBe("");
  });
});

describe("context on the wire", () => {
  it("is attached to generic controls, redacted, and accepted by the verifier", () => {
    const prepared = prepareRequest("add the cheapest to the cart", null, []);
    expect(prepared.firewall.verdict).toBe("allowed");
    if (prepared.firewall.verdict !== "allowed") return;
    const body = JSON.parse(prepared.firewall.body) as { page: { elements: Array<{ id: string; text: string; context?: string }> } };
    const byId = Object.fromEntries(body.page.elements.map((e) => [e.id, e]));
    expect(byId.el_a_autoid_1_announce.context).toBe("J.VER Men's Dress Shirt Long Sleeve | INR 1,813.36");
    expect(byId.el_a_autoid_4_announce.context).toContain("[EMAIL_1]");
    expect(byId.el_a_autoid_4_announce.context).not.toContain("demo@example.com");
    expect(byId.el_home.context).toBeUndefined();
    expect(byId.el_menu.context).toBeUndefined(); // unique label: no context even though a card-like ancestor exists
    expect(prepared.firewall.body).not.toContain("demo@example.com");
  });

  it("is not attached on pages where every label is unique (ShirtStore-style), so the wire shape is unchanged", () => {
    document.body.innerHTML = `<div class="product"><h2>Black Shirt A</h2><p>Price: ₹799</p><button id="buy_a">Buy Now A</button></div><div class="product"><h2>Black Shirt B</h2><p>Price: ₹899</p><button id="buy_b">Buy Now B</button></div>`;
    const prepared = prepareRequest("buy the cheapest", null, []);
    if (prepared.firewall.verdict !== "allowed") throw new Error("blocked");
    const body = JSON.parse(prepared.firewall.body) as { page: { elements: Array<Record<string, unknown>> } };
    for (const el of body.page.elements) expect(el).not.toHaveProperty("context");
  });

  it("the verifier rejects a non-string or oversized context", () => {
    const base = { task: "t", page: { url: "u", title: "t", elements: [{ id: "el_x", tag: "button", text: "Add", role: "button", context: 5 }], text: "" }, placeholders: [] };
    expect(verifySerializedPayload(JSON.stringify(base), []).safe).toBe(false);
    base.page.elements[0].context = "x".repeat(161) as unknown as number;
    expect(verifySerializedPayload(JSON.stringify(base), []).safe).toBe(false);
  });
});

describe("element cap prefers controls over links when over the cap", () => {
  it("in-viewport first, then buttons and fields, then links", () => {
    document.body.innerHTML = "";
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const top = Number((this as HTMLElement).dataset.top ?? "0");
      return { width: 100, height: 20, top, left: 0, right: 100, bottom: top + 20, x: 0, y: top, toJSON: () => ({}) };
    };
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    const parts: string[] = [];
    for (let i = 0; i < 300; i++) parts.push(i % 3 === 0 ? `<a href="#" data-top="5000">L${i}</a>` : `<button data-top="${i < 6 ? 10 : 5000}">B${i}</button>`);
    document.body.innerHTML = parts.join("");
    const found = findInteractiveElements(document, 100);
    expect(found).toHaveLength(100);
    expect(found.slice(0, 4).map((e) => e.textContent)).toEqual(["B1", "B2", "B4", "B5"]); // in viewport
    expect(found.slice(4).every((e) => e.tagName === "BUTTON")).toBe(true); // controls fill before any off-screen link
    expect(MAX_INTERACTIVE_ELEMENTS).toBe(220);
    expect(prioritizeViewport(found.slice(0, 5), 10)).toHaveLength(5);
  });
});
