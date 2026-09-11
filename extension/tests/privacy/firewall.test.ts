import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRequest } from "../../src/content/perception";
import { FIREWALL_BLOCK_PREFIX, inspectOutgoingRequest } from "../../src/privacy/firewall";
import { Redactor } from "../../src/privacy/redactor";
import { placeholderType, resolvePlaceholder, sensitiveTypeOf } from "../../src/privacy/sanitize";
import type { ReasonRequest } from "../../src/shared/contract";

const TASK = "Find the cheapest black shirt and click Buy Now";
const RAW_VALUES = ["demo@example.com", "9999999999", "DemoPassword123", "4111 1111 1111 1111", "123456"];

// Mirrors demo-site/index.html: visible PII text plus prefilled sensitive fields.
const DEMO_PAGE = `
  <nav><a href="#products">Products</a></nav>
  <dl><dt>Email</dt><dd>demo@example.com</dd><dt>Phone</dt><dd>9999999999</dd></dl>
  <h1>Black Shirts</h1>
  <p>Black Shirt A Price: 799</p><button id="buy_a">Buy Now A</button>
  <p>Black Shirt B Price: 899</p><button id="buy_b">Buy Now B</button>
  <p>Black Shirt C Price: 699</p><button id="buy_c">Buy Now C</button>
  <form>
    <label for="email">Email</label><input id="email" type="email" autocomplete="email" value="demo@example.com">
    <label for="phone">Phone</label><input id="phone" type="tel" autocomplete="tel" value="9999999999">
    <label for="password">Password</label><input id="password" type="password" value="DemoPassword123">
    <label>Card number <input name="card_number" autocomplete="cc-number" value="4111 1111 1111 1111"></label>
    <label>OTP <input name="otp" autocomplete="one-time-code" value="123456"></label>
  </form>
`;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  document.title = "ShirtStore - Black Shirts";
  document.body.innerHTML = DEMO_PAGE;
});

afterEach(() => vi.restoreAllMocks());

describe("prepareRequest on the demo page (positive integration)", () => {
  it("allows the request and the approved bytes contain placeholders only", () => {
    const { firewall, summary } = prepareRequest(TASK);
    expect(firewall.verdict).toBe("allowed");
    if (firewall.verdict !== "allowed") return;

    for (const value of RAW_VALUES) expect(firewall.body).not.toContain(value);
    for (const placeholder of ["[EMAIL_1]", "[PHONE_1]", "[PASSWORD_1]", "[CARD_1]", "[OTP_1]"]) {
      expect(firewall.body).toContain(placeholder);
    }
    expect(firewall.checks.map((c) => `${c.name}:${c.passed}`)).toEqual([
      "structure:true", "image-data:true", "known-values:true", "patterns:true",
    ]);

    const parsed = JSON.parse(firewall.body) as ReasonRequest;
    expect(parsed.task).toBe(TASK);
    expect(parsed.placeholders).toEqual(summary.placeholders);
    expect(parsed.page.text).toContain("Black Shirt C");
  });

  it("extracts one uniquely identified Buy Now button per product with its price in context", () => {
    const { firewall } = prepareRequest(TASK);
    if (firewall.verdict !== "allowed") throw new Error("expected allowed");
    const parsed = JSON.parse(firewall.body) as ReasonRequest;
    const buttons = parsed.page.elements.filter((el) => el.id.startsWith("el_buy_"));
    expect(buttons).toEqual([
      { id: "el_buy_a", tag: "button", text: "Buy Now A", role: "button" },
      { id: "el_buy_b", tag: "button", text: "Buy Now B", role: "button" },
      { id: "el_buy_c", tag: "button", text: "Buy Now C", role: "button" },
    ]);
    for (const price of ["799", "899", "699"]) expect(parsed.page.text).toContain(price);
  });

  it("reports detections with element ids and signal names but no values", () => {
    const { summary } = prepareRequest(TASK);
    const byId = Object.fromEntries(summary.detections.map((d) => [d.elementId, d]));
    expect(byId.el_email.type).toBe("EMAIL");
    expect(byId.el_email.signals).toContain("type=email");
    expect(byId.el_card_number.type).toBe("CARD");
    expect(byId.el_otp.type).toBe("OTP");
    for (const value of RAW_VALUES) expect(JSON.stringify(summary)).not.toContain(value);
  });

  it("redacts PII typed into the task itself", () => {
    const { firewall } = prepareRequest("Email demo@example.com about shirt");
    expect(firewall.verdict).toBe("allowed");
    if (firewall.verdict === "allowed") {
      expect(firewall.body).toContain("[EMAIL_1]");
      expect(firewall.body).not.toContain("demo@example.com");
    }
  });

  it("keeps placeholder resolution and sensitive-field lookup local", () => {
    prepareRequest(TASK);
    expect(resolvePlaceholder("[EMAIL_1]")).toBe("demo@example.com");
    expect(placeholderType("[CARD_1]")).toBe("CARD");
    expect(sensitiveTypeOf("el_password")).toBe("PASSWORD");
    expect(sensitiveTypeOf("el_buy_c")).toBeUndefined();
  });
});

describe("prepareRequest with a sabotaged redactor (negative integration)", () => {
  it("blocks the request when redaction silently fails, naming only the type", () => {
    // Simulate a redactor bug: text passes through untouched.
    vi.spyOn(Redactor.prototype, "redactText").mockImplementation((text: string) => text);

    const { firewall } = prepareRequest(TASK);
    expect(firewall.verdict).toBe("blocked");
    if (firewall.verdict !== "blocked") return;

    expect(firewall.reason.startsWith(FIREWALL_BLOCK_PREFIX)).toBe(true);
    expect(firewall.reason).toMatch(/EMAIL leakage detected/);
    for (const value of RAW_VALUES) expect(firewall.reason).not.toContain(value);
    expect(firewall.checks.find((c) => c.name === "known-values")?.passed).toBe(false);
    expect("body" in firewall).toBe(false);
  });
});

describe("inspectOutgoingRequest", () => {
  const known = [{ type: "EMAIL" as const, value: "demo@example.com" }];
  const clean: ReasonRequest = {
    task: "t",
    page: { url: "u", title: "t", elements: [], text: "Email [EMAIL_1]" },
    placeholders: ["[EMAIL_1]"],
  };

  it("returns the exact serialized bytes on allow", () => {
    const verdict = inspectOutgoingRequest(clean, known);
    expect(verdict.verdict).toBe("allowed");
    if (verdict.verdict === "allowed") expect(verdict.body).toBe(JSON.stringify(clean));
  });

  it("blocks an intentionally leaked email and never echoes it", () => {
    const leaked = { ...clean, page: { ...clean.page, text: "Email demo@example.com" } };
    const verdict = inspectOutgoingRequest(leaked, known);
    expect(verdict.verdict).toBe("blocked");
    if (verdict.verdict === "blocked") {
      expect(verdict.reason).toBe(`${FIREWALL_BLOCK_PREFIX}: EMAIL leakage detected`);
    }
  });

  it("fails closed when the request cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const verdict = inspectOutgoingRequest(circular as unknown as ReasonRequest, known);
    expect(verdict.verdict).toBe("blocked");
  });
});
