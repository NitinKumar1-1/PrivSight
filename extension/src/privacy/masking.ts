/**
 * Bounding-box redaction for visual observations.
 *
 * Given the raw OCR line, its words, and the sanitized text the redactor
 * produced, work out which pixel regions held sensitive values. Words whose
 * text is part of a redacted value get their own box; if no word can be
 * matched (OCR split the value oddly) the whole line box is used, so the
 * masking errs on the side of covering too much. Drawing happens elsewhere
 * (offscreen document); this module is pure and testable.
 */

import type { OcrLine } from "../vision/types";
import type { BBox } from "../vision/types";
import type { PiiType } from "./types";

export interface MaskRegion {
  bbox: BBox;
  type: PiiType | "UNKNOWN";
}

const PLACEHOLDER = /\[(EMAIL|PHONE|CARD|CVV|OTP|PASSWORD)_\d+\]/g;

/**
 * Computes mask regions for one OCR line.
 *
 * @param line          raw OCR line with word boxes
 * @param sanitized     the line text after redaction
 * @param rawValues     the raw values that were replaced in this line, in order
 */
export function maskRegionsForLine(line: OcrLine, sanitized: string, rawValues: string[]): MaskRegion[] {
  if (sanitized === line.text) return [];

  const types = Array.from(sanitized.matchAll(PLACEHOLDER)).map((m) => m[1] as PiiType);
  const regions: MaskRegion[] = [];
  const claimedWords = new Set<number>();

  rawValues.forEach((value, index) => {
    const type = types[index] ?? "UNKNOWN";
    const wordBoxes = wordsCovering(line, value, claimedWords);
    regions.push({ bbox: wordBoxes ?? line.bbox, type });
  });

  if (regions.length === 0) regions.push({ bbox: line.bbox, type: types[0] ?? "UNKNOWN" });
  return regions;
}

/** Pads and merges regions so masks fully cover glyph edges. */
export function padRegions(regions: MaskRegion[], padding = 3): MaskRegion[] {
  return regions.map((region) => ({
    type: region.type,
    bbox: {
      x: Math.max(0, region.bbox.x - padding),
      y: Math.max(0, region.bbox.y - padding),
      width: region.bbox.width + padding * 2,
      height: region.bbox.height + padding * 2,
    },
  }));
}

/** Words whose text is part of the value (digits-only compare for numeric values). Returns their union box. */
function wordsCovering(line: OcrLine, value: string, claimed: Set<number>): BBox | null {
  const valueDigits = value.replace(/\D/g, "");
  const numeric = valueDigits.length >= 3 && valueDigits.length === value.replace(/[\s-]/g, "").length;
  const target = numeric ? valueDigits : normalize(value);

  const matched: BBox[] = [];
  line.words.forEach((word, index) => {
    if (claimed.has(index)) return;
    const wordKey = numeric ? word.text.replace(/\D/g, "") : normalize(word.text);
    if (!wordKey) return;
    const hit = numeric ? wordKey.length >= 3 && target.includes(wordKey) : target.includes(wordKey) || wordKey.includes(target);
    if (hit) {
      matched.push(word.bbox);
      claimed.add(index);
    }
  });

  if (matched.length === 0) return null;
  const x = Math.min(...matched.map((b) => b.x));
  const y = Math.min(...matched.map((b) => b.y));
  const right = Math.max(...matched.map((b) => b.x + b.width));
  const bottom = Math.max(...matched.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9@.]+/g, "");
}
