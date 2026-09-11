import { describe, expect, it } from "vitest";
import { domProductPrices, fuseObservations } from "../../src/content/fusion";
import type { PageInfo } from "../../src/shared/contract";
import type { OcrResult } from "../../src/vision/types";

const BUTTONS = [
  { id: "el_buy_a", text: "Buy Now A" },
  { id: "el_buy_b", text: "Buy Now B" },
  { id: "el_buy_c", text: "Buy Now C" },
];

function page(text: string, elements = BUTTONS.map((b) => ({ id: b.id, tag: "button", text: b.text, role: "button" }))): PageInfo {
  return { url: "http://localhost:8080/", title: "ShirtStore", elements, text };
}

/** Lines laid out in a column: [text, confidence, x, y]. */
function ocr(lines: Array<[string, number, number, number]>): OcrResult {
  return {
    engine: "test",
    imageWidth: 1280,
    imageHeight: 1000,
    timings: { loadMs: 0, recognizeMs: 0 },
    lines: lines.map(([text, confidence, x, y]) => ({
      text,
      confidence,
      bbox: { x, y, width: 220, height: 24 },
      words: text.split(" ").map((w, i) => ({ text: w, confidence, bbox: { x: x + i * 50, y, width: 45, height: 24 } })),
    })),
  };
}

const DOM_FULL = "Black Shirts\nBlack Shirt A\nPrice: ₹799\nBuy Now A\nBlack Shirt B\nPrice: ₹899\nBuy Now B\nBlack Shirt C\nPrice: ₹699\nBuy Now C";

describe("domProductPrices", () => {
  it("pairs product names with the price line that follows", () => {
    const prices = domProductPrices(DOM_FULL);
    expect(prices.get("black shirt a")).toBe(799);
    expect(prices.get("black shirt c")).toBe(699);
    expect(prices.size).toBe(3);
  });
});

describe("fuseObservations", () => {
  it("DOM only: no OCR result yields no observations and no conflicts", () => {
    const result = fuseObservations(page(DOM_FULL), null, BUTTONS);
    expect(result.kept).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("DOM + visual with agreement: duplicates are dropped, buttons are mapped", () => {
    const vision = ocr([["Black Shirt A", 0.95, 200, 380], ["Price: 799", 0.85, 200, 410], ["Buy Now A", 0.9, 200, 450], ["Black Shirt B", 0.95, 500, 380], ["Price: Rs 899", 0.85, 500, 410]]);
    const result = fuseObservations(page(DOM_FULL), vision, BUTTONS);
    expect(result.kept.map((k) => [k.observation.type, k.observation.text, k.observation.target])).toEqual([["button", "Buy Now A", "el_buy_a"]]);
    expect(result.stats.duplicatesDropped).toBe(4);
    expect(result.conflicts).toEqual([]);
  });

  it("visual fallback: text the DOM lacks is kept as visual-only context", () => {
    const domWithoutC = "Black Shirts\nBlack Shirt A\nPrice: ₹799\nBuy Now A\nBlack Shirt B\nPrice: ₹899\nBuy Now B\nBuy Now C";
    const vision = ocr([["Black Shirt C", 0.93, 800, 380], ["Price: Rs 699", 0.9, 800, 410], ["Buy Now C", 0.88, 800, 450]]);
    const result = fuseObservations(page(domWithoutC), vision, BUTTONS);
    expect(result.kept.map((k) => [k.observation.type, k.observation.text, k.observation.target])).toEqual([
      ["text", "Black Shirt C", null],
      ["price", "Price: Rs 699", null],
      ["button", "Buy Now C", "el_buy_c"],
    ]);
    expect(result.stats.visualOnly).toBe(2);
    expect(result.stats.buttonsMapped).toBe(1);
    expect(result.kept[0].line.text).toBe("Black Shirt C");
  });

  it("conflict: a visual price that disagrees with the DOM is dropped and reported, DOM wins", () => {
    const vision = ocr([["Black Shirt A", 0.95, 200, 380], ["Price: 7799", 0.85, 200, 410]]);
    const result = fuseObservations(page(DOM_FULL), vision, BUTTONS);
    expect(result.kept).toEqual([]);
    expect(result.conflicts).toEqual(["Black Shirt A: page text says 799, vision read Price: 7799"]);
    expect(result.stats.conflictsDropped).toBe(1);
  });

  it("a visual price with no product name above it and no DOM match is kept as visual-only", () => {
    const vision = ocr([["Price: Rs 499", 0.85, 200, 410]]);
    const result = fuseObservations(page("Black Shirts"), vision, BUTTONS);
    expect(result.kept.map((k) => k.observation.type)).toEqual(["price"]);
  });

  it("low-confidence lines never become observations", () => {
    const vision = ocr([["Black Shirt Z", 0.3, 200, 380], ["Price: Rs 1", 0.2, 200, 410]]);
    const result = fuseObservations(page("Black Shirts"), vision, BUTTONS);
    expect(result.kept).toEqual([]);
  });

  it("a visual button label with no matching DOM button is plain text, never a click target", () => {
    const vision = ocr([["Buy Now Z", 0.9, 200, 450]]);
    const result = fuseObservations(page("Black Shirts"), vision, BUTTONS);
    expect(result.kept.map((k) => [k.observation.type, k.observation.target])).toEqual([["text", null]]);
  });
});
