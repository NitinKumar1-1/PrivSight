import { describe, expect, it } from "vitest";
import { ENGINE_LABEL, parseTesseractResult, unionBox, type TesseractData } from "../../src/vision/ocr";

function data(lines: Array<{ text: string; confidence: number; box: [number, number, number, number]; words?: Array<{ text: string; confidence: number; box: [number, number, number, number] }> }>): TesseractData {
  return {
    blocks: [
      {
        paragraphs: [
          {
            lines: lines.map((l) => ({
              text: l.text,
              confidence: l.confidence,
              bbox: { x0: l.box[0], y0: l.box[1], x1: l.box[2], y1: l.box[3] },
              words: (l.words ?? []).map((w) => ({ text: w.text, confidence: w.confidence, bbox: { x0: w.box[0], y0: w.box[1], x1: w.box[2], y1: w.box[3] } })),
            })),
          },
        ],
      },
    ],
  };
}

describe("parseTesseractResult", () => {
  it("converts blocks into lines with boxes divided by the upscale factor and confidence in 0..1", () => {
    const result = parseTesseractResult(
      data([{ text: "Black Shirt C\n", confidence: 93.4, box: [100, 200, 460, 260], words: [{ text: "Black", confidence: 95, box: [100, 200, 200, 260] }] }]),
      2,
    );
    expect(result.engine).toBe(ENGINE_LABEL);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual({
      text: "Black Shirt C",
      bbox: { x: 50, y: 100, width: 180, height: 30 },
      confidence: 0.93,
      words: [{ text: "Black", bbox: { x: 50, y: 100, width: 50, height: 30 }, confidence: 0.95 }],
    });
  });

  it("tolerates missing blocks, null data and malformed entries", () => {
    expect(parseTesseractResult(undefined, 1).lines).toEqual([]);
    expect(parseTesseractResult({ blocks: null }, 1).lines).toEqual([]);
    const malformed = {
      blocks: [{ paragraphs: [{ lines: [
        { text: "no box", confidence: 90 },
        { text: "inverted box", confidence: 90, bbox: { x0: 10, y0: 10, x1: 5, y1: 5 } },
        { text: "", confidence: 90, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
        { text: "NaN conf", confidence: Number.NaN, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
      ] }] }],
    } as unknown as TesseractData;
    const result = parseTesseractResult(malformed, 1);
    expect(result.lines.map((l) => l.text)).toEqual(["NaN conf"]);
    expect(result.lines[0].confidence).toBe(0);
  });

  it("derives line text and box from words when the line lacks them", () => {
    const partial = {
      blocks: [{ paragraphs: [{ lines: [{ words: [
        { text: "Buy", confidence: 90, bbox: { x0: 0, y0: 0, x1: 30, y1: 10 } },
        { text: "Now", confidence: 90, bbox: { x0: 35, y0: 0, x1: 70, y1: 12 } },
      ] }] }] }],
    } as unknown as TesseractData;
    const result = parseTesseractResult(partial, 1);
    expect(result.lines[0].text).toBe("Buy Now");
    expect(result.lines[0].bbox).toEqual({ x: 0, y: 0, width: 70, height: 12 });
  });

  it("falls back to scale 1 when the scale is invalid and clamps confidence", () => {
    const result = parseTesseractResult(data([{ text: "x", confidence: 250, box: [0, 0, 10, 10] }]), 0);
    expect(result.lines[0].bbox.width).toBe(10);
    expect(result.lines[0].confidence).toBe(1);
  });

  it("unionBox merges boxes and returns null for none", () => {
    expect(unionBox([])).toBeNull();
    expect(unionBox([{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 20, height: 20 }])).toEqual({ x: 0, y: 0, width: 25, height: 25 });
  });
});
