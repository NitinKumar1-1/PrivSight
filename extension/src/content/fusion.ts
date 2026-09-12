/**
 * DOM + visual fusion. DOM first.
 *
 * Visual observations (from the local OCR engine) supplement the DOM:
 *   - a visual line whose text already appears in the DOM is dropped
 *     (the DOM already carries it, with structure)
 *   - a visual line the DOM lacks (canvas/image content) is kept
 *   - a visual button label mapped to a live DOM button is kept with its
 *     data-ps-id, so the model can refer to it by ID, never by position
 *   - a visual price that disagrees with the DOM price for the same product
 *     is dropped and recorded as a conflict (DOM wins, the model is told)
 *
 * Pure: takes data in, returns data out. Raw text at this stage; redaction
 * happens next in the privacy module.
 */

import type { PageInfo, VisualObservation } from "../shared/contract";
import { buildObservations, normalize, priceAmount } from "../vision/observations";
import type { ButtonCandidate, OcrLine, OcrResult } from "../vision/types";

export interface FusedObservation {
  observation: VisualObservation;
  /** The OCR line the observation came from (for bounding-box masking). */
  line: OcrLine;
}

export interface FusionResult {
  kept: FusedObservation[];
  conflicts: string[];
  stats: {
    visualLines: number;
    duplicatesDropped: number;
    visualOnly: number;
    buttonsMapped: number;
    conflictsDropped: number;
  };
}

const MAX_NAME_DISTANCE = 90; // px between a price line and the product name above it

export function fuseObservations(page: PageInfo, ocr: OcrResult | null, buttons: ButtonCandidate[]): FusionResult {
  const empty: FusionResult = { kept: [], conflicts: [], stats: { visualLines: 0, duplicatesDropped: 0, visualOnly: 0, buttonsMapped: 0, conflictsDropped: 0 } };
  if (!ocr || ocr.lines.length === 0) return empty;

  const observations = buildObservations(ocr, buttons);
  const lineByObservation = new Map<VisualObservation, OcrLine>();
  observations.forEach((obs) => {
    const line = ocr.lines.find((l) => l.bbox.x === obs.bbox.x && l.bbox.y === obs.bbox.y && l.text.trim() === obs.text);
    if (line) lineByObservation.set(obs, line);
  });

  const domText = normalize([page.text, ...page.elements.map((el) => el.text)].join(" "));
  const domPrices = domProductPrices(page.text);
  const visualPrices = visualProductPrices(observations);

  const kept: FusedObservation[] = [];
  const conflicts: string[] = [];
  const stats = { visualLines: ocr.lines.length, duplicatesDropped: 0, visualOnly: 0, buttonsMapped: 0, conflictsDropped: 0 };

  for (const obs of observations) {
    const line = lineByObservation.get(obs);
    if (!line) continue;

    if (obs.type === "button" && obs.target) {
      kept.push({ observation: obs, line });
      stats.buttonsMapped++;
      continue;
    }

    if (obs.type === "price") {
      const pair = visualPrices.get(obs);
      const domAmount = pair ? domPrices.get(pair.name) : undefined;
      if (pair && domAmount !== undefined) {
        if (domAmount === pair.amount) {
          stats.duplicatesDropped++;
        } else {
          conflicts.push(`${pair.displayName}: page text says ${domAmount}, vision read ${obs.text}`);
          stats.conflictsDropped++;
        }
        continue;
      }
    }

    if (domText.includes(normalize(obs.text))) {
      stats.duplicatesDropped++;
      continue;
    }
    kept.push({ observation: obs, line });
    stats.visualOnly++;
  }

  return { kept, conflicts, stats };
}

/**
 * Name/price pairs from DOM text, keyed by normalized name: a line followed by
 * a price line, where the price line is either "Price: <amount>" (with or
 * without a currency mark) or a bare currency amount ("₹1,299", "Rs 499",
 * "$20"). Used only to detect DOM/vision price conflicts; it never picks a
 * target.
 */
export function domProductPrices(text: string): Map<string, number> {
  const prices = new Map<string, number>();
  const pattern = /([^\n]{3,60}?)\s*\n+\s*(?:price\s*[:\-]?\s*(?:₹|rs\.?|inr|\$|€|£)?|(?:₹|rs\.?|inr|\$|€|£))\s?(\d[\d,]*)/gi;
  for (const match of text.matchAll(pattern)) {
    const name = normalize(match[1]);
    const amount = Number(match[2].replace(/,/g, ""));
    if (name && Number.isFinite(amount)) prices.set(name, amount);
  }
  return prices;
}

interface VisualPricePair {
  name: string;
  displayName: string;
  amount: number;
}

/** Pairs each visual price with the nearest text line above it that overlaps horizontally. */
function visualProductPrices(observations: VisualObservation[]): Map<VisualObservation, VisualPricePair> {
  const pairs = new Map<VisualObservation, VisualPricePair>();
  const texts = observations.filter((o) => o.type === "text");
  for (const price of observations) {
    if (price.type !== "price") continue;
    const amount = priceAmount(price.text);
    if (amount === null) continue;
    const candidates = texts
      .filter((t) => t.bbox.y < price.bbox.y && price.bbox.y - (t.bbox.y + t.bbox.height) <= MAX_NAME_DISTANCE && overlapsX(t.bbox, price.bbox))
      .sort((a, b) => b.bbox.y - a.bbox.y);
    const name = candidates[0];
    if (name) pairs.set(price, { name: normalize(name.text), displayName: name.text, amount });
  }
  return pairs;
}

function overlapsX(a: { x: number; width: number }, b: { x: number; width: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width;
}
