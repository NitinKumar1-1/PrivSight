import { beforeEach, describe, expect, it } from "vitest";
import { extractPageInfo } from "../../src/content/perception";
import { resolvePlaceholder, sanitizePage } from "../../src/privacy/sanitize";
import type { PageInfo, ReasonRequest } from "../../src/shared/contract";

const RAW_VALUES = ["demo@example.com", "9999999999", "DemoPassword123", "4111 1111 1111 1111", "123456"];

// Mirrors the Phase 2 demo page: visible PII text plus prefilled sensitive fields.
const DEMO_PAGE = `
  <nav><a href="#products">Products</a></nav>
  <h1>Black Shirts</h1>
  <p>Black Shirt A Price: 799</p>
  <p>Black Shirt C Price: 699</p>
  <dl><dt>Email</dt><dd>demo@example.com</dd><dt>Phone</dt><dd>9999999999</dd></dl>
  <form>
    <label for="email">Email</label><input id="email" type="email" value="demo@example.com">
    <label for="phone">Phone</label><input id="phone" type="tel" value="9999999999">
    <label for="password">Password</label><input id="password" type="password" value="DemoPassword123">
    <label>Card number <input name="card_number" autocomplete="cc-number" value="4111 1111 1111 1111"></label>
    <label>OTP <input name="otp" autocomplete="one-time-code" value="123456"></label>
  </form>
  <button id="buy_now">Buy Now</button>
`;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  document.title = "ShirtStore - Black Shirts";
  document.body.innerHTML = DEMO_PAGE;
});

describe("sanitizePage", () => {
  it("redacts field values and page text with consistent placeholders", () => {
    const raw: PageInfo = {
      url: "http://localhost:8080/index.html",
      title: "ShirtStore",
      elements: [
        { id: "el_email", tag: "input", text: "demo@example.com", role: "textbox" },
        { id: "el_buy_now", tag: "button", text: "Buy Now", role: "button" },
      ],
      text: "Email demo@example.com Phone 9999999999 Black Shirt C Price: 699",
    };
    const emailInput = document.getElementById("email") as HTMLElement;
    const buyButton = document.getElementById("buy_now") as HTMLElement;

    const { page, summary } = sanitizePage(raw, [emailInput, buyButton]);

    expect(page.elements[0].text).toBe("[EMAIL_1]");
    expect(page.elements[1].text).toBe("Buy Now");
    expect(page.text).toBe("Email [EMAIL_1] Phone [PHONE_1] Black Shirt C Price: 699");
    expect(summary.placeholders).toEqual(["[EMAIL_1]", "[PHONE_1]"]);
  });

  it("keeps the placeholder map local and resolvable after sanitizing", () => {
    const raw: PageInfo = { url: "", title: "", elements: [], text: "Email demo@example.com" };
    sanitizePage(raw, []);
    expect(resolvePlaceholder("[EMAIL_1]")).toBe("demo@example.com");
  });
});

describe("extractPageInfo on the demo page", () => {
  it("produces a request whose serialized form contains no raw PII", () => {
    const { page, summary } = extractPageInfo();
    const request: ReasonRequest = { task: "Find the cheapest black shirt and click Buy Now", page, placeholders: summary.placeholders };
    const wire = JSON.stringify(request);

    for (const value of RAW_VALUES) expect(wire).not.toContain(value);
    expect(wire).toContain("[EMAIL_1]");
    expect(wire).toContain("[PHONE_1]");
    expect(wire).toContain("[PASSWORD_1]");
    expect(wire).toContain("[CARD_1]");
    expect(wire).toContain("[OTP_1]");
  });

  it("keeps non-sensitive context intact for reasoning", () => {
    const { page } = extractPageInfo();
    expect(page.text).toContain("Black Shirt C");
    expect(page.text).toContain("699");
    expect(page.elements.find((el) => el.id === "el_buy_now")?.text).toBe("Buy Now");
  });

  it("does not leak field values through element identifiers", () => {
    const { page } = extractPageInfo();
    const ids = page.elements.map((el) => el.id);
    expect(ids).toContain("el_card_number");
    expect(ids).toContain("el_otp");
    for (const id of ids) {
      for (const value of RAW_VALUES) expect(id).not.toContain(value.replace(/\W/g, "_"));
    }
  });

  it("reports the same placeholder for a value seen in a field and in text", () => {
    const { page, summary } = extractPageInfo();
    expect(summary.placeholders.filter((p) => p.startsWith("[EMAIL_"))).toEqual(["[EMAIL_1]"]);
    expect(page.elements.find((el) => el.id === "el_email")?.text).toBe("[EMAIL_1]");
    expect(page.text).toContain("[EMAIL_1]");
  });
});
