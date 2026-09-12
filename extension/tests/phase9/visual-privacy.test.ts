/**
 * Phase 9 (hardening): the visual privacy pipeline separates visual objects,
 * visual text, sensitive information and PII.
 *
 *   screenshot -> OCR lines (visual text) -> PII classification (text
 *   detectors + layout labels) -> redaction (placeholders) -> mask regions
 *   (word boxes of the redacted values) -> preview (exactly those boxes)
 *   -> serialized request -> leakage verifier -> firewall
 *
 * A picture is a visual object: never a mask region. A text line is not PII
 * unless a detector types it. Only the words that held the value are masked.
 */

import { describe, expect, it } from "vitest";
import { runAgent, type AgentPorts } from "../../src/agent/controller";
import { findInteractiveElements, ensureElementIds, PS_ID_ATTRIBUTE } from "../../src/content/element-ids";
import { handleExtractPage } from "../../src/content/handlers";
import { classifyFieldDetailed, findTextMatches } from "../../src/privacy/detectors";
import { verifySerializedPayload } from "../../src/privacy/leakage";
import { prepareOutgoingRequest } from "../../src/privacy/sanitize";
import { detectVisualPii } from "../../src/privacy/visual-pii";
import type { ExtractPageResult } from "../../src/shared/messages";
import type { OcrLine, OcrResult } from "../../src/vision/types";

/** An OCR line with evenly spaced word boxes on one row. */
function line(text: string, x: number, y: number, wordWidth = 60, height = 20): OcrLine {
  const words = text.split(" ").map((word, i) => ({ text: word, confidence: 0.95, bbox: { x: x + i * (wordWidth + 8), y, width: wordWidth, height } }));
  const last = words[words.length - 1].bbox;
  return { text, confidence: 0.95, words, bbox: { x, y, width: last.x + last.width - x, height } };
}
function ocr(lines: OcrLine[]): OcrResult {
  return { engine: "test-ocr", imageWidth: 1400, imageHeight: 900, lines, timings: { loadMs: 0, recognizeMs: 1 } };
}
const page = (text = "") => ({ url: "https://shop.example/cart", title: "Cart", elements: [], text });
const inside = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }) =>
  inner.x >= outer.x - 4 && inner.y >= outer.y - 4 && inner.x + inner.width <= outer.x + outer.width + 4 && inner.y + inner.height <= outer.y + outer.height + 4;

describe("A. visual objects are not sensitive: product pictures are never mask regions", () => {
  it("1. a page of product pictures with ordinary captions yields zero mask regions and an allowed request", () => {
    const lines = [line("Sony WH-1000XM5 Wireless Headphones", 300, 100), line("INR 28,456.02", 300, 130), line("Delete Save for later Share", 300, 160)];
    const prepared = prepareOutgoingRequest("complete the checkout", page("Sony WH-1000XM5 Wireless Headphones INR 28,456.02"), [], ocr(lines), []);
    expect(prepared.visualPrivacy?.maskRegions).toEqual([]);
    expect(prepared.summary.placeholders).toEqual([]);
    expect(prepared.firewall.verdict).toBe("allowed");
  });

  it("2. a product name and price inside an image (OCR text) are visual text, not PII: kept for the reasoner", () => {
    const lines = [line("Laptop A", 100, 100), line("₹49,999", 100, 130), line("Laptop B", 400, 100), line("₹54,999", 400, 130)];
    const prepared = prepareOutgoingRequest("find the cheaper laptop", page(""), [], ocr(lines), []);
    expect(prepared.visualPrivacy?.maskRegions).toEqual([]);
    expect(prepared.visualPrivacy?.observationsSent).toBe(4);
    const body = prepared.firewall.verdict === "allowed" ? prepared.firewall.body : "";
    expect(body).toContain("49,999");
    expect(body).toContain("54,999");
  });

  it("the classifier never treats a control whose label names a product as a phone/card field", () => {
    document.body.innerHTML = `
      <input type="submit" aria-label="Delete Sony WH-1000XM5 Premium Noise Cancelling Wireless Headphones" value="Delete">
      <input type="submit" aria-label="Save for later Boat Smartphone case with card holder" value="Save for later">
      <a href="#" aria-label="Share automobile mobile charger">Share</a>
      <button aria-label="Add microphone cardigan to cart">Add</button>
      <input type="text" name="quantity" value="2">`;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("input, a, button"))) {
      expect(classifyFieldDetailed(el), el.getAttribute("aria-label") ?? el.getAttribute("name") ?? "").toBeNull();
    }
  });

  it("real phone, email, card and address fields are still classified", () => {
    document.body.innerHTML = `
      <input type="text" name="mobile" value="9876543210">
      <input type="text" aria-label="Phone number" value="">
      <input type="text" autocomplete="street-address" value="42 Park Street">
      <input type="text" placeholder="Card number">
      <input type="email" value="">`;
    const types = Array.from(document.querySelectorAll<HTMLElement>("input")).map((el) => classifyFieldDetailed(el)?.type);
    expect(types).toEqual(["PHONE", "PHONE", "ADDRESS", "CARD", "EMAIL"]);
  });
});

