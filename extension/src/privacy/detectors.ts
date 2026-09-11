/**
 * Hybrid local PII detectors.
 *
 * Field classification combines several DOM signals, each with a weight:
 *
 *   STRONG (3)  input type, autocomplete token
 *   MEDIUM (2)  keywords in name, id, class, placeholder, aria-label, <label>
 *   WEAK   (1)  nearby text, the shape of the field's current value
 *
 * A type is reported only when its total reaches THRESHOLD, so a weak signal
 * on its own (a 10-digit order number, a 6-digit invoice code) never turns an
 * ordinary field into PII. Two weak signals that agree, or any medium or
 * strong signal, are enough.
 *
 * Free-text detection uses regular expressions with a Luhn check for cards
 * and a context guard so "Order ID: 9876543210" is not treated as a phone.
 * Over-detection remains the safe failure mode.
 */

import { PII_TYPES, type PiiType } from "./types";

// ---------------------------------------------------------------------------
// Field-based detection
// ---------------------------------------------------------------------------

const STRONG = 3;
const MEDIUM = 2;
const WEAK = 1;
export const THRESHOLD = 2;

const INPUT_TYPE_RULES: Record<string, PiiType> = {
  password: "PASSWORD",
  email: "EMAIL",
  tel: "PHONE",
};

const AUTOCOMPLETE_RULES: Record<string, PiiType> = {
  email: "EMAIL",
  tel: "PHONE",
  "tel-national": "PHONE",
  "cc-number": "CARD",
  "cc-csc": "CVV",
  "one-time-code": "OTP",
  "current-password": "PASSWORD",
  "new-password": "PASSWORD",
};

/** Keyword evidence. Several rules may match one text; each adds to its type. */
const KEYWORD_RULES: ReadonlyArray<readonly [RegExp, PiiType]> = [
  [/passw(or)?d|passcode/i, "PASSWORD"],
  [/\botp\b|one[\s_-]?time|verification code/i, "OTP"],
  [/\bcv[vc]2?\b|security code/i, "CVV"],
  [/card[\s_-]?(number|no|num)|\bcc[\s_-]?(number|num)\b|credit card|debit card/i, "CARD"],
  [/e[\s_-]?mail/i, "EMAIL"],
  [/phone|mobile|\btel\b|contact number/i, "PHONE"],
];

/** Value shapes. Deliberately WEAK: a shape alone never classifies a field. */
const VALUE_SHAPE_RULES: ReadonlyArray<readonly [RegExp, PiiType]> = [
  [/^[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}$/i, "EMAIL"],
  [/^(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/, "PHONE"],
  [/^\d{3,4}$/, "CVV"],
  [/^\d{4,8}$/, "OTP"],
];

const MAX_NEARBY_TEXT = 40;

export interface FieldClassification {
  type: PiiType;
  score: number;
  /** Evidence names only, e.g. "type=password". Never values. */
  signals: string[];
}

export function isFormField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
}

/** Returns the PII type a form field holds, or null. Convenience wrapper. */
export function classifyField(element: HTMLElement): PiiType | null {
  return classifyFieldDetailed(element)?.type ?? null;
}

/** Full hybrid classification with score and safe evidence list. */
export function classifyFieldDetailed(element: HTMLElement): FieldClassification | null {
  if (!isFormField(element)) return null;

  const votes = new Map<PiiType, { score: number; signals: string[]; strong: boolean }>();
  const vote = (type: PiiType, weight: number, signal: string) => {
    const entry = votes.get(type) ?? { score: 0, signals: [], strong: false };
    entry.score += weight;
    entry.signals.push(signal);
    if (weight >= STRONG) entry.strong = true;
    votes.set(type, entry);
  };

  const inputType = element.getAttribute("type")?.toLowerCase() ?? "";
  if (inputType in INPUT_TYPE_RULES) vote(INPUT_TYPE_RULES[inputType], STRONG, `type=${inputType}`);

  const autocomplete = element.getAttribute("autocomplete")?.toLowerCase() ?? "";
  for (const token of autocomplete.split(/\s+/)) {
    if (token in AUTOCOMPLETE_RULES) vote(AUTOCOMPLETE_RULES[token], STRONG, `autocomplete=${token}`);
  }

  for (const attribute of ["name", "id", "class", "placeholder", "aria-label"]) {
    const value = element.getAttribute(attribute);
    if (value) for (const type of keywordTypes(value)) vote(type, MEDIUM, `${attribute}~${type.toLowerCase()}`);
  }

  const label = labelText(element);
  if (label) for (const type of keywordTypes(label)) vote(type, MEDIUM, `label~${type.toLowerCase()}`);

  const nearby = nearbyText(element);
  if (nearby) for (const type of keywordTypes(nearby)) vote(type, WEAK, `nearby~${type.toLowerCase()}`);

  const shape = valueShape(element.value);
  if (shape) vote(shape, WEAK, `value-shape~${shape.toLowerCase()}`);

  return pickWinner(votes);
}

