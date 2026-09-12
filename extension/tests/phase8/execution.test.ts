/**
 * Phase 8: the evidence-based execution pipeline through the live handlers:
 * click patterns, covered/disabled targets, verified typing, Enter, and
 * post-action page change detection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleExecuteAction, handleExtractPage } from "../../src/content/handlers";
import { snapshotPage, watchForChange } from "../../src/content/page-state";

const TASK = "Search for a black shirt and add the cheapest one to the cart";

function stubLayout(): void {
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON: () => ({}) });
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
}

beforeEach(() => {
  stubLayout();
  (document as unknown as { elementFromPoint?: unknown }).elementFromPoint = undefined;
});

async function run(action: Record<string, unknown>) {
  return handleExecuteAction({ confidence: 1, reason: "", ...action });
}

describe("A. basic click patterns", () => {
  it.each([
    ["normal button", `<button id="t">Add to cart</button>`, "el_t"],
    ["role=button div", `<div role="button" id="t">Add to cart</div>`, "el_t"],
    ["accessible-name icon button", `<button id="t" aria-label="Add to cart">🛒</button>`, "el_t"],
    ["input submit", `<form onsubmit="return false"><input id="t" type="submit" value="Add to cart"></form>`, "el_t"],
    ["link", `<a id="t" href="#cart">Add to cart</a>`, "el_t"],
  ])("%s is clicked exactly once through the validator", async (_name, html, id) => {
    document.body.innerHTML = html;
    await handleExtractPage(TASK);
    const target = document.getElementById("t") as HTMLElement;
    const clicks = vi.fn((e: Event) => e.preventDefault());
    target.addEventListener("click", clicks);
    const result = await run({ action: "click", target: id });
    expect(result.ok).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(result.trace).toMatchObject({ action: "click", target: "Add to cart", resolution: "ps-id", validation: "PASS", execution: "PASS" });
  });
});

describe("B. dynamic DOM", () => {
  it("clicks the re-rendered button, not the detached one", async () => {
    document.body.innerHTML = `<div id="root"><button>Add to cart</button></div>`;
    await handleExtractPage(TASK);
    const old = document.querySelector("button") as HTMLButtonElement;
    const oldClicks = vi.fn();
    old.addEventListener("click", oldClicks);
    document.getElementById("root")!.innerHTML = `<button>Add to cart</button>`;
    const fresh = document.querySelector("button") as HTMLButtonElement;
    const freshClicks = vi.fn();
    fresh.addEventListener("click", freshClicks);

    const result = await run({ action: "click", target: "el_add_to_cart" });
    expect(result.ok).toBe(true);
    expect(freshClicks).toHaveBeenCalledTimes(1);
    expect(oldClicks).not.toHaveBeenCalled();
    // The validator re-found it semantically and adopted the node; the executor's own re-resolution is then direct.
    expect(["semantic", "ps-id"]).toContain(result.trace?.resolution);
    expect(fresh.getAttribute("data-ps-id")).toBe("el_add_to_cart");
  });

  it("a target that became disabled is rejected, not clicked", async () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    await handleExtractPage(TASK);
    const button = document.querySelector("button") as HTMLButtonElement;
    button.disabled = true;
    const clicks = vi.fn();
    button.addEventListener("click", clicks);
    const result = await run({ action: "click", target: "el_add_to_cart" });
    expect(result.validation).toBe("blocked");
    expect(result.code).toBe("incompatible_target");
    expect(clicks).not.toHaveBeenCalled();
  });

  it("a target that disappeared is a stale target", async () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    await handleExtractPage(TASK);
    document.body.innerHTML = `<p>Gone</p>`;
    const result = await run({ action: "click", target: "el_add_to_cart" });
    expect(result.code).toBe("unknown_target");
  });

  it("a target covered by an overlay is not clicked through the overlay", async () => {
    document.body.innerHTML = `<button>Add to cart</button><div id="backdrop" role="dialog">Please sign in</div>`;
    await handleExtractPage(TASK);
    const backdrop = document.getElementById("backdrop") as HTMLElement;
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => backdrop;
    const clicks = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicks);
    const result = await run({ action: "click", target: "el_add_to_cart" });
    expect(result.validation).toBe("blocked");
    expect(result.code).toBe("target_occluded");
    expect(result.message).toMatch(/dialog is covering/);
    expect(clicks).not.toHaveBeenCalled();
  });
});

describe("C. duplicate targets", () => {
  it("the validated Buy button of Product B is the only one clicked", async () => {
    document.body.innerHTML = `
      <article><h3>Product A</h3><span>₹799</span><button>Buy</button></article>
      <article><h3>Product B</h3><span>₹699</span><button>Buy</button></article>`;
    const extracted = await handleExtractPage("Buy the cheapest product");
    expect(extracted.ok).toBe(true);
    const body = extracted.ok ? JSON.parse(extracted.firewall.body) : null;
    const buys = body.page.elements.filter((e: { text: string }) => e.text === "Buy");
    expect(buys.map((e: { context: string }) => e.context)).toEqual(["Product A | ₹799", "Product B | ₹699"]);
    const [a, b] = Array.from(document.querySelectorAll("button"));
    const clicksA = vi.fn();
    const clicksB = vi.fn();
    a.addEventListener("click", clicksA);
    b.addEventListener("click", clicksB);
    const result = await run({ action: "click", target: buys[1].id });
    expect(result.ok).toBe(true);
    expect(clicksB).toHaveBeenCalledTimes(1);
    expect(clicksA).not.toHaveBeenCalled();
  });
});

describe("D. typing and submission", () => {
  it("types into a search box, verifies the value, and reports that nothing was submitted", async () => {
    document.body.innerHTML = `<form onsubmit="return false"><input id="q" name="q" type="search" placeholder="Search"></form>`;
    await handleExtractPage("Search for black shirt");
    const result = await run({ action: "type", target: "el_q", value: "black shirt" });
    expect(result.ok).toBe(true);
    expect((document.getElementById("q") as HTMLInputElement).value).toBe("black shirt");
    expect(result.note).toMatch(/nothing submitted/);
    expect(result.postAction?.effect).toBe("no_change");
  });

  it("types into a textarea and a contenteditable box", async () => {
    document.body.innerHTML = `<textarea name="msg"></textarea><div contenteditable="true" aria-label="Editor"></div>`;
    await handleExtractPage("Write hello");
    expect((await run({ action: "type", target: "el_msg", value: "hello" })).ok).toBe(true);
    expect(document.querySelector("textarea")!.value).toBe("hello");
    const editor = await run({ action: "type", target: "el_editor", value: "hello" });
    expect(editor.ok).toBe(true);
    expect(document.querySelector("[contenteditable]")!.textContent).toBe("hello");
  });

  it("fails closed when the field does not accept the text (verification, not assumption)", async () => {
    document.body.innerHTML = `<input id="q" name="q" type="search">`;
    await handleExtractPage("Search for black shirt");
    const field = document.getElementById("q") as HTMLInputElement;
    Object.defineProperty(field, "value", { get: () => "", set: () => undefined, configurable: true }); // a field that swallows input
    const result = await run({ action: "type", target: "el_q", value: "black shirt" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("action_failed");
    expect(result.message).toMatch(/did not accept/);
  });

  it("press Enter submits the search form when the page does not handle the key itself", async () => {
    document.body.innerHTML = `<form id="f"><input id="q" name="q" type="search"></form>`;
    await handleExtractPage("Search for black shirt");
    const submitted = vi.fn((e: Event) => e.preventDefault());
    document.getElementById("f")!.addEventListener("submit", submitted);
    await run({ action: "type", target: "el_q", value: "black shirt" });
    const result = await run({ action: "press", target: "el_q", value: "Enter" });
    expect(result.ok).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("press Enter lets a page keydown handler take over and does not double-submit", async () => {
    document.body.innerHTML = `<form id="f"><input id="q" name="q" type="search"></form>`;
    await handleExtractPage("Search for black shirt");
    const submitted = vi.fn((e: Event) => e.preventDefault());
    document.getElementById("f")!.addEventListener("submit", submitted);
    const handled = vi.fn((e: KeyboardEvent) => { if (e.key === "Enter") e.preventDefault(); });
    document.getElementById("q")!.addEventListener("keydown", handled);
    const result = await run({ action: "press", target: "el_q", value: "Enter" });
    expect(result.ok).toBe(true);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("press only accepts Enter and only on a text field", async () => {
    document.body.innerHTML = `<input id="q" name="q" type="search"><button id="b">Go</button>`;
    await handleExtractPage("Search");
    expect((await run({ action: "press", target: "el_q", value: "Escape" })).code).toBe("invalid_value");
    expect((await run({ action: "press", target: "el_b", value: "Enter" })).code).toBe("incompatible_target");
  });

  it("never types into password, card or OTP fields, whatever the model says", async () => {
    document.body.innerHTML = `
      <input id="pass" name="password" type="password">
      <input id="card" name="cardnumber" autocomplete="cc-number" type="text">
      <input id="otp" name="otp" autocomplete="one-time-code" type="text">`;
    await handleExtractPage("Log in");
    for (const target of ["el_pass", "el_card", "el_otp"]) {
      const result = await run({ action: "type", target, value: "123456" });
      expect(result.validation).toBe("blocked");
    }
    expect(Array.from(document.querySelectorAll("input")).every((i) => i.value === "")).toBe(true);
  });
});

describe("page change detection", () => {
  it("reports dom_changed when content is rendered after the action", async () => {
    document.body.innerHTML = `<div id="results"></div>`;
    const before = snapshotPage();
    setTimeout(() => { document.getElementById("results")!.innerHTML = "<article>Result 1</article>"; }, 20);
    const effect = await watchForChange(before, { timeoutMs: 400, quietMs: 30 });
    expect(effect.effect).toBe("dom_changed");
    expect(effect.mutations).toBeGreaterThan(0);
  });

  it("reports no_change within the bound when nothing happens", async () => {
    document.body.innerHTML = `<p>static</p>`;
    const effect = await watchForChange(snapshotPage(), { timeoutMs: 120 });
    expect(effect.effect).toBe("no_change");
    expect(effect.waitedMs).toBeLessThan(1000);
  });

  it("reports url_changed on a same-document navigation", async () => {
    document.body.innerHTML = `<p>page</p>`;
    const before = snapshotPage();
    setTimeout(() => history.pushState({}, "", "/search?q=black+shirt"), 20);
    const effect = await watchForChange(before, { timeoutMs: 400 });
    expect(effect.effect).toBe("url_changed");
  });

  it("notices a dialog appearing", async () => {
    document.body.innerHTML = `<p>page</p>`;
    const before = snapshotPage();
    setTimeout(() => { document.body.insertAdjacentHTML("beforeend", `<div role="dialog">Choose a size</div>`); }, 20);
    const effect = await watchForChange(before, { timeoutMs: 400, quietMs: 30 });
    expect(effect.modalAppeared).toBe(true);
  });
});

describe("bounded repeated cart adds (local, site-agnostic)", () => {
  const history = (n: number) => Array.from({ length: n }, () => ({ action: "click" as const, target: "el_x", value: null, effect: "dom_changed" as const, label: "Add to cart" }));

  it("allows the listing button and the dialog button, refuses a third add-to-cart click", async () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    await handleExtractPage("Add a black shirt to the cart");
    expect((await handleExecuteAction({ action: "click", target: "el_add_to_cart", confidence: 1, reason: "" }, history(1))).ok).toBe(true);
    const third = await handleExecuteAction({ action: "click", target: "el_add_to_cart", confidence: 1, reason: "" }, history(2));
    expect(third.validation).toBe("blocked");
    expect(third.code).toBe("repeated_action");
  });

  it("does not bound tasks that ask for several items", async () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    await handleExtractPage("Add 3 black shirts to the cart");
    expect((await handleExecuteAction({ action: "click", target: "el_add_to_cart", confidence: 1, reason: "" }, history(2))).ok).toBe(true);
  });

  it("does not affect ordinary controls", async () => {
    document.body.innerHTML = `<button>Next page</button>`;
    await handleExtractPage("Find the cheapest shirt");
    expect((await handleExecuteAction({ action: "click", target: "el_next_page", confidence: 1, reason: "" }, history(5))).ok).toBe(true);
  });
});

describe("effects of synchronous handlers are observed", () => {
  it("a click whose handler mutates the DOM synchronously is dom_changed, not no_change", async () => {
    document.body.innerHTML = `<button id="view">View</button><section id="detail" hidden><button>Add to cart</button></section>`;
    await handleExtractPage("open the item");
    document.getElementById("view")!.addEventListener("click", () => { document.getElementById("detail")!.hidden = false; document.getElementById("detail")!.insertAdjacentHTML("beforeend", "<p>Opened</p>"); });
    const result = await run({ action: "click", target: "el_view" });
    expect(result.postAction?.effect).toBe("dom_changed");
  });

  it("typing into a field whose input handler updates the page synchronously is dom_changed", async () => {
    document.body.innerHTML = `<input id="qty" name="quantity" type="number" value="1"><span id="shown">1</span>`;
    await handleExtractPage("set quantity");
    document.getElementById("qty")!.addEventListener("input", (e) => { document.getElementById("shown")!.textContent = (e.target as HTMLInputElement).value; });
    const result = await run({ action: "type", target: "el_qty", value: "500" });
    expect(result.ok).toBe(true);
    expect(result.postAction?.effect).toBe("dom_changed");
    expect(document.getElementById("shown")!.textContent).toBe("500");
  });
});
