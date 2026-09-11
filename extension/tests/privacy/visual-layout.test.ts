import { describe, expect, it } from "vitest";
import { labelType, valueMatchesShape } from "../../src/privacy/detectors";
import { detectVisualPii, findLayoutLabelledValues } from "../../src/privacy/visual-pii";
import { mergeLines, splitLineByGaps } from "../../src/vision/ocr";
import { polarizeRgba } from "../../src/vision/preprocess";
import type { OcrLine, OcrResult } from "../../src/vision/types";
import { prepareOutgoingRequest } from "../../src/privacy/sanitize";

function line(text: string, x: number, y: number, width = text.length * 14, height = 28, confidence = 0.95): OcrLine {
  return { text, bbox: { x, y, width, height }, confidence, words: [] };
}

describe("labelType and valueMatchesShape", () => {
  it("types labels and demands the matching value shape", () => {
    expect(labelType("Card number")).toBe("CARD");
    expect(labelType("Verification code")).toBe("OTP");
    expect(labelType("Ticket")).toBeNull();
    expect(valueMatchesShape("OTP", "4821")).toBe(true);
    expect(valueMatchesShape("OTP", "48")).toBe(false);
    expect(valueMatchesShape("PASSWORD", "Secret#2026")).toBe(true);
    expect(valueMatchesShape("PASSWORD", "Forgot?")).toBe(false); // no digit or symbol
    expect(valueMatchesShape("CARD", "5555 5555 5555 4444")).toBe(true);
  });
});

describe("findLayoutLabelledValues (13C: label in one OCR line, value in another)", () => {
  it("pairs a label with the value to its right on the same row", () => {
    const lines = [line("Card number", 80, 500), line("5555 5555 5555 4444", 480, 502), line("OTP", 80, 560), line("654321", 480, 561)];
    const out = findLayoutLabelledValues(lines);
    expect(out.map((m) => [m.type, m.value, m.source])).toEqual([["CARD", "5555 5555 5555 4444", "layout"], ["OTP", "654321", "layout"]]);
  });

  it("pairs a label with the value directly below it (stacked layout)", () => {
    const lines = [line("Verification code", 80, 800), line("4821", 84, 840), line("Email address", 80, 940), line("buyer.two@shop.example", 84, 980)];
    const out = findLayoutLabelledValues(lines);
    expect(out.map((m) => [m.type, m.value])).toEqual([["OTP", "4821"], ["EMAIL", "buyer.two@shop.example"]]);
  });

  it("never types a value whose label is not a PII label, or whose shape does not fit", () => {
    const lines = [line("Ticket", 80, 500), line("88451200", 480, 502), line("Quantity", 80, 560), line("2", 480, 561), line("Order reference", 80, 620), line("ORD-2024-5821", 480, 622), line("Password", 80, 680), line("Forgot?", 480, 682)];
    expect(findLayoutLabelledValues(lines)).toEqual([]);
  });

  it("ignores values that are far away or not aligned, and bare numbers with no label", () => {
    const lines = [line("OTP", 80, 500), line("654321", 1200, 900), line("123456", 80, 300)];
    expect(findLayoutLabelledValues(lines)).toEqual([]);
  });

  it("does not use a line that already carries its own value as a label, and claims each value once", () => {
    const lines = [line("OTP: 123456", 80, 500), line("654321", 480, 502)];
    expect(findLayoutLabelledValues(lines)).toEqual([]);
    const all = detectVisualPii(lines);
    expect(all.map((m) => [m.type, m.value, m.source])).toEqual([["OTP", "123456", "text"]]);
  });
});

