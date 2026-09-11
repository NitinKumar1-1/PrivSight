/**
 * Integration: real screenshot -> real local OCR -> fusion -> visual PII
 * detection -> bounding-box regions -> sanitized observations -> leakage
 * verifier -> firewall -> approved bytes. Node + WebAssembly, no network.
 *
 * Also the negative path: the approved bytes must contain no raw value and no
 * image data even though the raw screenshot was the input.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPayloadPatterns } from "../../src/privacy/leakage";
import { prepareOutgoingRequest } from "../../src/privacy/sanitize";
import type { PageInfo, ReasonRequest } from "../../src/shared/contract";
import { createTesseractEngine, type OcrEngine } from "../../src/vision/ocr";
import type { OcrResult } from "../../src/vision/types";

const ROOT = resolve(__dirname, "../..");
const RAW_VALUES = ["demo@example.com", "9999999999", "4111 1111 1111 1111", "4111111111111111", "123456"];
const TASK = "Find the cheapest black shirt and click Buy Now";

/** The DOM of visual-privacy.html as the extension would extract it: no account values, three buttons. */
const PRIVACY_PAGE_DOM: PageInfo = {
  url: "http://localhost:8080/visual-privacy.html",
  title: "ShirtStore - Visual Privacy",
  elements: [
    { id: "el_products", tag: "a", text: "Products", role: "link" },
    { id: "el_about", tag: "a", text: "About", role: "link" },
    { id: "el_buy_a", tag: "button", text: "Buy Now A", role: "button" },
    { id: "el_buy_b", tag: "button", text: "Buy Now B", role: "button" },
    { id: "el_buy_c", tag: "button", text: "Buy Now C", role: "button" },
  ],
  text: "ShirtStore\nProducts\nAbout\nBlack Shirts\nBlack Shirt A\nPrice: ₹799\nBuy Now A\nBlack Shirt B\nPrice: ₹899\nBuy Now B\nBlack Shirt C\nPrice: ₹699\nBuy Now C",
};

/** visual.html: Shirt C's name and price are pixels only. */
const FALLBACK_PAGE_DOM: PageInfo = {
  ...PRIVACY_PAGE_DOM,
  url: "http://localhost:8080/visual.html",
  title: "ShirtStore - Visual Fallback",
  text: "ShirtStore\nProducts\nAbout\nBlack Shirts\nBlack Shirt A\nPrice: ₹799\nBuy Now A\nBlack Shirt B\nPrice: ₹899\nBuy Now B\nBuy Now C",
};

let engine: OcrEngine;
let privacyOcr: OcrResult;
let fallbackOcr: OcrResult;

beforeAll(async () => {
  engine = await createTesseractEngine({ langPath: resolve(ROOT, "public/vendor/tessdata") });
  privacyOcr = await engine.recognize(resolve(ROOT, "eval/fixtures/visual-privacy.png"), { width: 2560, height: 2000 });
  fallbackOcr = await engine.recognize(resolve(ROOT, "eval/fixtures/visual.png"), { width: 2560, height: 2000 });
}, 120_000);

afterAll(async () => engine.terminate());

describe("visual privacy: screenshot -> OCR -> PII -> masks -> firewall", () => {
  it("the local OCR actually read the canvas-only sensitive values (they are not in the DOM)", () => {
    const text = privacyOcr.lines.map((l) => l.text).join("\n");
    expect(text).toMatch(/demo@example\.com/);
    expect(text.replace(/\D/g, "")).toContain("9999999999");
    expect(text.replace(/\D/g, "")).toContain("4111111111111111");
    expect(text).toMatch(/123456/);
    expect(PRIVACY_PAGE_DOM.text).not.toContain("demo@example.com");
  });

  it("produces an approved payload with placeholders, mask regions, and no raw value or image data", () => {
    const prepared = prepareOutgoingRequest(TASK, PRIVACY_PAGE_DOM, [], privacyOcr);
    expect(prepared.firewall.verdict).toBe("allowed");
    if (prepared.firewall.verdict !== "allowed") return;

    const body = prepared.firewall.body;
    for (const value of RAW_VALUES) expect(body).not.toContain(value);
    expect(body.replace(/[\s-]/g, "")).not.toContain("4111111111111111");
    expect(body).not.toMatch(/data:image|base64,/);
    for (const placeholder of ["[EMAIL_1]", "[PHONE_1]", "[CARD_1]", "[OTP_1]"]) expect(body).toContain(placeholder);

    const parsed = JSON.parse(body) as ReasonRequest;
    expect(parsed.visual?.engine).toContain("tesseract");
    const texts = parsed.visual?.observations.map((o) => o.text) ?? [];
    expect(texts.some((t) => t.includes("[EMAIL_1]"))).toBe(true);
    expect(texts.some((t) => /Order ID:? 8845120033/.test(t))).toBe(true); // negative preserved

    expect(prepared.visualPrivacy?.maskRegions.length).toBeGreaterThanOrEqual(4);
    for (const region of prepared.visualPrivacy?.maskRegions ?? []) {
      expect(region.bbox.width).toBeGreaterThan(0);
      expect(region.bbox.height).toBeGreaterThan(0);
    }
    expect(verifyPayloadPatterns(body).safe).toBe(true);
  });

  it("keeps the placeholder map and the raw OCR lines local: neither appears in the summary", () => {
    const prepared = prepareOutgoingRequest(TASK, PRIVACY_PAGE_DOM, [], privacyOcr);
    const summary = JSON.stringify({ summary: prepared.summary, visualPrivacy: prepared.visualPrivacy });
    for (const value of RAW_VALUES) expect(summary).not.toContain(value);
  });
});

describe("visual fallback: canvas text the DOM lacks reaches the payload", () => {
  it("adds Black Shirt C and its price from vision, maps buttons to DOM ids, sends no raw image", () => {
    const prepared = prepareOutgoingRequest(TASK, FALLBACK_PAGE_DOM, [], fallbackOcr);
    expect(prepared.firewall.verdict).toBe("allowed");
    if (prepared.firewall.verdict !== "allowed") return;
    const parsed = JSON.parse(prepared.firewall.body) as ReasonRequest;
    const observations = parsed.visual?.observations ?? [];
    const texts = observations.map((o) => o.text.toLowerCase());
    expect(texts.some((t) => t.includes("black shirt c"))).toBe(true);
    expect(texts.some((t) => /rs\.?\s?699|699/.test(t))).toBe(true);
    for (const o of observations) if (o.target) expect(o.target).toMatch(/^el_/);
    expect(prepared.firewall.body).not.toMatch(/data:image/);
  });
});

describe("negative: a screenshot injected into the request is blocked before fetch", () => {
  it("the pre-fetch gate rejects a body carrying the fixture as base64", () => {
    const png = readFileSync(resolve(ROOT, "eval/fixtures/visual.png")).toString("base64").slice(0, 2000);
    const body = JSON.stringify({ ...JSON.parse(JSON.stringify({ task: TASK, page: PRIVACY_PAGE_DOM, placeholders: [] })), page: { ...PRIVACY_PAGE_DOM, text: png } });
    const gate = verifyPayloadPatterns(body);
    expect(gate.safe).toBe(false);
  });
});