describe("B. sensitive information inside a picture is masked at the value, not the picture", () => {
  const picture = { x: 100, y: 100, width: 400, height: 300 };

  it("3. an email in an image: only the email's word box is masked, the caption words are not", () => {
    const l = line("Contact user@example.com for details", picture.x + 10, picture.y + 200);
    const prepared = prepareOutgoingRequest("t", page(""), [], ocr([l]), []);
    const regions = prepared.visualPrivacy!.maskRegions;
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("EMAIL");
    expect(inside(regions[0].bbox, l.words[1].bbox)).toBe(true); // the email word only
    expect(inside(l.words[0].bbox, regions[0].bbox)).toBe(false); // "Contact" stays visible
    expect(prepared.firewall.verdict).toBe("allowed");
    if (prepared.firewall.verdict === "allowed") expect(prepared.firewall.body).not.toContain("user@example.com");
  });

  it("4. a phone number in an image: the number's word boxes are masked; the label word is not", () => {
    const l = line("Call 98765 43210 today", picture.x + 10, picture.y + 200);
    const prepared = prepareOutgoingRequest("t", page(""), [], ocr([l]), []);
    const [region] = prepared.visualPrivacy!.maskRegions;
    expect(region.type).toBe("PHONE");
    expect(inside(l.words[1].bbox, region.bbox)).toBe(true);
    expect(inside(l.words[2].bbox, region.bbox)).toBe(true);
    expect(inside(l.words[0].bbox, region.bbox)).toBe(false);
    expect(inside(l.words[3].bbox, region.bbox)).toBe(false);
  });

  it("5. a labelled address in an image is a sensitive region", () => {
    const lines = [line("Deliver to", 120, 300), line("42 Park Street, Agra 282010", 120, 330), line("Address", 120, 400), line("17 Lake View Road Pune 411001", 120, 425)];
    const matches = detectVisualPii(lines);
    expect(matches.some((m) => m.type === "ADDRESS" && m.lineIndex === 3 && m.source === "layout")).toBe(true);
    const prepared = prepareOutgoingRequest("t", page(""), [], ocr(lines), []);
    const types = prepared.visualPrivacy!.maskRegions.map((r) => r.type);
    expect(types).toContain("ADDRESS");
    if (prepared.firewall.verdict === "allowed") expect(prepared.firewall.body).not.toContain("Lake View");
    expect(prepared.firewall.verdict).toBe("allowed");
  });

  it("6. several sensitive values in one image: one region per value, the rest of the image untouched", () => {
    const lines = [line("Sony Headphones INR 28,456", 110, 110), line("Email user@example.com Phone 98765 43210", 110, 250), line("Card 4539 1488 0343 6467", 110, 300)];
    const prepared = prepareOutgoingRequest("t", page(""), [], ocr(lines), []);
    const regions = prepared.visualPrivacy!.maskRegions;
    expect(regions.map((r) => r.type).sort()).toEqual(["CARD", "EMAIL", "PHONE"]);
    expect(regions.every((r) => r.bbox.width < 400)).toBe(true); // never the 400px-wide picture
    expect(regions.some((r) => inside(lines[0].bbox, r.bbox))).toBe(false); // the caption line is untouched
  });

  it("7. a whole line is masked only when the whole line is the value (a value on its own line)", () => {
    const only = line("user@example.com", 110, 250);
    const prepared = prepareOutgoingRequest("t", page(""), [], ocr([only]), []);
    const [region] = prepared.visualPrivacy!.maskRegions;
    expect(inside(only.bbox, region.bbox)).toBe(true);
    expect(region.bbox.width).toBeLessThanOrEqual(only.bbox.width + 6);
  });
});

describe("C. the leakage verifier and the firewall are unchanged and fail closed", () => {
  it("8. the verifier rejects a placeholder name outside the vocabulary and a raw value in the body", () => {
    expect(verifySerializedPayload(JSON.stringify({ task: "t", page: page(""), placeholders: ["[NAME_1]"] }), []).safe).toBe(false);
    expect(verifySerializedPayload(JSON.stringify({ task: "t", page: page("mail me at user@example.com"), placeholders: [] }), []).safe).toBe(false);
    expect(verifySerializedPayload(JSON.stringify({ task: "t", page: page("Deliver to [ADDRESS_1]"), placeholders: ["[ADDRESS_1]"] }), []).safe).toBe(true);
  });

  it("9. a known value that survives redaction still blocks the request", () => {
    const body = JSON.stringify({ task: "t", page: page("call 9876543210"), placeholders: ["[PHONE_1]"] });
    expect(verifySerializedPayload(body, [{ type: "PHONE", value: "98765 43210" }]).safe).toBe(false);
  });
});

