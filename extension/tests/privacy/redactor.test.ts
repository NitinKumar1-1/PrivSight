import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/privacy/redactor";

describe("Redactor.placeholderFor", () => {
  it("numbers placeholders per type in order of first sight", () => {
    const r = new Redactor();
    expect(r.placeholderFor("EMAIL", "a@x.io")).toBe("[EMAIL_1]");
    expect(r.placeholderFor("PHONE", "9999999999")).toBe("[PHONE_1]");
    expect(r.placeholderFor("EMAIL", "b@x.io")).toBe("[EMAIL_2]");
  });

  it("returns the same placeholder for the same value", () => {
    const r = new Redactor();
    expect(r.placeholderFor("EMAIL", "a@x.io")).toBe("[EMAIL_1]");
    expect(r.placeholderFor("EMAIL", "a@x.io")).toBe("[EMAIL_1]");
    expect(r.summary().placeholders).toEqual(["[EMAIL_1]"]);
  });
});

describe("Redactor.redactText", () => {
  it("replaces pattern-detected values", () => {
    const r = new Redactor();
    expect(r.redactText("My email is user@example.com")).toBe("My email is [EMAIL_1]");
    expect(r.redactText("Call me at 9876543210")).toBe("Call me at [PHONE_1]");
  });

  it("reuses placeholders already assigned to field values", () => {
    const r = new Redactor();
    r.placeholderFor("PASSWORD", "DemoPassword123");
    r.placeholderFor("EMAIL", "demo@example.com");
    const out = r.redactText("Email demo@example.com password DemoPassword123 phone 9999999999");
    expect(out).toBe("Email [EMAIL_1] password [PASSWORD_1] phone [PHONE_1]");
  });

  it("replaces every occurrence of a value", () => {
    const r = new Redactor();
    expect(r.redactText("a@x.io and again a@x.io")).toBe("[EMAIL_1] and again [EMAIL_1]");
  });

  it("leaves text without PII unchanged", () => {
    const r = new Redactor();
    const text = "Black Shirt C Price: 699 Buy Now";
    expect(r.redactText(text)).toBe(text);
    expect(r.summary().placeholders).toEqual([]);
  });
});

describe("Redactor.resolve and summary", () => {
  it("resolves a placeholder locally and never exposes values in the summary", () => {
    const r = new Redactor();
    r.placeholderFor("EMAIL", "demo@example.com");
    expect(r.resolve("[EMAIL_1]")).toBe("demo@example.com");
    expect(r.resolve("[EMAIL_9]")).toBeUndefined();

    const summary = r.summary();
    expect(summary).toEqual({ placeholders: ["[EMAIL_1]"], types: { "[EMAIL_1]": "EMAIL" }, detections: [] });
    expect(JSON.stringify(summary)).not.toContain("demo@example.com");
  });
});
