/**
 * Independent leakage verification.
 *
 * Runs on the SERIALIZED request body, the exact bytes that would go on the
 * wire. It does not import the detector or the redactor and does not trust
 * that they ran correctly. Four checks:
 *
 *   structure     the JSON re-parses to exactly the contract shape (including
 *                 the optional visual block) and every placeholder is well-formed
 *   image-data    no data:image URLs, base64 image runs, or oversized strings
 *                 that could carry a screenshot or raw OCR dump
 *   known-values  none of the raw values the redactor holds appear, in any
 *                 obvious variant (case, spacing, digits only)
 *   patterns      no email, Luhn-valid card or mobile number remains
 *
 * Any exception is a block. The verifier fails closed.
 */

import type { KnownValue, LeakageCheck, LeakageResult, PiiType } from "./types";

const PLACEHOLDER_FORMAT = /^\[(EMAIL|PHONE|CARD|CVV|OTP|PASSWORD|ADDRESS)_\d+\]$/;
const REQUEST_KEYS = ["task", "page", "placeholders"];
const OPTIONAL_REQUEST_KEYS = ["visual", "history", "guidance"];
const MAX_GUIDANCE = 400;
const HISTORY_KEYS = ["action", "target", "value"];
const OPTIONAL_HISTORY_KEYS = ["effect", "note"];
const HISTORY_ACTIONS = new Set(["click", "type", "press", "scroll", "select", "navigate", "done"]);
const HISTORY_EFFECTS = new Set(["url_changed", "dom_changed", "no_change", "unknown"]);
const MAX_HISTORY_NOTE = 200;
const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_VALUE = 200;
const PAGE_KEYS = ["url", "title", "elements", "text"];
const ELEMENT_KEYS = ["id", "tag", "text", "role"];
const OPTIONAL_ELEMENT_KEYS = ["context", "options"];
const MAX_CONTEXT = 160;
const MAX_OPTIONS = 30;
const MAX_OPTION = 60;
const VISUAL_KEYS = ["engine", "observations", "conflicts"];
const OBSERVATION_KEYS = ["type", "text", "bbox", "confidence", "target"];
const BBOX_KEYS = ["x", "y", "width", "height"];
const OBSERVATION_TYPES = new Set(["text", "price", "button", "input"]);

const MIN_KNOWN_VALUE_LENGTH = 3;
const MIN_DIGIT_VARIANT_LENGTH = 6;
/** Longer than any legitimate observation or element text; a screenshot is far larger. */
const MAX_OBSERVATION_TEXT = 500;
const MAX_STRING_FIELD = 32_000;

// Own patterns, kept separate from detectors.ts on purpose.
const EMAIL_LEAK = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;
const CARD_LEAK = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const MOBILE_LEAK = /(?<![\d+])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
const IDENTIFIER_BEFORE = /\b(order|invoice|ref(erence)?|tracking|txn|transaction|receipt|ticket)\b[^\n]{0,20}$/i;
const PHONE_BEFORE = /\b(phone|mobile|tel|call|contact|whatsapp)\b/i;
const IMAGE_DATA = /data:\s*image\/|base64,|image\/(png|jpe?g|webp)|\\u0089PNG|\bPNG\b.{0,4}IHDR/i;
const BASE64_RUN = /[A-Za-z0-9+/]{400,}={0,2}/;

/** Full verification: structure, image data, known raw values, and patterns. */
export function verifySerializedPayload(body: unknown, known: KnownValue[]): LeakageResult {
  const checks: LeakageCheck[] = [];
  try {
    if (typeof body !== "string" || body.length === 0) {
      return blocked("UNKNOWN", "payload is not a serialized string", checks);
    }

    const structure = checkStructure(body);
    checks.push({ name: "structure", passed: structure === null });
    if (structure) return blocked("UNKNOWN", structure, checks);

    const image = checkImageData(body);
    checks.push({ name: "image-data", passed: image === null });
    if (image) return blocked("UNKNOWN", image, checks);

    const leakedKnown = findKnownValue(body, known);
    checks.push({ name: "known-values", passed: leakedKnown === null });
    if (leakedKnown) return blocked(leakedKnown, `${leakedKnown} leakage detected`, checks);

    const leakedPattern = findPattern(body);
    checks.push({ name: "patterns", passed: leakedPattern === null });
    if (leakedPattern) return blocked(leakedPattern, `${leakedPattern} pattern detected`, checks);

    return { safe: true, checks };
  } catch {
    return blocked("UNKNOWN", "verification error (fail closed)", checks);
  }
}

