/**
 * Phase 9 (hardening): state-verified cart adds, occlusion detection with
 * hit-testing, and standard <select> support, all through the live handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleExecuteAction, handleExtractPage } from "../../src/content/handlers";
import { clickabilityProblem } from "../../src/content/executor";
import { cartEvidenceBetween, cartSnapshot } from "../../src/content/page-state";
import type { ActionRecord } from "../../src/shared/contract";

function stubLayout(): void {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    if (el.dataset?.box) {
      const [x, y, w, h] = el.dataset.box.split(",").map(Number);
      return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}) };
    }
    return { width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON: () => ({}) };
  };
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
}

/** Hit-testing stand-in: returns `top` for every point, or per-point answers. */
function hitTest(answer: Element | null | ((x: number, y: number) => Element | null)): void {
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = typeof answer === "function" ? answer : () => answer;
}

beforeEach(() => {
  stubLayout();
  (document as unknown as { elementFromPoint?: unknown }).elementFromPoint = undefined;
});

const run = (action: Record<string, unknown>, history: ActionRecord[] = []) => handleExecuteAction({ confidence: 1, reason: "", ...action }, history);
const cartRecord = (over: Partial<ActionRecord> = {}): ActionRecord => ({ action: "click", target: "el_add_to_cart", value: null, effect: "dom_changed", label: "Add to cart", ...over });

describe("P2. cart adds are state-verified", () => {
  it("successful add: the executor measures the cart count going up and reports it", async () => {
    document.body.innerHTML = `<a href="#cart" id="cart">Cart (0)</a><button id="atc">Add to cart</button>`;
    await handleExtractPage("Add the shirt to the cart");
    document.getElementById("atc")!.addEventListener("click", () => { document.getElementById("cart")!.textContent = "Cart (1)"; });
    const result = await run({ action: "click", target: "el_atc" });
    expect(result.ok).toBe(true);
    expect(result.cartEvidence).toMatchObject({ countBefore: 0, countAfter: 1, added: true });
    expect(result.note).toMatch(/item is in the cart: cart count 0 -> 1/);
  });

  it("confirmation dialog: an added-to-cart confirmation appearing is evidence; a variant dialog is reported as a new state", async () => {
    document.body.innerHTML = `<button id="atc">Add to cart</button><div id="toast"></div>`;
    await handleExtractPage("Add the shirt to the cart");
    document.getElementById("atc")!.addEventListener("click", () => { document.getElementById("toast")!.textContent = "Added to cart"; });
    const confirmed = await run({ action: "click", target: "el_atc" });
    expect(confirmed.cartEvidence).toMatchObject({ confirmationAppeared: true, added: true });

    document.body.innerHTML = `<button id="atc2">Add to cart</button><div id="host"></div>`;
    await handleExtractPage("Add the shirt to the cart");
    document.getElementById("atc2")!.addEventListener("click", () => { document.getElementById("host")!.innerHTML = `<div role="dialog">Choose a size <button>Add to cart</button></div>`; });
    const dialog = await run({ action: "click", target: "el_atc2" });
    expect(dialog.cartEvidence).toMatchObject({ dialogAppeared: true, added: false });
    expect(dialog.note).toMatch(/dialog opened/);
    expect(dialog.postAction?.modalAppeared).toBe(true);
  });

  it("repeated add prevention: once the cart showed the item went in, the same control is refused", async () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    await handleExtractPage("Add the shirt to the cart");
    const again = await run({ action: "click", target: "el_add_to_cart" }, [cartRecord({ cartAdded: true })]);
    expect(again.validation).toBe("blocked");
    expect(again.code).toBe("repeated_action");
    expect(again.message).toMatch(/already shows this item was added/);
  });

  it("duplicate product: a second product's add-to-cart is refused after a verified add unless the task asks for several", async () => {
    document.body.innerHTML = `<article><h3>Shirt B</h3><span>₹699</span><button>Add to cart</button></article>`;
    await handleExtractPage("Add the cheapest shirt to the cart");
    const other = await run({ action: "click", target: "el_add_to_cart" }, [cartRecord({ cartAdded: true, context: "Shirt A | ₹799" })]);
    expect(other.code).toBe("repeated_action");
    await handleExtractPage("Add 2 shirts to the cart");
    const allowed = await run({ action: "click", target: "el_add_to_cart" }, [cartRecord({ cartAdded: true, context: "Shirt A | ₹799" })]);
    expect(allowed.ok).toBe(true);
  });

  it("stale product: an add-to-cart whose node now reads differently is a stale target, not clicked", async () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    await handleExtractPage("Add the shirt to the cart");
    document.querySelector("button")!.textContent = "Go to cart";
    const result = await run({ action: "click", target: "el_add_to_cart" });
    expect(result.code).toBe("unknown_target");
  });

  it("the bounded count stays as a backstop when the page exposes no cart signal at all", async () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    await handleExtractPage("Add the shirt to the cart");
    expect((await run({ action: "click", target: "el_add_to_cart" }, [cartRecord()])).ok).toBe(true);
    expect((await run({ action: "click", target: "el_add_to_cart" }, [cartRecord(), cartRecord()])).code).toBe("repeated_action");
  });

  it("cart snapshots carry numbers and booleans only", () => {
    document.body.innerHTML = `<a href="#">3 items in basket</a><p>Added to basket</p>`;
    const snap = cartSnapshot();
    expect(snap).toEqual({ count: 3, goToCart: false, confirmation: true, dialogs: 0 });
    expect(cartEvidenceBetween({ count: 2, goToCart: false, confirmation: false, dialogs: 0 }, snap)).toMatchObject({ added: true, countBefore: 2, countAfter: 3 });
  });
});

