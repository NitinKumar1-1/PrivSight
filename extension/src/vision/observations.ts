/**
 * Turns raw OCR lines into structured visual observations.
 *
 * This layer is deterministic. The neural part is the OCR engine that
 * produced the lines. Classification rules:
 *
 *   price   the line contains a currency amount (₹, Rs, INR, $, €, £), or
 *           starts with "Price"
 *   button  the line's text matches the accessible text of a live DOM button;
 *           the observation then carries that button's data-ps-id as target
 *   text    everything else
 *
 * Lines below the confidence threshold are dropped. Observations never carry
 * coordinates that could be clicked: a button observation is only useful
 * through its DOM target, which the action validator checks like any other.
 */

import type { VisualObservation } from "../shared/contract";
import type { ButtonCandidate, OcrLine, OcrResult } from "./types";

export const DEFAULT_MIN_CONFIDENCE = 0.55;

const CURRENCY_AMOUNT = /(?:₹|rs\.?|inr|\$|€|£)\s?\d[\d,]*(?:\.\d+)?/i;
const PRICE_LABEL = /^price\b/i;
/** OCR often misreads the rupee sign; a "Price:" label followed by digits still counts. */
const PRICE_LABEL_WITH_DIGITS = /^price\s*[:\-]?\s*\S{0,2}\s?\d{2,}/i;

export function buildObservations(
  ocr: OcrResult | null,
  buttons: ButtonCandidate[],
  minConfidence = DEFAULT_MIN_CONFIDENCE,
): VisualObservation[] {
  if (!ocr) return [];
  const observations: VisualObservation[] = [];

  for (const line of ocr.lines) {
    if (line.confidence < minConfidence) continue;
    const text = line.text.trim();
    if (!text) continue;

    const button = matchButton(text, buttons);
    if (button) {
      observations.push({ type: "button", text, bbox: line.bbox, confidence: round(line.confidence), target: button.id });
      continue;
    }
    if (isPrice(text)) {
      observations.push({ type: "price", text, bbox: line.bbox, confidence: round(line.confidence), target: null });
      continue;
    }
    observations.push({ type: "text", text, bbox: line.bbox, confidence: round(line.confidence), target: null });
  }
  return observations;
}

export function isPrice(text: string): boolean {
  return CURRENCY_AMOUNT.test(text) || PRICE_LABEL_WITH_DIGITS.test(text) || (PRICE_LABEL.test(text) && /\d{2,}/.test(text));
}

/**
 * Matches an OCR line to a DOM button by normalized accessible text. Exact
 * match first, then a space-insensitive match (OCR sometimes drops a space,
 * "Buy NowA"), then containment for short labels.
 */
export function matchButton(text: string, buttons: ButtonCandidate[]): ButtonCandidate | null {
  const needle = normalize(text);
  if (!needle) return null;
  for (const button of buttons) {
    const label = normalize(button.text);
    if (label && label === needle) return button;
  }
  const compactNeedle = needle.replace(/ /g, "");
  for (const button of buttons) {
    const label = normalize(button.text).replace(/ /g, "");
    if (label.length >= 5 && label === compactNeedle) return button;
  }
  for (const button of buttons) {
    const label = normalize(button.text);
    if (label.length >= 5 && (needle === label || needle.startsWith(label) || needle.endsWith(label))) return button;
  }
  return null;
}

/** Extracts the numeric amount from a price line, or null. */
export function priceAmount(text: string): number | null {
  const match = text.match(/(\d[\d,]*)(?:\.\d+)?\s*$/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function linesAbove(lines: OcrLine[], line: OcrLine, maxDistance: number): OcrLine[] {
  return lines
    .filter((other) => other !== line && other.bbox.y < line.bbox.y && line.bbox.y - (other.bbox.y + other.bbox.height) <= maxDistance)
    .sort((a, b) => b.bbox.y - a.bbox.y);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
