/**
 * Independent leakage verification.
 *
 * Runs on the SERIALIZED request body, the exact bytes that would go on the
 * wire. It does not import the detector or the redactor and does not trust
 * that they ran correctly. Three checks:
 *
 *   structure     the JSON re-parses to exactly the contract shape and every
 *                 placeholder is well-formed
 *   known-values  none of the raw values the redactor holds appear, in any
 *                 obvious variant (case, spacing, digits only)
 *   patterns      no email, Luhn-valid card or mobile number remains
 *
 * Any exception is a block. The verifier fails closed.
 */

import type { KnownValue, LeakageCheck, LeakageResult, PiiType } from "./types";

const PLACEHOLDER_FORMAT = /^\[(EMAIL|PHONE|CARD|CVV|OTP|PASSWORD)_\d+\]$/;
const REQUEST_KEYS = ["task", "page", "placeholders"];
const PAGE_KEYS = ["url", "title", "elements", "text"];
const ELEMENT_KEYS = ["id", "tag", "text", "role"];

const MIN_KNOWN_VALUE_LENGTH = 3;
const MIN_DIGIT_VARIANT_LENGTH = 6;

// Own patterns, kept separate from detectors.ts on purpose.
const EMAIL_LEAK = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;
const CARD_LEAK = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const MOBILE_LEAK = /(?<![\d+])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
const IDENTIFIER_BEFORE = /\b(order|invoice|ref(erence)?|tracking|txn|transaction|receipt|ticket)\b[^\n]{0,20}$/i;
const PHONE_BEFORE = /\b(phone|mobile|tel|call|contact|whatsapp)\b/i;

/** Full verification: structure, known raw values, and patterns. */
export function verifySerializedPayload(body: unknown, known: KnownValue[]): LeakageResult {
  const checks: LeakageCheck[] = [];
  try {
    if (typeof body !== "string" || body.length === 0) {
      return blocked("UNKNOWN", "payload is not a serialized string", checks);
    }

    const structure = checkStructure(body);
    checks.push({ name: "structure", passed: structure === null });
    if (structure) return blocked("UNKNOWN", structure, checks);

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
 * Structure and pattern checks only. Used again immediately before fetch,
 * where the raw values are not available (and must not be).
 */
export function verifyPayloadPatterns(body: unknown): LeakageResult {
  return verifySerializedPayload(body, []);
}

function blocked(type: PiiType | "UNKNOWN", reason: string, checks: LeakageCheck[]): LeakageResult {
  return { safe: false, type, reason, checks };
}

// --- structure --------------------------------------------------------------

function checkStructure(body: string): string | null {
  const data: unknown = JSON.parse(body);
  if (!isPlainObject(data)) return "payload is not an object";
  if (!hasExactKeys(data, REQUEST_KEYS)) return "payload has unexpected fields";
  if (typeof data.task !== "string") return "task is not a string";

  const page = data.page;
  if (!isPlainObject(page) || !hasExactKeys(page, PAGE_KEYS)) return "page has unexpected shape";
  if (typeof page.url !== "string" || typeof page.title !== "string" || typeof page.text !== "string") {
    return "page fields are not strings";
  }
  if (!Array.isArray(page.elements)) return "elements is not a list";
  for (const element of page.elements) {
    if (!isPlainObject(element) || !hasExactKeys(element, ELEMENT_KEYS)) return "element has unexpected shape";
    if (!ELEMENT_KEYS.every((key) => typeof element[key] === "string")) return "element fields are not strings";
  }

  if (!Array.isArray(data.placeholders)) return "placeholders is not a list";
  for (const placeholder of data.placeholders) {
    if (typeof placeholder !== "string" || !PLACEHOLDER_FORMAT.test(placeholder)) {
      return "malformed placeholder name";
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => key in value);
}

// --- known values -----------------------------------------------------------

function findKnownValue(body: string, known: KnownValue[]): PiiType | null {
  const lower = body.toLowerCase();
  const compact = body.replace(/[\s-]/g, "");
  for (const { type, value } of known) {
    const raw = value.trim();
    if (raw.length < MIN_KNOWN_VALUE_LENGTH) continue;
    if (lower.includes(raw.toLowerCase())) return type;

    const digits = raw.replace(/\D/g, "");
    if (digits.length >= MIN_DIGIT_VARIANT_LENGTH && compact.includes(digits)) return type;
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