describe("P3. occluded targets fail closed", () => {
  it("overlay: a dialog intercepting the centre point is reported as TARGET_OCCLUDED with the interceptor described", async () => {
    document.body.innerHTML = `<button id="t">Add to cart</button><div id="modal" role="dialog">Sign in</div>`;
    await handleExtractPage("Add the shirt to the cart");
    hitTest(document.getElementById("modal"));
    const clicks = vi.fn();
    document.getElementById("t")!.addEventListener("click", clicks);
    const result = await run({ action: "click", target: "el_t" });
    expect(result).toMatchObject({ validation: "blocked", code: "target_occluded" });
    expect(result.message).toMatch(/dialog is covering/);
    expect(clicks).not.toHaveBeenCalled();
  });

  it("transparent intercepting element: an invisible full-page layer still blocks the click", async () => {
    document.body.innerHTML = `<button id="t">Add to cart</button><div id="shield" data-box="0,0,1200,800" style="position:fixed;opacity:0;background:transparent"></div>`;
    await handleExtractPage("Add the shirt to the cart");
    hitTest(document.getElementById("shield"));
    const result = await run({ action: "click", target: "el_t" });
    expect(result.code).toBe("target_occluded");
    expect(result.message).toMatch(/overlay \(transparent\)|transparent element/);
  });

  it("partial cover: most interior points intercepted is occluded; a sliver is not", async () => {
    document.body.innerHTML = `<button id="t">Add to cart</button><div id="banner">Cookie banner</div>`;
    const t = document.getElementById("t")!;
    const banner = document.getElementById("banner")!;
    hitTest((x, y) => (y >= 15 ? banner : t)); // centre and the lower points are under the banner
    expect(clickabilityProblem(t)).toMatchObject({ code: "target_occluded" });
    hitTest((x, y) => (y >= 28 ? banner : t)); // only the bottom edge
    expect(clickabilityProblem(t)).toBeNull();
  });

  it("pointer-events:none on the target itself is occlusion", () => {
    document.body.innerHTML = `<button id="t" style="pointer-events:none">Add to cart</button>`;
    const t = document.getElementById("t")!;
    hitTest(t);
    expect(clickabilityProblem(t)).toMatchObject({ code: "target_occluded", reason: /pointer events/ });
  });

  it("disabled and hidden targets are not clickable (distinct from occluded)", () => {
    document.body.innerHTML = `<button id="d" disabled>Add</button><button id="h" style="display:none">Add</button>`;
    expect(clickabilityProblem(document.getElementById("d")!)).toMatchObject({ code: "target_not_clickable", reason: /disabled/ });
    expect(clickabilityProblem(document.getElementById("h")!)).toMatchObject({ code: "target_not_clickable", reason: /hidden/ });
  });

  it("hits on the target itself, a descendant, or a wrapping ancestor are fine", () => {
    document.body.innerHTML = `<span id="wrap"><button id="t"><span id="inner">Add</span></button></span>`;
    const t = document.getElementById("t")!;
    for (const id of ["t", "inner", "wrap"]) {
      hitTest(document.getElementById(id));
      expect(clickabilityProblem(t)).toBeNull();
    }
  });

  it("a covered text field cannot be typed into either", async () => {
    document.body.innerHTML = `<input id="q" name="q" type="search"><div id="modal" role="dialog">Sign in</div>`;
    await handleExtractPage("Search for black shirt");
    hitTest(document.getElementById("modal"));
    const result = await run({ action: "type", target: "el_q", value: "black shirt" });
    expect(result.code).toBe("target_occluded");
    expect((document.getElementById("q") as HTMLInputElement).value).toBe("");
  });
});

