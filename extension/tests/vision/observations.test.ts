import { describe, expect, it } from "vitest";
import { buildObservations, isPrice, matchButton, priceAmount } from "../../src/vision/observations";
import type { OcrResult } from "../../src/vision/types";

function ocr(lines: Array<[string, number, number?]>): OcrResult {
  return {
    engine: "test",
    imageWidth: 1000,
    imageHeight: 800,
    timings: { loadMs: 0, recognizeMs: 0 },
    lines: lines.map(([text, confidence, y = 0], i) => ({
      text,
      confidence,
      bbox: { x: 10, y: y || i * 30, width: 200, height: 20 },
      words: [],
    })),
  };
}

const BUTTONS = [
  { id: "el_buy_a", text: "Buy Now A" },
  { id: "el_buy_b", text: "Buy Now B" },
  { id: "el_buy_c", text: "Buy Now C" },
  { id: "el_products", text: "Products" },
];

describe("buildObservations", () => {
  it("classifies prices, maps button labels to DOM ids, and keeps other text", () => {
    const observations = buildObservations(ocr([["Black Shirt C", 0.93], ["Price: Rs 699", 0.9], ["Buy Now C", 0.88]]), BUTTONS);
    expect(observations.map((o) => [o.type, o.text, o.target])).toEqual([
      ["text", "Black Shirt C", null],
      ["price", "Price: Rs 699", null],
      ["button", "Buy Now C", "el_buy_c"],
    ]);
    expect(observations[0].bbox).toEqual({ x: 10, y: 0, width: 200, height: 20 });
    expect(observations[1].confidence).toBe(0.9);
  });

  it("drops lines below the confidence threshold and empty lines", () => {
    const observations = buildObservations(ocr([["Password sessssssnussees", 0.2], ["   ", 0.99], ["Email", 0.96]]), BUTTONS);
    expect(observations.map((o) => o.text)).toEqual(["Email"]);
  });

  it("returns nothing for a missing OCR result", () => {
    expect(buildObservations(null, BUTTONS)).toEqual([]);
  });

  it("never emits coordinates as a target: targets are DOM ids or null", () => {
    const observations = buildObservations(ocr([["Buy Now A", 0.9], ["Black Shirts", 0.9]]), BUTTONS);
    for (const o of observations) expect(o.target === null || /^el_/.test(o.target)).toBe(true);
  });
});

describe("isPrice and priceAmount", () => {
  it("recognizes rupee, Rs, INR and other currency amounts, and OCR-mangled rupee signs after a Price label", () => {
    for (const text of ["Price: ₹699", "Rs 699", "INR 1,299.00", "$19.99", "Price: 7699", "Price: %899"]) {
      expect(isPrice(text), text).toBe(true);
    }
  });

  it("does not treat plain numbers, phone-like strings or names as prices", () => {
    for (const text of ["9999999999", "Black Shirt C", "OTP 123456", "Order ID: 8845120033"]) {
      expect(isPrice(text), text).toBe(false);
    }
  });

  it("extracts the trailing amount", () => {
    expect(priceAmount("Price: Rs 699")).toBe(699);
    expect(priceAmount("INR 1,299.00")).toBe(1299);
    expect(priceAmount("no digits")).toBeNull();
  });
});

describe("matchButton", () => {
  it("matches exact labels case-insensitively and ignores punctuation", () => {
    expect(matchButton("buy now c", BUTTONS)?.id).toBe("el_buy_c");
    expect(matchButton("Buy Now C!", BUTTONS)?.id).toBe("el_buy_c");
  });

  it("tolerates a dropped space in the OCR reading of a label", () => {
    const buttons = [
      { id: "el_buy_a", text: "Buy Now A" },
      { id: "el_buy_b", text: "Buy Now B" },
    ];
    expect(matchButton("Buy NowA", buttons)?.id).toBe("el_buy_a");
    expect(matchButton("BuyNow B", buttons)?.id).toBe("el_buy_b");
    expect(matchButton("Buy NowC", buttons)).toBeNull();
  });

  it("does not match unrelated or ambiguous short text", () => {
    expect(matchButton("Buy", BUTTONS)).toBeNull();
    expect(matchButton("Black Shirt C", BUTTONS)).toBeNull();
    expect(matchButton("Now", BUTTONS)).toBeNull();
  });
});
