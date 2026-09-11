import { describe, expect, it } from "vitest";
import { maskRegionsForLine, padRegions } from "../../src/privacy/masking";
import type { OcrLine } from "../../src/vision/types";

function line(text: string, words: Array<[string, number, number]>): OcrLine {
  return {
    text,
    confidence: 0.9,
    bbox: { x: words[0]?.[1] ?? 0, y: 100, width: 600, height: 30 },
    words: words.map(([w, x, width]) => ({ text: w, confidence: 0.9, bbox: { x, y: 100, width, height: 30 } })),
  };
}

describe("maskRegionsForLine", () => {
  it("returns no regions when nothing was redacted", () => {
    const l = line("Black Shirt C", [["Black", 0, 80], ["Shirt", 90, 80], ["C", 180, 20]]);
    expect(maskRegionsForLine(l, "Black Shirt C", [])).toEqual([]);
  });

  it("masks only the word that held the value and keeps the label visible", () => {
    const l = line("Email: demo@example.com", [["Email:", 0, 90], ["demo@example.com", 100, 260]]);
    const regions = maskRegionsForLine(l, "Email: [EMAIL_1]", ["demo@example.com"]);
    expect(regions).toEqual([{ type: "EMAIL", bbox: { x: 100, y: 100, width: 260, height: 30 } }]);
  });

  it("merges the several words of a spaced card number into one region", () => {
    const l = line("Card: 4111 1111 1111 1111", [["Card:", 0, 80], ["4111", 90, 60], ["1111", 160, 60], ["1111", 230, 60], ["1111", 300, 60]]);
    const regions = maskRegionsForLine(l, "Card: [CARD_1]", ["4111 1111 1111 1111"]);
    expect(regions).toEqual([{ type: "CARD", bbox: { x: 90, y: 100, width: 270, height: 30 } }]);
  });

  it("handles multiple sensitive values on one line with separate regions", () => {
    const l = line("Email demo@example.com Phone 9999999999", [["Email", 0, 70], ["demo@example.com", 80, 240], ["Phone", 330, 70], ["9999999999", 410, 150]]);
    const regions = maskRegionsForLine(l, "Email [EMAIL_1] Phone [PHONE_1]", ["demo@example.com", "9999999999"]);
    expect(regions.map((r) => r.type)).toEqual(["EMAIL", "PHONE"]);
    expect(regions[0].bbox.x).toBe(80);
    expect(regions[1].bbox.x).toBe(410);
  });

  it("covers unambiguous digit fragments, and falls back to the whole line when no word can be matched", () => {
    const l = line("OTP: 123456", [["OTP:", 0, 60], ["12", 70, 30], ["3456", 110, 60]]);
    const regions = maskRegionsForLine(l, "OTP: [OTP_1]", ["123456"]);
    expect(regions).toHaveLength(1);
    // Only fragments of 3+ digits are matched to the value (a 2-digit token is too ambiguous).
    expect(regions[0].bbox).toEqual({ x: 110, y: 100, width: 60, height: 30 });

    const noWords: OcrLine = { ...l, words: [] };
    expect(maskRegionsForLine(noWords, "OTP: [OTP_1]", ["123456"])).toEqual([{ type: "OTP", bbox: noWords.bbox }]);
  });

  it("always produces at least one region when the text changed but no values were passed", () => {
    const l = line("Phone 9999999999", [["Phone", 0, 70], ["9999999999", 80, 150]]);
    const regions = maskRegionsForLine(l, "Phone [PHONE_1]", []);
    expect(regions).toEqual([{ type: "PHONE", bbox: l.bbox }]);
  });

  it("padRegions grows boxes without going negative", () => {
    expect(padRegions([{ type: "EMAIL", bbox: { x: 1, y: 1, width: 10, height: 10 } }], 3)).toEqual([
      { type: "EMAIL", bbox: { x: 0, y: 0, width: 16, height: 16 } },
    ]);
  });
});