describe("mergeLines (second OCR pass)", () => {
  it("adds non-overlapping second-pass lines and keeps first-pass lines where they overlap", () => {
    const first = [line("Buy Now B", 700, 150), line("Button styles", 50, 60)];
    const second = [line("Buy Now A", 60, 150), line("Buy Now B", 702, 151), line("Checkout", 700, 300)];
    const merged = mergeLines(first, second);
    expect(merged.map((l) => l.text)).toEqual(["Button styles", "Buy Now A", "Buy Now B", "Checkout"]);
    expect(merged.filter((l) => l.text === "Buy Now B")).toHaveLength(1);
  });

  it("lets a real second-pass line through when only a low-confidence junk line covers it", () => {
    const junk = { ...line("MEE Oe", 454, 892, 1652, 82, 0.32) };
    const second = [line("Buy Now A", 618, 922, 200, 28)];
    expect(mergeLines([junk], second).map((l) => l.text)).toEqual(["MEE Oe", "Buy Now A"]);
  });

  it("splits a column-fused line at wide word gaps so labels keep their own context", () => {
    const word = (t: string, x: number, w: number) => ({ text: t, bbox: { x, y: 446, width: w, height: 24 }, confidence: 0.95 });
    const fused: OcrLine = {
      text: "Phone: 9999999999 Order ID: 8845120033", bbox: { x: 464, y: 446, width: 1164, height: 24 }, confidence: 0.95,
      words: [word("Phone:", 464, 90), word("9999999999", 565, 170), word("Order", 1321, 80), word("ID:", 1410, 40), word("8845120033", 1460, 168)],
    };
    const parts = splitLineByGaps(fused);
    expect(parts.map((p) => p.text)).toEqual(["Phone: 9999999999", "Order ID: 8845120033"]);
    expect(parts[1].bbox.x).toBe(1321);
    const single: OcrLine = { ...fused, words: [word("Phone:", 464, 90), word("9999999999", 565, 170)] };
    expect(splitLineByGaps(single)).toHaveLength(1);
  });

  it("drops a second-pass fragment that lies inside an already recognised line", () => {
    // First pass read the whole "Order ID: 8845120033" line; the second pass read only the digits inside it.
    const first = [{ ...line("Order ID: 8845120033", 900, 200, 420, 30) }];
    const second = [line("8845120033", 1060, 202, 250, 26)];
    expect(mergeLines(first, second).map((l) => l.text)).toEqual(["Order ID: 8845120033"]);
  });
});

describe("polarizeRgba", () => {
  it("maps both white-on-dark and dark-on-white to dark text on a light background", () => {
    const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255, 245, 158, 11, 255]);
    polarizeRgba(px);
    expect(px[0]).toBe(254); // white -> light
    expect(px[4]).toBe(255); // black -> light (polarity folded)
    expect(px[8]).toBe(0); // mid grey -> dark
    expect(px[12]).toBeLessThan(128); // orange (luma 167) -> dark, so white labels on it become dark-on-light
    expect(px[3]).toBe(255); // alpha untouched
  });
});

describe("OCR-known values are redacted in the DOM copy too (ordering regression)", () => {
  it("a form-row OTP the DOM channel misses is replaced in page text once vision labels it, and the firewall allows the request", () => {
    // DOM: label and value in separate elements, no separator -> the DOM channel alone misses it.
    document.body.innerHTML = `<div><label>OTP</label><span>654321</span></div><button id="buy_a">Buy Now A</button>`;
    const raw = { url: "u", title: "t", elements: [{ id: "el_buy_a", tag: "button", text: "Buy Now A", role: "button" }], text: "OTP 654321 Buy Now A" };
    const ocr: OcrResult = {
      engine: "test", imageWidth: 1000, imageHeight: 400, timings: { loadMs: 0, recognizeMs: 0 },
      lines: [line("OTP", 80, 100), line("654321", 400, 101), line("Buy Now A", 80, 300)],
    };
    const prepared = prepareOutgoingRequest("task", raw, [document.getElementById("buy_a") as HTMLElement], ocr);
    expect(prepared.firewall.verdict).toBe("allowed");
    if (prepared.firewall.verdict !== "allowed") return;
    const body = JSON.parse(prepared.firewall.body);
    expect(body.page.text).toBe("OTP [OTP_1] Buy Now A");
    expect(body.placeholders).toEqual(["[OTP_1]"]);
    expect(prepared.firewall.body).not.toContain("654321");
  });
});