/**
 * Structure, image and pattern checks only. Used again immediately before
 * fetch, where the raw values are not available (and must not be).
 */
export function verifyPayloadPatterns(body: unknown): LeakageResult {
  return verifySerializedPayload(body, []);
}

export interface LeakMatch {
  type: PiiType;
  value: string;
  index: number;
}

/**
 * Every span of `text` that the pattern check would flag, with the same
 * rules it applies (Luhn for cards, identifier context for phones). The
 * redactor runs this as its last pass so that what leaves the device has
 * already been cleaned of anything this verifier would reject; the verifier
 * still runs independently on the serialized bytes afterwards.
 */
export function findLeakMatches(text: string): LeakMatch[] {
  const matches: LeakMatch[] = [];
  const claimed: Array<[number, number]> = [];
  const take = (type: PiiType, value: string, index: number) => {
    const end = index + value.length;
    if (claimed.some(([s, e]) => index < e && end > s)) return;
    claimed.push([index, end]);
    matches.push({ type, value, index });
  };
  for (const match of text.matchAll(new RegExp(EMAIL_LEAK.source, "gi"))) take("EMAIL", match[0], match.index ?? 0);
  CARD_LEAK.lastIndex = 0;
  for (const match of text.matchAll(CARD_LEAK)) {
    if (luhn(match[0].replace(/\D/g, ""))) take("CARD", match[0], match.index ?? 0);
  }
  MOBILE_LEAK.lastIndex = 0;
  for (const match of text.matchAll(MOBILE_LEAK)) {
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 40), start);
    if (IDENTIFIER_BEFORE.test(before) && !PHONE_BEFORE.test(before)) continue;
    take("PHONE", match[0], start);
  }
  return matches.sort((a, b) => a.index - b.index);
}

function blocked(type: PiiType | "UNKNOWN", reason: string, checks: LeakageCheck[]): LeakageResult {
  return { safe: false, type, reason, checks };
}

// --- structure --------------------------------------------------------------

function checkStructure(body: string): string | null {
  const data: unknown = JSON.parse(body);
  if (!isPlainObject(data)) return "payload is not an object";
  if (!hasKeys(data, REQUEST_KEYS, OPTIONAL_REQUEST_KEYS)) return "payload has unexpected fields";
  if (typeof data.task !== "string") return "task is not a string";

  const page = data.page;
  if (!isPlainObject(page) || !hasKeys(page, PAGE_KEYS)) return "page has unexpected shape";
  if (typeof page.url !== "string" || typeof page.title !== "string" || typeof page.text !== "string") {
    return "page fields are not strings";
  }
  if (!Array.isArray(page.elements)) return "elements is not a list";
  for (const element of page.elements) {
    if (!isPlainObject(element) || !hasKeys(element, ELEMENT_KEYS, OPTIONAL_ELEMENT_KEYS)) return "element has unexpected shape";
    if (!ELEMENT_KEYS.every((key) => typeof element[key] === "string")) return "element fields are not strings";
    if ("context" in element && (typeof element.context !== "string" || element.context.length > MAX_CONTEXT)) return "element context invalid";
    if ("options" in element) {
      if (!Array.isArray(element.options) || element.options.length > MAX_OPTIONS) return "element options invalid";
      if (!element.options.every((o) => typeof o === "string" && o.length <= MAX_OPTION)) return "element options invalid";
    }
  }

  if (!Array.isArray(data.placeholders)) return "placeholders is not a list";
  for (const placeholder of data.placeholders) {
    if (typeof placeholder !== "string" || !PLACEHOLDER_FORMAT.test(placeholder)) {
      return "malformed placeholder name";
    }
  }

  if ("history" in data) {
    const history = checkHistory(data.history);
    if (history) return history;
  }
  if ("guidance" in data && (typeof data.guidance !== "string" || data.guidance.length > MAX_GUIDANCE)) return "guidance invalid";
  if ("visual" in data) return checkVisual(data.visual);
  return null;
}

