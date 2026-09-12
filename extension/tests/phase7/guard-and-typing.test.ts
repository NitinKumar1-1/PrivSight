/**
 * Phase 7: the live content-script pipeline enforces the consequential
 * guard and the typing rules against a real DOM, task by task.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleExecuteAction, handleExtractPage } from "../../src/content/handlers";

const SHOP = `
  <form id="search-form">
    <input id="q" name="q" type="search" placeholder="Search products">
    <button id="go" type="submit">Go</button>
  </form>
  <button id="add-to-cart">Add to Cart</button>
  <button id="buy-now">Buy Now</button>
  <button id="checkout">Proceed to checkout</button>
  <form id="login">
    <input id="user" name="username" type="text">
    <input id="pass" name="password" type="password">
    <button id="next-btn" type="submit">Continue</button>
  </form>
  <input id="card" name="cardnumber" autocomplete="cc-number" type="text" value="4111 1111 1111 1111">
`;

beforeEach(() => {
  document.body.innerHTML = SHOP;
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.scrollIntoView = vi.fn();
});

const CART_TASK = "Search for a black shirt, add the cheapest one to the cart. Do not purchase anything. Do not proceed to checkout.";

describe("consequential guard through the live validator", () => {
  it("cart task: Add to Cart and the search Go button pass; Buy Now and checkout are blocked", async () => {
    await handleExtractPage(CART_TASK);
    expect((await handleExecuteAction({ action: "click", target: "el_add_to_cart", confidence: 1, reason: "" })).ok).toBe(true);
    expect((await handleExecuteAction({ action: "click", target: "el_go", confidence: 1, reason: "" })).ok).toBe(true);
    const buy = await handleExecuteAction({ action: "click", target: "el_buy_now", confidence: 1, reason: "" });
    expect(buy.validation).toBe("blocked");
    expect(buy.code).toBe("consequential_action");
    expect(buy.message).toMatch(/purchase/);
    const checkout = await handleExecuteAction({ action: "click", target: "el_checkout", confidence: 1, reason: "" });
    expect(checkout.code).toBe("consequential_action");
  });

  it("a search form's submit button whose id says 'submit' is an ordinary control; an id saying 'buy-now' is not", async () => {
    document.body.innerHTML += `<form><input id="s" type="search"><input id="nav-search-submit-button" type="submit" value="Go"></form><button id="buy-now-button" aria-label="">🛒</button>`;
    await handleExtractPage(CART_TASK);
    expect((await handleExecuteAction({ action: "click", target: "el_nav_search_submit_button", confidence: 1, reason: "" })).ok).toBe(true);
    expect((await handleExecuteAction({ action: "click", target: "el_buy_now_button", confidence: 1, reason: "" })).code).toBe("consequential_action");
  });

  it("a submit button on a form with a password field is blocked unless the task asks to sign in", async () => {
    await handleExtractPage(CART_TASK);
    const login = await handleExecuteAction({ action: "click", target: "el_next_btn", confidence: 1, reason: "" });
    expect(login.code).toBe("consequential_action");
    expect(login.message).toMatch(/sensitive fields/);
    await handleExtractPage("Sign in to my account");
    expect((await handleExecuteAction({ action: "click", target: "el_next_btn", confidence: 1, reason: "" })).ok).toBe(true);
  });

  it("buy task: Buy Now is allowed because the user asked for it", async () => {
    await handleExtractPage("Find the cheapest black shirt and buy it");
    expect((await handleExecuteAction({ action: "click", target: "el_buy_now", confidence: 1, reason: "" })).ok).toBe(true);
  });
});

describe("typing through the live validator and executor", () => {
  it("types plain text into the search box and fires input/change", async () => {
    await handleExtractPage(CART_TASK);
    const q = document.getElementById("q") as HTMLInputElement;
    const events: string[] = [];
    q.addEventListener("input", () => events.push("input"));
    q.addEventListener("change", () => events.push("change"));
    const result = await handleExecuteAction({ action: "type", target: "el_q", value: "black shirt", confidence: 0.9, reason: "" });
    expect(result.ok).toBe(true);
    expect(q.value).toBe("black shirt");
    expect(events).toEqual(["input", "change"]);
  });

  it("never types into sensitive fields: placeholder into the card field and anything into the password field are blocked", async () => {
    await handleExtractPage(CART_TASK);
    const card = await handleExecuteAction({ action: "type", target: "el_card", value: "[CARD_1]", confidence: 1, reason: "" });
    expect(card.validation).toBe("blocked");
    expect(card.code).toBe("unsupported_by_executor");
    expect((document.getElementById("card") as HTMLInputElement).value).toBe("4111 1111 1111 1111");
    const raw = await handleExecuteAction({ action: "type", target: "el_pass", value: "hunter2", confidence: 1, reason: "" });
    expect(raw.validation).toBe("blocked");
    expect(raw.code).toBe("sensitive_policy");
    expect((document.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("navigate is approved, not performed, when the task names the site", async () => {
    await handleExtractPage("Go to example.com and find the heading");
    const result = await handleExecuteAction({ action: "navigate", value: "https://www.example.com/", confidence: 1, reason: "" });
    expect(result.ok).toBe(true);
    expect(result.navigateTo).toBe("https://www.example.com/");
  });

  it("typing into a button is incompatible; select stays unsupported and navigation needs the task to name the site", async () => {
    await handleExtractPage(CART_TASK);
    expect((await handleExecuteAction({ action: "type", target: "el_go", value: "x", confidence: 1, reason: "" })).code).toBe("incompatible_target");
    expect((await handleExecuteAction({ action: "navigate", value: "https://example.com/", confidence: 1, reason: "" })).code).toBe("navigation_not_authorised");
  });
});
