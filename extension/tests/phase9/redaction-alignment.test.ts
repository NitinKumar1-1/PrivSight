/**
 * Phase 9 (hardening): the redactor removes everything the leakage verifier
 * would flag, so a page the verifier would reject is sanitized rather than
 * blocked. The verifier itself is unchanged and still runs on the bytes.
 */

import { describe, expect, it } from "vitest";
import { findLeakMatches, verifySerializedPayload } from "../../src/privacy/leakage";
import { Redactor } from "../../src/privacy/redactor";
import { prepareOutgoingRequest } from "../../src/privacy/sanitize";

function body(text: string, redactor: Redactor) {
  return JSON.stringify({ task: "t", page: { url: "https://shop.example/cart", title: "Cart", elements: [], text: redactor.redactText(text) }, placeholders: redactor.summary().placeholders });
}

describe("known values are replaced in every variant the verifier checks", () => {
  it("a phone registered with spaces is also removed when the page repeats it without spaces or with dashes", () => {
    const r = new Redactor();
    r.placeholderFor("PHONE", "+91 98765 43210");
    const text = "Deliver to Kapil, call 9876543210 or 98765-43210 or +91 98765 43210 before delivery";
    const out = r.redactText(text);
    expect(out).not.toMatch(/98765|43210/);
    expect(verifySerializedPayload(body(text, r), r.knownValues()).safe).toBe(true);
  });

  it("an email registered in one case is removed in any case", () => {
    const r = new Redactor();
    r.placeholderFor("EMAIL", "Demo.User@Example.com");
    const out = r.redactText("Signed in as DEMO.USER@EXAMPLE.COM (demo.user@example.com)");
    expect(out).not.toMatch(/example\.com/i);
    expect(out).toContain("[EMAIL_1]");
  });

  it("a digit-bounded rule still protects order ids that merely contain the digits", () => {
    const r = new Redactor();
    r.placeholderFor("OTP", "123456");
    expect(r.redactText("Order 40412345678 · OTP 123456")).toBe("Order 40412345678 · OTP [OTP_1]");
  });
});

describe("the last redaction pass is aligned with the verifier's own patterns", () => {
  it("a mobile number in a spacing the detector patterns miss is still redacted, and the verifier then passes", () => {
    const r = new Redactor();
    const text = "Contact: 98765 43210 | Alt 9876543210 | Support 9876-543210";
    const out = r.redactText(text);
    expect(findLeakMatches(out)).toEqual([]);
    expect(verifySerializedPayload(body(text, r), r.knownValues()).safe).toBe(true);
  });

  it("a Luhn-valid card written with single spaces between every digit is redacted", () => {
    const r = new Redactor();
    const text = "Card on file 4 5 3 9 1 4 8 8 0 3 4 3 6 4 6 7";
    const out = r.redactText(text);
    expect(out).toContain("[CARD_1]");
    expect(findLeakMatches(out)).toEqual([]);
  });

  it("order and reference numbers keep the verifier's identifier exemption", () => {
    const r = new Redactor();
    const text = "Order number 9876543210 placed today";
    expect(r.redactText(text)).toBe(text);
    expect(verifySerializedPayload(body(text, r), []).safe).toBe(true);
  });

  it("end to end: a cart page repeating the delivery phone in another format is sanitized, not blocked", () => {
    document.body.innerHTML = `<input name="phone" type="tel" value="98765 43210"><p>Deliver to Kapil · 9876543210 · Subtotal (2 items): INR 29,409.01</p>`;
    const elements = Array.from(document.querySelectorAll<HTMLElement>("input"));
    elements[0].setAttribute("data-ps-id", "el_phone");
    const page = { url: "https://shop.example/cart", title: "Cart", elements: [{ id: "el_phone", tag: "input", text: "98765 43210", role: "textbox" }], text: document.body.textContent ?? "" };
    const prepared = prepareOutgoingRequest("complete the checkout", page, elements, null, []);
    expect(prepared.firewall.verdict).toBe("allowed");
    if (prepared.firewall.verdict === "allowed") {
      expect(prepared.firewall.body).not.toMatch(/98765|43210/);
      expect(prepared.firewall.body).toContain("29,409.01");
    }
  });
});