/** Current value of a form field, or "" when there is nothing to protect. */
export function fieldValue(element: HTMLElement): string {
  return isFormField(element) ? element.value.trim() : "";
}

function pickWinner(
  votes: Map<PiiType, { score: number; signals: string[]; strong: boolean }>,
): FieldClassification | null {
  let best: FieldClassification | null = null;
  let bestStrong = false;
  for (const type of PII_TYPES) {
    const entry = votes.get(type);
    if (!entry || entry.score < THRESHOLD) continue;
    const better =
      best === null ||
      entry.score > best.score ||
      (entry.score === best.score && entry.strong && !bestStrong);
    if (better) {
      best = { type, score: entry.score, signals: entry.signals };
      bestStrong = entry.strong;
    }
  }
  return best;
}

function keywordTypes(text: string): PiiType[] {
  const normalized = text.replace(/[_-]+/g, " "); // "card_cvv" reads as "card cvv"
  const types: PiiType[] = [];
  for (const [pattern, type] of KEYWORD_RULES) {
    if (pattern.test(normalized) && !types.includes(type)) types.push(type);
  }
  return types;
}

function valueShape(value: string): PiiType | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (luhnValid(digitsOf(trimmed)) && /^[\d\s-]+$/.test(trimmed)) return "CARD";
  for (const [pattern, type] of VALUE_SHAPE_RULES) {
    if (pattern.test(trimmed)) return type;
  }
  return null;
}

function labelText(element: HTMLInputElement | HTMLTextAreaElement): string {
  const parts: string[] = [];
  for (const label of Array.from(element.labels ?? [])) parts.push(label.textContent ?? "");

  const wrapping = element.closest("label");
  if (wrapping) parts.push(wrapping.textContent ?? "");

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      parts.push(element.ownerDocument.getElementById(id)?.textContent ?? "");
    }
  }
  return parts.join(" ");
}

/** Short text immediately before the field: a preceding sibling or the parent's own text. */
function nearbyText(element: HTMLElement): string {
  const sibling = element.previousElementSibling;
  const siblingText = sibling?.textContent?.trim() ?? "";
  if (siblingText && siblingText.length <= MAX_NEARBY_TEXT) return siblingText;

  const parent = element.parentElement;
  if (!parent) return "";
  const ownText = Array.from(parent.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent?.trim() ?? "")
    .join(" ")
    .trim();
  return ownText.length <= MAX_NEARBY_TEXT ? ownText : "";
}

// ---------------------------------------------------------------------------
// Text-based detection
// ---------------------------------------------------------------------------

export interface TextMatch {
  type: PiiType;
  value: string;
  index: number;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

const CARD_PATTERNS = [
  /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?:[ -]?\d{1,3})?(?!\d)/g, // 4-4-4-4 with optional tail
  /(?<!\d)\d{4}[ -]?\d{6}[ -]?\d{5}(?!\d)/g, // 4-6-5 (Amex style)
  /(?<!\d)\d{13,19}(?!\d)/g, // unformatted
];

const PHONE_PATTERNS = [
  /(?<![\d+])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, // Indian mobile, optional +91 and 5-5 spacing
  /(?<!\d)\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/g, // international with +
  /(?<!\d)\(?\d{3}\)?[\s-]\d{3}[\s-]\d{4}(?!\d)/g, // 555-123-4567
];

/** Words shortly before a digit run that mark it as an identifier, not a phone. */
const IDENTIFIER_CONTEXT = /\b(order|invoice|ref(erence)?|tracking|txn|transaction|receipt|ticket)\b[^\n]{0,20}$/i;
const PHONE_CONTEXT = /\b(phone|mobile|tel|call|contact|whatsapp)\b/i;
const CONTEXT_WINDOW = 40;

/**
 * Finds structured PII in free text. Emails first, then cards, then phones,
 * so a card number is never partially reported as a phone number.
 */
export function findTextMatches(text: string): TextMatch[] {
  const matches: TextMatch[] = [];
  const claimed: Array<[number, number]> = [];

  const collect = (
    pattern: RegExp,
    type: PiiType,
    accept: (value: string, start: number) => boolean = () => true,
  ) => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!accept(match[0], start) || overlaps(claimed, start, end)) continue;
      claimed.push([start, end]);
      matches.push({ type, value: match[0], index: start });
    }
  };

  collect(EMAIL_PATTERN, "EMAIL");
  for (const pattern of CARD_PATTERNS) collect(pattern, "CARD", (v) => luhnValid(digitsOf(v)));
  for (const pattern of PHONE_PATTERNS) {
    collect(pattern, "PHONE", (_v, start) => !looksLikeIdentifier(text, start));
  }

  return matches.sort((a, b) => a.index - b.index);
}

/** True when the text just before `start` names an order/reference number and not a phone. */
export function looksLikeIdentifier(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
  return IDENTIFIER_CONTEXT.test(before) && !PHONE_CONTEXT.test(before);
}

function overlaps(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

export function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