describe("P5. standard <select> is supported generically; custom dropdowns stay fail-closed", () => {
  it("the observation lists a select with its enabled options and its current value as text", async () => {
    document.body.innerHTML = `<select name="size"><option value="">Choose</option><option value="s">Small</option><option value="m" disabled>Medium (sold out)</option><option value="l">Large</option></select>`;
    const extracted = await handleExtractPage("Pick a size");
    const body = extracted.ok ? JSON.parse(extracted.firewall.body) : null;
    const select = body.page.elements.find((e: { tag: string }) => e.tag === "select");
    expect(select).toMatchObject({ id: "el_size", role: "combobox", text: "Choose", options: ["Choose", "Small", "Large"] });
  });

  it("selects an existing option by label or value, dispatches input/change, and verifies the selection", async () => {
    document.body.innerHTML = `<select name="size"><option value="">Choose</option><option value="s">Small</option><option value="l">Large</option></select>`;
    await handleExtractPage("Pick size Large");
    const select = document.querySelector("select") as HTMLSelectElement;
    const events: string[] = [];
    select.addEventListener("input", () => events.push("input"));
    select.addEventListener("change", () => events.push("change"));
    const result = await run({ action: "select", target: "el_size", value: "Large" });
    expect(result.ok).toBe(true);
    expect(select.value).toBe("l");
    expect(events).toEqual(["input", "change"]);
    expect(result.note).toMatch(/verified/);
    expect((await run({ action: "select", target: "el_size", value: "s" })).ok).toBe(true);
    expect(select.value).toBe("s");
  });

  it("rejects a value that is not an enabled option, a multi-select, and a div-based dropdown", async () => {
    document.body.innerHTML = `
      <select name="size"><option value="s">Small</option><option value="m" disabled>Medium</option></select>
      <select name="colors" multiple><option value="r">Red</option></select>
      <div role="listbox" id="custom"><div role="option">Small</div></div>`;
    await handleExtractPage("Pick a size");
    expect((await run({ action: "select", target: "el_size", value: "XL" })).code).toBe("invalid_value");
    expect((await run({ action: "select", target: "el_size", value: "Medium" })).code).toBe("invalid_value");
    expect((await run({ action: "select", target: "el_colors", value: "Red" })).code).toBe("incompatible_target");
    const custom = await run({ action: "select", target: "el_custom", value: "Small" });
    expect(custom.validation).toBe("blocked");
    expect(["incompatible_target", "unknown_target"]).toContain(custom.code);
  });

  it("a select that ignores the assignment is a failure, not a success", async () => {
    document.body.innerHTML = `<select name="size"><option value="s">Small</option><option value="l">Large</option></select>`;
    await handleExtractPage("Pick a size");
    const select = document.querySelector("select") as HTMLSelectElement;
    Object.defineProperty(select, "value", { get: () => "s", set: () => undefined, configurable: true });
    const result = await run({ action: "select", target: "el_size", value: "Large" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("action_failed");
  });
});

describe("P2. cart signals that arrive late are still caught (bounded polling)", () => {
  it("a cart count that updates after the DOM has gone quiet is detected within the wait window", async () => {
    document.body.innerHTML = `<a href="#cart" id="cart">0 items in cart</a><button id="atc">Add to cart</button>`;
    await handleExtractPage("Add the shirt to the cart");
    document.getElementById("atc")!.addEventListener("click", () => {
      setTimeout(() => { document.getElementById("cart")!.textContent = "1 item in cart"; }, 400); // async add, later than the DOM watch
    });
    const result = await run({ action: "click", target: "el_atc" });
    expect(result.cartEvidence).toMatchObject({ countBefore: 0, countAfter: 1, added: true });
  });
});

describe("P3b. keys are never pressed into a field under a dialog or one that cannot take focus", () => {
  it("press Enter is refused as occluded when a dialog covers the field", async () => {
    document.body.innerHTML = `<form id="f"><input id="q" name="q" type="search"></form><div id="modal" role="dialog">Log in</div>`;
    await handleExtractPage("Search for headphones");
    hitTest(document.getElementById("modal"));
    const submitted = vi.fn((e: Event) => e.preventDefault());
    document.getElementById("f")!.addEventListener("submit", submitted);
    const result = await run({ action: "press", target: "el_q", value: "Enter" });
    expect(result).toMatchObject({ validation: "blocked", code: "target_occluded" });
    expect(submitted).not.toHaveBeenCalled();
  });

  it("press Enter and typing are refused when focus cannot be placed in the field (a focus-trapping dialog)", async () => {
    document.body.innerHTML = `<input id="q" name="q" type="search"><div role="dialog"><input id="trap" name="loginId"></div>`;
    await handleExtractPage("Search for headphones");
    const q = document.getElementById("q") as HTMLInputElement;
    const trap = document.getElementById("trap") as HTMLInputElement;
    q.focus = () => trap.focus(); // the page pulls focus back into its dialog
    const pressed = await run({ action: "press", target: "el_q", value: "Enter" });
    expect(pressed).toMatchObject({ validation: "blocked", code: "target_occluded" });
    expect(pressed.message).toMatch(/cannot take focus/);
    const typed = await run({ action: "type", target: "el_q", value: "headphones" });
    expect(typed.code).toBe("target_occluded");
    expect(q.value).toBe("");
    expect(trap.value).toBe("");
  });
});
