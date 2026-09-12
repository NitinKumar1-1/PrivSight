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
  "street-address": "ADDRESS",
  "address-line1": "ADDRESS",
  "address-line2": "ADDRESS",
};

/**
 * Keyword evidence. Several rules may match one text; each adds to its type.
 * Every keyword is word-bounded: "headphones", "smartphone case",
 * "microphone" and "automobile" are product words, not phone fields, and
 * "cardigan" is not a card. An accessible label that merely names a product
 * must never turn a control into a sensitive field.
 */
const KEYWORD_RULES: ReadonlyArray<readonly [RegExp, PiiType]> = [
  [/\bpassw(?:or)?d\b|\bpasscode\b/i, "PASSWORD"],
  [/\botp\b|\bone[\s_-]?time\b|\bverification code\b/i, "OTP"],
  [/\bcv[vc]2?\b|\bsecurity code\b/i, "CVV"],
  [/\bcard[\s_-]?(?:number|no|num)\b|\bcc[\s_-]?(?:number|num)\b|\bcredit card\b|\bdebit card\b/i, "CARD"],
  [/\be[\s_-]?mail\b/i, "EMAIL"],
  [/\bphone\b|\bmobile\b|\btel\b|\btelephone\b|\bcontact number\b|\bwhatsapp\b/i, "PHONE"],
  [/(?<!e[\s_-]?mail[\s_-])\b(?:street|shipping|billing|delivery|home|postal)?[\s_-]?address\b/i, "ADDRESS"],
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

/** Button-like inputs carry a label, never a user value. */
const BUTTON_INPUT_TYPES = new Set(["submit", "button", "reset", "image", "checkbox", "radio", "file", "range", "color"]);

/**
 * A field that can hold a user's value. Buttons rendered as <input
 * type="submit"> (with a product name in their aria-label) are controls, not
 * fields: their "value" is a caption, and classifying them would register
 * that caption as sensitive.
 */
export function isFormField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName !== "INPUT") return false;
  return !BUTTON_INPUT_TYPES.has((element.getAttribute("type") ?? "text").toLowerCase());
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

/**
 * Semantic context of a form field: its label, name, placeholder and
 * aria-label. Used to redact a field's text with the same context a human
 * sees, so "Order reference: 9876543210" is not treated as a bare phone.
 */
export function fieldContext(element: HTMLElement): string {
  if (!isFormField(element)) return "";
  return [labelText(element), element.getAttribute("name"), element.getAttribute("placeholder"), element.getAttribute("aria-label")]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.replace(/[_-]+/g, " ").trim())
    .join(" ");
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

/**
 * "Label: value" lines, as seen in OCR output and visible page text. The label
 * decides the type (a semantic signal); the value must also have the right
 * shape for numeric types so "OTP: contact support" is not redacted.
 */
const LABELLED_VALUE = /\b(otp|one[\s-]?time (?:code|password)|verification code|passw(?:or)?d|passcode|cvv|cvc|card(?: number| no\.?)?|phone|mobile|e-?mail|(?:shipping |delivery |billing |home |street )?address)\s*[:=]\s*([^\s,;|]+(?:[ \-]\d{3,6}){0,4}|(?:[^\n,;|]{6,120}))/gi;

/** Redaction output; must never be picked up as a value by any detector. */
const PLACEHOLDER_SHAPE = /^\[[A-Z]+_\d+\]$/;

const LABEL_SHAPES: ReadonlyArray<readonly [RegExp, PiiType, RegExp]> = [
  [/^(otp|one|verification)/i, "OTP", /^\d{4,8}$/],
  [/^pass/i, "PASSWORD", /^\S{4,}$/],
  [/^cv/i, "CVV", /^\d{3,4}$/],
  [/^card/i, "CARD", /^(?:\d[ -]?){12,18}\d$/],
  [/^phone|^mobile/i, "PHONE", /^\+?[\d ()-]{8,16}$/],
  [/^e-?mail/i, "EMAIL", /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i],
  [/address$/i, "ADDRESS", /^(?=.*[a-z])(?=.*\d).{6,120}$/i],
];

/** PII type named by a label text ("Card number", "OTP", "Verification code"), or null. */
export function labelType(text: string): PiiType | null {
  const normalized = text.replace(/[_-]+/g, " ");
  for (const [pattern, type] of KEYWORD_RULES) if (pattern.test(normalized)) return type;
  return null;
}

/** Whether a value has the shape a PII label of this type demands. A password must contain a digit or symbol. */
export function valueMatchesShape(type: PiiType, value: string): boolean {
  const shapes: Record<PiiType, RegExp> = {
    OTP: /^\d{4,8}$/,
    CVV: /^\d{3,4}$/,
    CARD: /^(?:\d[ -]?){12,18}\d$/,
    PHONE: /^\+?[\d ()-]{8,16}$/,
    EMAIL: /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i,
    PASSWORD: /^(?=.*[\d•*#@!$%^&_])\S{4,}$/,
    // A postal address names a place and a number: "42 Park Street, Agra 282010". Label-typed only.
    ADDRESS: /^(?=.*[a-z])(?=.*\d).{6,120}$/i,
  };
  return shapes[type].test(value.trim());
}

/** Finds label:value pairs. The value's position is returned so it can be redacted in place. */
export function findLabelledValues(text: string): TextMatch[] {
  const matches: TextMatch[] = [];
  LABELLED_VALUE.lastIndex = 0;
  for (const match of text.matchAll(LABELLED_VALUE)) {
    const label = match[1];
    const value = match[2].replace(/[.,;:]+$/, "");
    if (PLACEHOLDER_SHAPE.test(value)) continue; // already redacted, never a value
    const rule = LABEL_SHAPES.find(([labelPattern]) => labelPattern.test(label));
    if (!rule || !rule[2].test(value)) continue;
    const start = (match.index ?? 0) + match[0].lastIndexOf(value);
    matches.push({ type: rule[1], value, index: start });
  }
  return matches;
}

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

  // Semantic label:value pairs first, so "OTP: 123456" is typed by its label.
  for (const labelled of findLabelledValues(text)) {
    const end = labelled.index + labelled.value.length;
    if (overlaps(claimed, labelled.index, end)) continue;
    claimed.push([labelled.index, end]);
    matches.push(labelled);
  }

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
