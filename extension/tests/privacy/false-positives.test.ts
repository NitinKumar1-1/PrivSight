import { beforeEach, describe, expect, it } from "vitest";
import { prepareRequest } from "../../src/content/perception";
import type { ReasonRequest } from "../../src/shared/contract";

/**
 * TEST 4 (Phase 4 remaining tests): task-relevant values must survive
 * sanitization while real PII is redacted. Runs the real DOM pipeline in
 * jsdom over a ShirtStore-like page that also carries non-PII numbers.
 */

const RAW_PII = ["demo@example.com", "9999999999", "DemoPassword123", "4111 1111 1111 1111", "123456"];

/** A numeric value counts as present only as a standalone number, not as digits inside a longer number. */
function containsValue(body: string, value: string): boolean {
  if (/^[\d\s-]+$/.test(value)) {
    const digits = value.replace(/\D/g, "");
    return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(body.replace(/[\s-]/g, ""));
  }
  return body.includes(value);
}
const MUST_SURVIVE = [
  "Black Shirt A", "Black Shirt B", "Black Shirt C",
  "₹799", "₹899", "₹699",
  "Order ID: 1234567890",
  "Invoice #5551234567",
  "Tracking number 7788990011",
  "Member since: 12/03/2024",
  "Quantity: 2",
  "Pin code 560001",
];

const PAGE = `
  <dl><dt>Email</dt><dd>demo@example.com</dd><dt>Phone</dt><dd>9999999999</dd></dl>
  <p>Order ID: 1234567890</p>
  <p>Invoice #5551234567 paid</p>
  <p>Tracking number 7788990011</p>
  <p>Member since: 12/03/2024</p>
  <p>Quantity: 2</p>
  <p>Pin code 560001</p>
  <p>Black Shirt A Price: ₹799</p><button id="buy_a">Buy Now A</button>
  <p>Black Shirt B Price: ₹899</p><button id="buy_b">Buy Now B</button>
  <p>Black Shirt C Price: ₹699</p><button id="buy_c">Buy Now C</button>
  <form>
    <label for="email">Email</label><input id="email" type="email" value="demo@example.com">
    <label for="phone">Phone</label><input id="phone" type="tel" value="9999999999">
    <label for="password">Password</label><input id="password" type="password" value="DemoPassword123">
    <label>Card number <input name="card_number" autocomplete="cc-number" value="4111 1111 1111 1111"></label>
    <label>OTP <input name="otp" autocomplete="one-time-code" value="123456"></label>
    <label>Order reference <input name="order_ref" value="ORD-2024-5821"></label>
    <label>Quantity <input type="number" name="qty" value="2"></label>
  </form>
`;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  document.title = "ShirtStore";
  document.body.innerHTML = PAGE;
});

describe("false positives: task-relevant numbers survive, PII does not", () => {
  it("keeps prices, order ids, invoice, tracking, dates, quantities and pin codes", () => {
    const { firewall } = prepareRequest("Find the cheapest black shirt and click Buy Now");
    expect(firewall.verdict).toBe("allowed");
    if (firewall.verdict !== "allowed") return;
    const body = JSON.parse(firewall.body) as ReasonRequest;
    for (const text of MUST_SURVIVE) expect(body.page.text, `expected "${text}" to survive`).toContain(text);
    // the non-sensitive order reference field keeps its value as element text
    expect(body.page.elements.find((el) => el.id === "el_order_ref")?.text).toBe("ORD-2024-5821");
  });

  it("still redacts every real PII value, in both page text and fields", () => {
    const { firewall, summary } = prepareRequest("Find the cheapest black shirt and click Buy Now");
    if (firewall.verdict !== "allowed") throw new Error(firewall.reason);
    for (const value of RAW_PII) expect(containsValue(firewall.body, value), `${value} must be absent as a standalone value`).toBe(false);
    expect(summary.placeholders).toEqual(["[EMAIL_1]", "[PHONE_1]", "[PASSWORD_1]", "[CARD_1]", "[OTP_1]"]);
  });

  it("reports the exact TP / FP / FN counts for this page", () => {
    const { firewall, summary } = prepareRequest("task");
    if (firewall.verdict !== "allowed") throw new Error(firewall.reason);
    const body = firewall.body;

    const tp = RAW_PII.filter((v) => !containsValue(body, v)).length; // sensitive and removed
    const fn = RAW_PII.length - tp; // sensitive but still present
    const fp = MUST_SURVIVE.filter((t) => !JSON.parse(body).page.text.includes(t)).length; // non-sensitive but removed

    expect({ tp, fp, fn }).toEqual({ tp: 5, fp: 0, fn: 0 });
    // Exactly five placeholders: no over-detection created extras.
    expect(summary.placeholders).toHaveLength(5);
  });
});

describe("known limitation, recorded on purpose", () => {
  it("a bare mobile-shaped value in a non-sensitive field is blocked by the fail-closed verifier, not sent", () => {
    // The detector keeps this field (label says order reference), but the serialized element text is the
    // bare value with no label around it, and the independent verifier treats a 10-digit token starting
    // with 6-9 as a possible phone. The request is blocked rather than sent: over-blocking, never leaking.
    document.body.innerHTML = `<label>Order reference <input name="order_ref" value="9876543210"></label><button id="buy_a">Buy Now A</button>`;
    const { firewall } = prepareRequest("task");
    expect(firewall.verdict).toBe("blocked");
    if (firewall.verdict === "blocked") {
      expect(firewall.reason).toContain("PHONE pattern detected");
      expect(firewall.reason).not.toContain("9876543210");
    }
  });
});