function checkHistory(history: unknown): string | null {
  if (!Array.isArray(history)) return "history is not a list";
  if (history.length > MAX_HISTORY_ENTRIES) return "history is too long";
  for (const entry of history) {
    if (!isPlainObject(entry) || !hasKeys(entry, HISTORY_KEYS, OPTIONAL_HISTORY_KEYS)) return "history entry has unexpected shape";
    if (typeof entry.action !== "string" || !HISTORY_ACTIONS.has(entry.action)) return "history entry has unknown action";
    if (entry.target !== null && typeof entry.target !== "string") return "history target invalid";
    if (entry.value !== null && (typeof entry.value !== "string" || entry.value.length > MAX_HISTORY_VALUE)) return "history value invalid";
    if ("effect" in entry && (typeof entry.effect !== "string" || !HISTORY_EFFECTS.has(entry.effect))) return "history effect invalid";
    if ("note" in entry && (typeof entry.note !== "string" || entry.note.length > MAX_HISTORY_NOTE)) return "history note invalid";
  }
  return null;
}

function checkVisual(visual: unknown): string | null {
  if (!isPlainObject(visual) || !hasKeys(visual, VISUAL_KEYS)) return "visual block has unexpected shape";
  if (typeof visual.engine !== "string") return "visual engine is not a string";
  if (!Array.isArray(visual.conflicts) || !visual.conflicts.every((c) => typeof c === "string")) {
    return "visual conflicts are not strings";
  }
  if (!Array.isArray(visual.observations)) return "visual observations is not a list";
  for (const observation of visual.observations) {
    if (!isPlainObject(observation) || !hasKeys(observation, OBSERVATION_KEYS)) return "observation has unexpected shape";
    if (typeof observation.type !== "string" || !OBSERVATION_TYPES.has(observation.type)) return "observation has unknown type";
    if (typeof observation.text !== "string") return "observation text is not a string";
    if (observation.text.length > MAX_OBSERVATION_TEXT) return "observation text is too long";
    if (typeof observation.confidence !== "number" || !Number.isFinite(observation.confidence)) return "observation confidence invalid";
    if (observation.target !== null && typeof observation.target !== "string") return "observation target invalid";
    const bbox = observation.bbox;
    if (!isPlainObject(bbox) || !hasKeys(bbox, BBOX_KEYS)) return "observation bbox has unexpected shape";
    if (!BBOX_KEYS.every((key) => typeof bbox[key] === "number" && Number.isFinite(bbox[key]))) return "observation bbox invalid";
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const present = Object.keys(value);
  if (!required.every((key) => key in value)) return false;
  return present.every((key) => required.includes(key) || optional.includes(key));
}

// --- image data -------------------------------------------------------------

function checkImageData(body: string): string | null {
  if (IMAGE_DATA.test(body)) return "image data detected in payload";
  if (BASE64_RUN.test(body)) return "encoded binary data detected in payload";
  const data = JSON.parse(body) as Record<string, unknown>;
  const longest = longestString(data);
  if (longest > MAX_STRING_FIELD) return "oversized field detected in payload";
  return null;
}

function longestString(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return Math.max(0, ...value.map(longestString));
  if (isPlainObject(value)) return Math.max(0, ...Object.values(value).map(longestString));
  return 0;
}

// --- known values -----------------------------------------------------------

function findKnownValue(body: string, known: KnownValue[]): PiiType | null {
  const lower = body.toLowerCase();
  const compact = body.replace(/[\s-]/g, "");
  for (const { type, value } of known) {
    const raw = value.trim();
    if (raw.length < MIN_KNOWN_VALUE_LENGTH) continue;
    const numeric = /^[\d\s-]+$/.test(raw);

    if (numeric) {
      // Digit-bounded: the OTP's digits inside a longer order number are not the OTP.
      const digits = raw.replace(/\D/g, "");
      if (digits.length >= MIN_DIGIT_VARIANT_LENGTH && new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(compact)) return type;
      continue;
    }
    if (lower.includes(raw.toLowerCase())) return type;
  }
  return null;
}

// --- patterns ---------------------------------------------------------------

function findPattern(body: string): PiiType | null {
  if (EMAIL_LEAK.test(body)) return "EMAIL";

  CARD_LEAK.lastIndex = 0;
  for (const match of body.matchAll(CARD_LEAK)) {
    if (luhn(match[0].replace(/\D/g, ""))) return "CARD";
  }

  MOBILE_LEAK.lastIndex = 0;
  for (const match of body.matchAll(MOBILE_LEAK)) {
    const start = match.index ?? 0;
    const before = body.slice(Math.max(0, start - 40), start);
    if (IDENTIFIER_BEFORE.test(before) && !PHONE_BEFORE.test(before)) continue;
    return "PHONE";
  }
  return null;
}

function luhn(digits: string): boolean {
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
