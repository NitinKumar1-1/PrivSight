import { describe, expect, it } from "vitest";
import { verifyPayloadPatterns, verifySerializedPayload } from "../../src/privacy/leakage";
import type { KnownValue } from "../../src/privacy/types";
import type { ReasonRequest } from "../../src/shared/contract";

const KNOWN: KnownValue[] = [
  { type: "EMAIL", value: "demo@example.com" },
  { type: "PHONE", value: "9999999999" },
  { type: "PASSWORD", value: "DemoPassword123" },
  { type: "CARD", value: "4111 1111 1111 1111" },
  { type: "OTP", value: "123456" },
];

function request(overrides: Partial<ReasonRequest["page"]> = {}, task = "Find the cheapest black shirt"): string {
  const base: ReasonRequest = {
    task,
    page: {
      url: "http://localhost:8080/",
      title: "ShirtStore",
      elements: [
        { id: "el_email", tag: "input", text: "[EMAIL_1]", role: "textbox" },
        { id: "el_buy_now", tag: "button", text: "Buy Now", role: "button" },
      ],
      text: "Email [EMAIL_1] Phone [PHONE_1] Black Shirt C Price: 699",
      ...overrides,
    },
    placeholders: ["[EMAIL_1]", "[PHONE_1]"],
  };
  return JSON.stringify(base);
}

describe("verifySerializedPayload: safe payloads", () => {
  it("TEST 1: passes a sanitized payload that uses placeholders", () => {
    const result = verifySerializedPayload(request(), KNOWN);
    expect(result.safe).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(["structure", "image-data", "known-values", "patterns"]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("does not flag prices, element ids or ordinary words", () => {
    const body = request({ text: "Black Shirt A 799 Black Shirt B 899 Order ID: 9876543210" });
    expect(verifySerializedPayload(body, KNOWN).safe).toBe(true);
  });
});

describe("verifySerializedPayload: known raw values are blocked", () => {
  const cases: Array<[string, string, string]> = [
    ["TEST 2: email", "Email demo@example.com", "EMAIL"],
    ["TEST 3: phone", "Phone 9999999999", "PHONE"],
    ["TEST 4: card", "Card 4111 1111 1111 1111", "CARD"],
    ["TEST 5: password", "Password DemoPassword123", "PASSWORD"],
    ["TEST 6: otp", "OTP 123456", "OTP"],
  ];

  for (const [name, text, type] of cases) {
    it(`${name} in page text is blocked and the value is not echoed`, () => {
      const result = verifySerializedPayload(request({ text }), KNOWN);
      expect(result.safe).toBe(false);
      if (result.safe) return;
      expect(result.type).toBe(type);
      expect(result.reason).toBe(`${type} leakage detected`);
      expect(result.reason).not.toContain(KNOWN.find((k) => k.type === type)?.value);
    });
  }

  it("catches a known value in the task, url, title or element text", () => {
    expect(verifySerializedPayload(request({}, "mail demo@example.com"), KNOWN).safe).toBe(false);
    expect(verifySerializedPayload(request({ url: "http://x/?e=demo@example.com" }), KNOWN).safe).toBe(false);
    expect(verifySerializedPayload(request({ title: "Hi 9999999999" }), KNOWN).safe).toBe(false);
    const withElement = request({
      elements: [{ id: "el_password", tag: "input", text: "DemoPassword123", role: "textbox" }],
    });
    expect(verifySerializedPayload(withElement, KNOWN).safe).toBe(false);
  });

  it("catches case and spacing variants of a known value", () => {
    expect(verifySerializedPayload(request({ text: "DEMO@EXAMPLE.COM" }), KNOWN).safe).toBe(false);
    const digitsOnly = verifySerializedPayload(request({ text: "card 4111111111111111" }), KNOWN);
    expect(digitsOnly.safe).toBe(false);
    if (!digitsOnly.safe) expect(digitsOnly.type).toBe("CARD");
    const dashed = verifySerializedPayload(request({ text: "card 4111-1111-1111-1111" }), KNOWN);
    expect(dashed.safe).toBe(false);
  });
});

describe("verifySerializedPayload: numeric known values are digit-bounded", () => {
  it("does not treat an order id that contains the OTP digits as a leak, but still catches the OTP itself", () => {
    expect(verifySerializedPayload(request({ text: "Order ID: 1234567890 Invoice #5551234567" }), KNOWN).safe).toBe(true);
    const leak = verifySerializedPayload(request({ text: "code 123456 sent" }), KNOWN);
    expect(leak.safe).toBe(false);
    if (!leak.safe) expect(leak.type).toBe("OTP");
  });
});

describe("verifySerializedPayload: independent pattern checks", () => {
  it("blocks an email the redactor never registered", () => {
    const result = verifySerializedPayload(request({ text: "contact other@example.org" }), []);
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.type).toBe("EMAIL");
  });

  it("blocks an unregistered Luhn-valid card number and an unregistered mobile", () => {
    const card = verifySerializedPayload(request({ text: "5555 5555 5555 4444" }), []);
    expect(card.safe).toBe(false);
    if (!card.safe) expect(card.type).toBe("CARD");
    const phone = verifySerializedPayload(request({ text: "Call 9876543210" }), []);
    expect(phone.safe).toBe(false);
    if (!phone.safe) expect(phone.type).toBe("PHONE");
  });

  it("verifyPayloadPatterns runs the same checks without known values", () => {
    expect(verifyPayloadPatterns(request()).safe).toBe(true);
    expect(verifyPayloadPatterns(request({ text: "x@y.io" })).safe).toBe(false);
  });
});

describe("verifySerializedPayload: structure and fail-closed", () => {
  it("TEST 7: fails closed on non-string, empty, or unparseable input", () => {
    for (const bad of [undefined, null, 42, {}, "", "not json", "[1,2]"]) {
      const result = verifySerializedPayload(bad, KNOWN);
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.type).toBe("UNKNOWN");
    }
  });

  it("rejects unexpected top-level or nested fields that could smuggle data", () => {
    const extra = JSON.parse(request());
    extra.debug = "demo@example.com";
    expect(verifySerializedPayload(JSON.stringify(extra), []).safe).toBe(false);

    const nested = JSON.parse(request());
    nested.page.raw = "x";
    expect(verifySerializedPayload(JSON.stringify(nested), []).safe).toBe(false);

    const element = JSON.parse(request());
    element.page.elements[0].value = "x";
    expect(verifySerializedPayload(JSON.stringify(element), []).safe).toBe(false);
  });

  it("rejects malformed placeholder names and non-string fields", () => {
    const badPlaceholder = JSON.parse(request());
    badPlaceholder.placeholders = ["[EMAIL_1]", "demo@example.com"];
    expect(verifySerializedPayload(JSON.stringify(badPlaceholder), []).safe).toBe(false);

    const numberText = JSON.parse(request());
    numberText.page.text = 12345;
    expect(verifySerializedPayload(JSON.stringify(numberText), []).safe).toBe(false);
  });
});
