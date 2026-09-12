/**
 * Leakage verifier: the visual block and the image-data checks that keep
 * screenshots, masked images and raw OCR dumps off the wire.
 */

import { describe, expect, it } from "vitest";
import { verifyPayloadPatterns, verifySerializedPayload } from "../../src/privacy/leakage";
import type { ReasonRequest, VisualContext } from "../../src/shared/contract";

const VISUAL: VisualContext = {
  engine: "tesseract.js 7 LSTM (wasm)",
  observations: [
    { type: "text", text: "Black Shirt C", bbox: { x: 800, y: 380, width: 200, height: 24 }, confidence: 0.93, target: null },
    { type: "price", text: "Price: Rs 699", bbox: { x: 800, y: 410, width: 200, height: 24 }, confidence: 0.9, target: null },
    { type: "button", text: "Buy Now C", bbox: { x: 800, y: 450, width: 200, height: 24 }, confidence: 0.88, target: "el_buy_c" },
    { type: "text", text: "Email: [EMAIL_1]", bbox: { x: 40, y: 140, width: 300, height: 24 }, confidence: 0.92, target: null },
  ],
  conflicts: ["Black Shirt A: page text says 799, vision read Price: 7799"],
};

function request(visual?: unknown): string {
  const base: ReasonRequest = {
    task: "Find the cheapest black shirt and click Buy Now",
    page: { url: "http://localhost:8080/", title: "ShirtStore", elements: [{ id: "el_buy_c", tag: "button", text: "Buy Now C", role: "button" }], text: "Black Shirts" },
    placeholders: ["[EMAIL_1]"],
  };
  return JSON.stringify(visual === undefined ? base : { ...base, visual });
}

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const LONG_BASE64 = "A".repeat(600);

describe("visual block structure", () => {
  it("accepts a well-formed sanitized visual block", () => {
    const result = verifySerializedPayload(request(VISUAL), []);
    expect(result.safe).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(["structure", "image-data", "known-values", "patterns"]);
  });

  it("rejects unknown observation fields, unknown types, non-numeric boxes and oversized text", () => {
    const bad = [
      { ...VISUAL, observations: [{ ...VISUAL.observations[0], image: PNG_BASE64 }] },
      { ...VISUAL, observations: [{ ...VISUAL.observations[0], type: "screenshot" }] },
      { ...VISUAL, observations: [{ ...VISUAL.observations[0], bbox: { x: "1", y: 2, width: 3, height: 4 } }] },
      { ...VISUAL, observations: [{ ...VISUAL.observations[0], text: "x".repeat(600) }] },
      { ...VISUAL, raw: "..." },
      { engine: "e" },
    ];
    for (const visual of bad) {
      const result = verifySerializedPayload(request(visual), []);
      expect(result.safe, JSON.stringify(visual).slice(0, 80)).toBe(false);
    }
  });
});

describe("image data never crosses", () => {
  it("blocks a data:image URL anywhere in the payload", () => {
    const withImage = { ...VISUAL, observations: [{ ...VISUAL.observations[0], text: `data:image/png;base64,${PNG_BASE64}` }] };
    const result = verifySerializedPayload(request(withImage), []);
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.reason).toBe("image data detected in payload");
  });

  it("blocks a raw base64 run even without a data: prefix", () => {
    const smuggled = JSON.parse(request());
    smuggled.page.text = `Black Shirts ${LONG_BASE64}`;
    const result = verifySerializedPayload(JSON.stringify(smuggled), []);
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.reason).toBe("encoded binary data detected in payload");
  });

  it("blocks image MIME markers and PNG headers in text fields", () => {
    for (const marker of ["image/png", "image/jpeg", "\\u0089PNG\\r\\n"]) {
      const smuggled = JSON.parse(request());
      smuggled.task = `task ${marker}`;
      expect(verifySerializedPayload(JSON.stringify(smuggled), []).safe, marker).toBe(false);
    }
  });

  it("blocks an oversized field that could carry a raw OCR dump", () => {
    const smuggled = JSON.parse(request());
    smuggled.page.text = "word ".repeat(7000); // 35,000 chars: above the 32,000 field cap that follows the page-text cap
    const result = verifySerializedPayload(JSON.stringify(smuggled), []);
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.reason).toBe("oversized field detected in payload");
  });

  it("the pre-fetch gate applies the same image checks", () => {
    expect(verifyPayloadPatterns(request(VISUAL)).safe).toBe(true);
    const withImage = { ...VISUAL, observations: [{ ...VISUAL.observations[0], text: `data:image/png;base64,${PNG_BASE64}` }] };
    expect(verifyPayloadPatterns(request(withImage)).safe).toBe(false);
  });
});

describe("raw values inside visual observations", () => {
  it("blocks a known raw value that slipped into an observation", () => {
    const leaked = { ...VISUAL, observations: [{ ...VISUAL.observations[3], text: "Email: demo@example.com" }] };
    const result = verifySerializedPayload(request(leaked), [{ type: "EMAIL", value: "demo@example.com" }]);
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.type).toBe("EMAIL");
      expect(result.reason).not.toContain("demo@example.com");
    }
  });

  it("blocks an unregistered card or phone in an observation via the pattern check", () => {
    const card = { ...VISUAL, observations: [{ ...VISUAL.observations[0], text: "Card: 4111 1111 1111 1111" }] };
    expect(verifySerializedPayload(request(card), []).safe).toBe(false);
    const phone = { ...VISUAL, observations: [{ ...VISUAL.observations[0], text: "Phone: 9999999999" }] };
    expect(verifySerializedPayload(request(phone), []).safe).toBe(false);
  });

  it("keeps prices and product names in observations", () => {
    expect(verifySerializedPayload(request(VISUAL), [{ type: "EMAIL", value: "demo@example.com" }]).safe).toBe(true);
  });
});
