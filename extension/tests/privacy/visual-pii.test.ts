/**
 * Visual PII detection over OCR-style text lines: label:value pairs, regex
 * values, and the false positives that must be left alone.
 */

import { describe, expect, it } from "vitest";
import { findLabelledValues, findTextMatches } from "../../src/privacy/detectors";
import { Redactor } from "../../src/privacy/redactor";

describe("findLabelledValues (semantic label signals)", () => {
  it("types values by their label: OTP, password, CVV, card, phone, email", () => {
    const cases: Array<[string, string, string]> = [
      ["OTP: 123456", "OTP", "123456"],
      ["One-time code: 4821", "OTP", "4821"],
      ["Password: Tr0ub4dor&3", "PASSWORD", "Tr0ub4dor&3"],
      ["CVV: 123", "CVV", "123"],
      ["Card: 4111 1111 1111 1111", "CARD", "4111 1111 1111 1111"],
      ["Card number: 4111111111111111", "CARD", "4111111111111111"],
      ["Phone: +91 98765 43210", "PHONE", "+91 98765 43210"],
      ["Email: demo@example.com", "EMAIL", "demo@example.com"],
    ];
    for (const [text, type, value] of cases) {
      const found = findLabelledValues(text);
      expect(found.map((m) => [m.type, m.value]), text).toEqual([[type, value]]);
      expect(text.slice(found[0].index, found[0].index + value.length)).toBe(value);
    }
  });

  it("ignores labels whose value has the wrong shape", () => {
    expect(findLabelledValues("OTP: contact support")).toEqual([]);
    expect(findLabelledValues("OTP: 12")).toEqual([]);
    expect(findLabelledValues("CVV: 12345")).toEqual([]);
    expect(findLabelledValues("Card: Visa")).toEqual([]);
    expect(findLabelledValues("Email: not-an-email")).toEqual([]);
  });

  it("requires an explicit separator so bare labels followed by other words are untouched", () => {
    expect(findLabelledValues("Password Card number OTP Buy Now C")).toEqual([]);
    expect(findLabelledValues("OTP 123456")).toEqual([]);
  });
});

describe("findTextMatches on OCR-style lines (true positives)", () => {
  it("finds every value in the visual privacy fixture text", () => {
    const lines = ["Email: demo@example.com", "Phone: 9999999999", "Card: 4111 1111 1111 1111", "OTP: 123456"];
    const types = lines.map((l) => findTextMatches(l).map((m) => m.type));
    expect(types).toEqual([["EMAIL"], ["PHONE"], ["CARD"], ["OTP"]]);
  });

  it("finds an email and a phone with no label at all", () => {
    expect(findTextMatches("demo@example.com").map((m) => m.type)).toEqual(["EMAIL"]);
    expect(findTextMatches("call 9876543210 today").map((m) => m.type)).toEqual(["PHONE"]);
  });
});

describe("findTextMatches on OCR-style lines (true negatives)", () => {
  it("leaves prices, product names, dates, order ids and ordinary numbers alone", () => {
    const negatives = [
      "Price: ₹699",
      "Price: Rs 699",
      "Price: 7699",
      "Black Shirt C",
      "Buy Now C",
      "Member since: 12/03/2024",
      "Order ID: 8845120033",
      "Invoice 2024-00017",
      "Quantity: 2",
      "Signed in as",
      "1280 x 1100 pixels",
      "Delivery details",
    ];
    for (const text of negatives) expect(findTextMatches(text), text).toEqual([]);
  });

  it("does not turn an OCR-misread rupee price into a phone number", () => {
    // "₹799" often comes back as "7799"; still not ten digits, still not a phone.
    expect(findTextMatches("Price: 7799 Price: 7899 Price: 7699")).toEqual([]);
  });
});

describe("Redactor over OCR lines", () => {
  it("redacts with consistent placeholders across DOM and visual text", () => {
    const r = new Redactor();
    expect(r.redactText("Email demo@example.com")).toBe("Email [EMAIL_1]");
    expect(r.redactText("Email: demo@example.com")).toBe("Email: [EMAIL_1]");
    expect(r.redactText("OTP: 123456")).toBe("OTP: [OTP_1]");
    expect(r.redactText("Order ID: 8845120033")).toBe("Order ID: 8845120033");
    expect(r.summary().placeholders).toEqual(["[EMAIL_1]", "[OTP_1]"]);
  });
});

describe("placeholders are never re-detected as values", () => {
  it("a label followed by an existing placeholder produces no new match", () => {
    expect(findLabelledValues("Password: [PASSWORD_1] OTP: [OTP_1]")).toEqual([]);
  });

  it("redacting text that already contains placeholders is idempotent", () => {
    const r = new Redactor();
    r.placeholderFor("PASSWORD", "DemoPassword123");
    const once = r.redactText("Password: DemoPassword123");
    expect(once).toBe("Password: [PASSWORD_1]");
    expect(r.redactText(once)).toBe(once);
    expect(r.knownValues().map((k) => k.value)).toEqual(["DemoPassword123"]);
  });
});
