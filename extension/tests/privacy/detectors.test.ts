import { describe, expect, it } from "vitest";
import {
  THRESHOLD,
  classifyField,
  classifyFieldDetailed,
  fieldValue,
  findTextMatches,
  looksLikeIdentifier,
  luhnValid,
} from "../../src/privacy/detectors";

function field(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector("input, textarea") as HTMLElement;
}

describe("classifyField: single strong signals", () => {
  it("uses the input type", () => {
    expect(classifyField(field(`<input type="password">`))).toBe("PASSWORD");
    expect(classifyField(field(`<input type="email">`))).toBe("EMAIL");
    expect(classifyField(field(`<input type="tel">`))).toBe("PHONE");
  });

  it("uses the autocomplete attribute", () => {
    expect(classifyField(field(`<input autocomplete="cc-number">`))).toBe("CARD");
    expect(classifyField(field(`<input autocomplete="cc-csc">`))).toBe("CVV");
    expect(classifyField(field(`<input autocomplete="one-time-code">`))).toBe("OTP");
    expect(classifyField(field(`<input autocomplete="section-a new-password">`))).toBe("PASSWORD");
  });
});

describe("classifyField: medium signals", () => {
  it("uses name, id, class and placeholder keywords", () => {
    expect(classifyField(field(`<input name="user_email">`))).toBe("EMAIL");
    expect(classifyField(field(`<input id="mobile">`))).toBe("PHONE");
    expect(classifyField(field(`<input class="form-control otp-input">`))).toBe("OTP");
    expect(classifyField(field(`<input placeholder="Enter OTP">`))).toBe("OTP");
    expect(classifyField(field(`<input name="card_number">`))).toBe("CARD");
  });

  it("uses an associated label", () => {
    expect(classifyField(field(`<label for="x">Card Number</label><input id="x">`))).toBe("CARD");
    expect(classifyField(field(`<label>CVV <input></label>`))).toBe("CVV");
  });
});

describe("classifyField: hybrid combinations and conflicts", () => {
  it("combines several agreeing signals into a higher score", () => {
    const result = classifyFieldDetailed(field(`<input type="text" name="email" autocomplete="email">`));
    expect(result?.type).toBe("EMAIL");
    expect(result?.score).toBeGreaterThan(THRESHOLD);
    expect(result?.signals).toEqual(expect.arrayContaining(["autocomplete=email", "name~email"]));
  });

  it("lets a strong signal win over a conflicting keyword", () => {
    // Password input whose name mentions email (a "login with email" form).
    expect(classifyField(field(`<input type="password" name="email_password">`))).toBe("PASSWORD");
  });

  it("prefers the more specific keyword when two keywords tie", () => {
    expect(classifyField(field(`<input name="card_cvv">`))).toBe("CVV");
  });

  it("classifies from nearby text plus a matching value shape", () => {
    const el = field(`<div><span>Phone</span><input name="f1" value="9876543210"></div>`);
    const result = classifyFieldDetailed(el);
    expect(result?.type).toBe("PHONE");
    expect(result?.signals).toEqual(expect.arrayContaining(["nearby~phone", "value-shape~phone"]));
  });

  it("reports safe signal names only, never the value", () => {
    const result = classifyFieldDetailed(field(`<input type="email" value="someone@example.com">`));
    expect(JSON.stringify(result)).not.toContain("someone@example.com");
  });
});

describe("classifyField: false positives that must stay unclassified", () => {
  it("does not treat a 10-digit value alone as a phone number", () => {
    expect(classifyField(field(`<input name="f2" value="9876543210">`))).toBeNull();
  });

  it("does not treat an order reference field with a 10-digit value as a phone", () => {
    const el = field(`<div><span>Order ID</span><input name="order_ref" value="9876543210"></div>`);
    expect(classifyField(el)).toBeNull();
  });

  it("does not treat a 6-digit value alone as an OTP", () => {
    expect(classifyField(field(`<input name="quantity_code" value="123456">`))).toBeNull();
  });

  it("does not treat a Luhn-valid value alone as a card", () => {
    expect(classifyField(field(`<input name="ref" value="4111111111111111">`))).toBeNull();
  });

  it("does not classify a search box, a name field or a quantity field", () => {
    expect(classifyField(field(`<input name="search" placeholder="Search shirts">`))).toBeNull();
    expect(classifyField(field(`<input name="full_name" value="Demo User">`))).toBeNull();
    expect(classifyField(field(`<input type="number" name="qty" value="2">`))).toBeNull();
  });

  it("returns null for non-fields", () => {
    document.body.innerHTML = `<button id="b">Buy Now</button>`;
    expect(classifyField(document.getElementById("b") as HTMLElement)).toBeNull();
  });
});

describe("fieldValue", () => {
  it("returns the trimmed value of a field and empty for other elements", () => {
    expect(fieldValue(field(`<input value="  a@b.co ">`))).toBe("a@b.co");
    document.body.innerHTML = `<button id="b">Buy</button>`;
    expect(fieldValue(document.getElementById("b") as HTMLElement)).toBe("");
  });
});

describe("findTextMatches", () => {
  it("finds email addresses", () => {
    expect(findTextMatches("Email: demo@example.com today")).toEqual([
      { type: "EMAIL", value: "demo@example.com", index: 7 },
    ]);
  });

  it("finds Indian mobile numbers with and without +91", () => {
    const values = findTextMatches("Call 9999999999 or +91 98765 43210").map((m) => m.value);
    expect(values).toEqual(["9999999999", "+91 98765 43210"]);
  });

  it("finds formatted international and US numbers", () => {
    const values = findTextMatches("UK +44 20 7946 0958, US (555) 123-4567").map((m) => m.value);
    expect(values).toEqual(["+44 20 7946 0958", "(555) 123-4567"]);
  });

  it("finds Luhn-valid card numbers and reports them as CARD, not PHONE", () => {
    expect(findTextMatches("Card 4111 1111 1111 1111 on file")).toEqual([
      { type: "CARD", value: "4111 1111 1111 1111", index: 5 },
    ]);
  });

  it("ignores prices, short numbers and Luhn-invalid digit runs", () => {
    expect(findTextMatches("Price: 799 Price: 899 Price: 699")).toEqual([]);
    expect(findTextMatches("Order 1234 5678 9012 3456")).toEqual([]);
  });

  it("does not match a phone number inside a longer digit run", () => {
    expect(findTextMatches("ref 12345678901234")).toEqual([]);
  });

  it("skips 10-digit order, invoice and tracking numbers", () => {
    expect(findTextMatches("Order ID: 9876543210")).toEqual([]);
    expect(findTextMatches("Invoice #9876543210 paid")).toEqual([]);
    expect(findTextMatches("Tracking number 9876543210")).toEqual([]);
  });

  it("still catches a phone even when an order number is mentioned earlier", () => {
    const values = findTextMatches("Order ID: 5551234 Phone: 9876543210").map((m) => m.value);
    expect(values).toEqual(["9876543210"]);
  });
});

describe("looksLikeIdentifier", () => {
  it("is true for reference context and false for phone context", () => {
    expect(looksLikeIdentifier("Order no: 98", 10)).toBe(true);
    expect(looksLikeIdentifier("Order help line phone: 98", 24)).toBe(false);
    expect(looksLikeIdentifier("Call 98", 5)).toBe(false);
  });
});

describe("luhnValid", () => {
  it("accepts the standard Visa test number and rejects a modified one", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("123")).toBe(false);
  });
});
