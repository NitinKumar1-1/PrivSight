/**
 * Volatile text: parts of a control's label that change on their own while
 * the control stays the same control. A product card that shows a countdown
 * ("01h 55m 48s"), a "12 more" badge or a relative time re-reads differently
 * every few seconds without the card changing identity. Target identity and
 * element ids are built from the label with these parts removed, so a timer
 * tick never turns a live control into a "changed" one.
 *
 * Generic wording only; no site knowledge.
 */

const VOLATILE_PATTERNS: RegExp[] = [
  /\b\d{1,2}\s*h(?:rs?|ours?)?\s*\d{1,2}\s*m(?:in|ins)?(?:\s*\d{1,2}\s*s(?:ec|ecs)?)?\b/gi, // 01h 55m 48s, 2h 5m
  /\b\d{1,2}\s*[hms]\b/gi, // 48s, 55m, 01h
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, // 12:34, 12:34:56, 10:42 pm
  /\b\d+\s*(?:more|left|sold|remaining|viewing|views?|likes?|reviews?|ratings?|bought|orders?)\b/gi, // 6 more, 3 left
  /\b(?:\d+\s*)?(?:sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days|week|weeks)\s*(?:ago|left|remaining)\b/gi,
  /\b(?:ends?|ending|expires?|closing)\s+in\b[^,;|]{0,20}/gi,
  /\b\d{1,3}\s*%\s*(?:off|claimed|sold)?\b/gi,
  /\b(?:just now|today|yesterday|tomorrow)\b/gi, // never a bare "now": "Buy now" is a control's name
];

/** The label without its volatile parts, lower-cased, single-spaced. */
export function stripVolatile(text: string): string {
  let out = text.toLowerCase();
  for (const pattern of VOLATILE_PATTERNS) out = out.replace(pattern, " ");
  return out.replace(/\s+/g, " ").trim();
}

const MIN_SIMILARITY = 0.6;

/**
 * Whether two stable names denote the same control: equal, one a prefix of the
 * other (a truncated label), or sharing most of their word tokens. "add to
 * cart" vs "go to cart" shares 2 of 4 tokens (0.5): a different control.
 */
export function sameStableName(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length >= 8 && b.length >= 8 && (a.startsWith(b) || b.startsWith(a))) return true;
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return shared / union >= MIN_SIMILARITY;
}