describe("D. detected region -> redacted region -> preview region use the same coordinates", () => {
  it("the box handed to the preview renderer is the padded word box of the redacted value, in capture pixels", async () => {
    const value = line("Email user@example.com", 500, 700);
    const rendered: Array<{ x: number; y: number; width: number; height: number }[]> = [];
    let extractedRegions: { x: number; y: number; width: number; height: number }[] = [];
    const ports: AgentPorts = {
      ensureContentScript: async () => undefined,
      capture: async () => ({ dataUrl: "data:image/png;base64,AAAA", devicePixelRatio: 2 }),
      perceive: async () => ocr([value]),
      visionInfo: async () => null,
      extract: async (task, ocrResult) => {
        const prepared = prepareOutgoingRequest(task, page(""), [], ocrResult, []);
        extractedRegions = prepared.visualPrivacy!.maskRegions.map((r) => r.bbox);
        return { ok: true, summary: prepared.summary, firewall: prepared.firewall, visualPrivacy: prepared.visualPrivacy, imageRegions: [{ x: 50, y: 50, width: 100, height: 100 }] } satisfies ExtractPageResult;
      },
      reason: async () => ({ action: "done", confidence: 1, reason: "" }),
      execute: async () => ({ ok: true, message: "done", validation: "pass" }),
      renderMask: async (_capture, regions) => {
        rendered.push(regions);
        return "data:image/png;base64,MASK";
      },
      report: () => undefined,
      now: () => 0,
    };
    await runAgent("what is on this page", ports);
    // detected: the email word box; redacted region: that box padded by 3px; preview: the identical box, unscaled (OCR boxes are already capture pixels)
    const word = value.words[1].bbox;
    expect(extractedRegions).toEqual([{ x: word.x - 3, y: word.y - 3, width: word.width + 6, height: word.height + 6 }]);
    expect(rendered[0]).toEqual(extractedRegions);
  });
});

describe("E. end to end on a cart-like page: controls named after products are not PII", () => {
  it("the Amazon-shaped cart row extracts with no placeholders, no mask regions, and an allowed request", async () => {
    Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 100, top: 10, left: 10, right: 110, bottom: 110, x: 10, y: 10, toJSON: () => ({}) });
    document.body.innerHTML = `
      <img src="x.png" alt="Sony WH-1000XM5 Headphones" width="100" height="100">
      <span>Sony WH-1000XM5 Premium Noise Cancelling Wireless Headphones, Black</span>
      <span>INR 28,456.02</span>
      <span class="a-button"><input class="a-button-input" type="submit" aria-label="Delete Sony WH-1000XM5 Premium Noise Cancelling Wireless Headphones" value="Delete"><span aria-hidden="true">Delete</span></span>
      <span class="a-button"><input class="a-button-input" type="submit" aria-label="Save for later Sony WH-1000XM5 Headphones" value="Save for later"><span aria-hidden="true">Save for later</span></span>
      <a href="#" aria-label="Share Sony Headphones">Share</a>
      <a href="#cart">Cart 2</a>`;
    const lines = [line("Sony WH-1000XM5 Premium Noise Cancelling Wireless Headphones, Black", 300, 100), line("Delete Save for later Share", 300, 160), line("INR 28,456.02", 900, 100)];
    const result = await handleExtractPage("complete the checkout for sony headphones", ocr(lines));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.placeholders).toEqual([]);
    expect(result.visualPrivacy?.maskRegions).toEqual([]);
    expect(result.firewall.verdict).toBe("allowed");
    expect(result.imageRegions?.length).toBe(1); // the picture is listed (for the count), never masked
  });

  it("a control whose visible text is a value gets a counter id, never an id built from the value", () => {
    document.body.innerHTML = `<a href="mailto:user@example.com">user@example.com</a><a href="tel:9876543210">98765 43210</a><a href="#">Contact us</a>`;
    const elements = findInteractiveElements();
    ensureElementIds(elements);
    const ids = elements.map((el) => el.getAttribute(PS_ID_ATTRIBUTE));
    expect(ids[0]).toMatch(/^el_\d+$/);
    expect(ids[1]).toMatch(/^el_\d+$/);
    expect(ids[2]).toBe("el_contact_us");
    expect(findTextMatches("user@example.com")).toHaveLength(1);
  });
});
