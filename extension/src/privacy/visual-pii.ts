/**
 * Visual PII detection over OCR lines.
 *
 * Two signals, both semantic:
 *   1. the text detectors on each line ("OTP: 123456", an email, a Luhn card)
 *   2. LAYOUT PROXIMITY: a short label line ("Card number", "OTP",
 *      "Password", "Verification code") whose value sits in a separate OCR
 *      line, either to its right on the same row (form layouts) or directly
 *      below it (stacked layouts). The value must have the shape the label
 *      demands, so "Ticket | 88451200" or "Quantity | 2" never match and a bare
 *      number without a PII label is never classified.
 *
 * Pure: takes OCR lines, returns typed values with the line they came from.
 */

import { findTextMatches, labelType, valueMatchesShape } from "./detectors";
import type { PiiType } from "./types";
import type { OcrLine } from "../vision/types";

export interface VisualPiiMatch {
  type: PiiType;
  value: string;
  lineIndex: number;
  /** "text" when a detector matched inside the line; "layout" when a nearby label typed it. */
  source: "text" | "layout";
}

const MAX_LABEL_WORDS = 4;
const MAX_LABEL_CHARS = 40;
const MAX_ROW_GAP_PX = 700;
const MAX_STACK_GAP_PX = 70;
const MIN_ROW_OVERLAP = 0.5;
const MIN_COLUMN_OVERLAP = 0.3;

/** All PII values visible in the OCR lines: in-line detections plus layout-labelled values. */
export function detectVisualPii(lines: OcrLine[]): VisualPiiMatch[] {
  const matches: VisualPiiMatch[] = [];
  lines.forEach((line, lineIndex) => {
    for (const m of findTextMatches(line.text)) matches.push({ type: m.type, value: m.value, lineIndex, source: "text" });
  });
  for (const layout of findLayoutLabelledValues(lines)) {
    const duplicate = matches.some((m) => m.lineIndex === layout.lineIndex && m.value === layout.value);
    if (!duplicate) matches.push(layout);
  }
  return matches;
}

/** Values typed by a neighbouring label line (same row to the right, or directly above). */
export function findLayoutLabelledValues(lines: OcrLine[]): VisualPiiMatch[] {
  const labels = lines
    .map((line, index) => ({ line, index, type: labelTypeOfLine(line.text) }))
    .filter((l): l is { line: OcrLine; index: number; type: PiiType } => l.type !== null);
  const claimed = new Set<number>();
  const out: VisualPiiMatch[] = [];

  for (const label of labels) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < lines.length; index++) {
      const candidate = lines[index];
      if (index === label.index || claimed.has(index) || labelTypeOfLine(candidate.text) !== null) continue;
      const distance = neighbourDistance(label.line, candidate);
      if (distance === null) continue;
      if (!valueMatchesShape(label.type, cleanValue(candidate.text))) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      claimed.add(bestIndex);
      out.push({ type: label.type, value: cleanValue(lines[bestIndex].text), lineIndex: bestIndex, source: "layout" });
    }
  }
  return out;
}

/** A short line that is only a PII label (no value inside it). */
function labelTypeOfLine(text: string): PiiType | null {
  const trimmed = text.trim().replace(/[:\-–]+$/, "");
  if (!trimmed || trimmed.length > MAX_LABEL_CHARS || trimmed.split(/\s+/).length > MAX_LABEL_WORDS) return null;
  if (findTextMatches(text).length > 0) return null; // the value is already in this line
  if (/\d{3,}/.test(trimmed)) return null;
  return labelType(trimmed);
}

/** Distance from a label to a candidate value line when they are laid out as a pair, else null. */
function neighbourDistance(label: OcrLine, candidate: OcrLine): number | null {
  const a = label.bbox;
  const b = candidate.bbox;
  // Same row, value to the right.
  const verticalOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (verticalOverlap >= MIN_ROW_OVERLAP * Math.min(a.height, b.height) && b.x >= a.x + a.width) {
    const gap = b.x - (a.x + a.width);
    if (gap <= MAX_ROW_GAP_PX) return gap;
  }
  // Directly below, columns overlapping.
  const horizontalOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  if (horizontalOverlap >= MIN_COLUMN_OVERLAP * Math.min(a.width, b.width) && b.y >= a.y + a.height) {
    const gap = b.y - (a.y + a.height);
    if (gap <= MAX_STACK_GAP_PX) return MAX_ROW_GAP_PX + gap; // rows are preferred over stacks
  }
  return null;
}

function cleanValue(text: string): string {
  return text.trim().replace(/^[\[(|]+|[\])|.,;:]+$/g, "").trim();
}
