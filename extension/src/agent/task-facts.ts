/**
 * Facts the user's own task states, kept explicit through the whole run.
 *
 * A task can carry a REQUESTED QUANTITY ("add 500 units") and a PRICE TARGET
 * ("around ₹500", "under ₹800", "for ₹499"). These are different fields from
 * anything a page shows (a product price, a stock count, a rating, a discount,
 * a timer), and the reasoner is reminded of them every round. The price policy
 * for approximate wording is deterministic and documented here:
 *
 *   around / about / approximately / near / roughly X   -> within ±20% of X, closest to X wins
 *   under / below / less than / at most / max / within X -> at most X, closest to X wins
 *   over / above / more than / at least / min X          -> at least X, closest to X wins
 *   for / at / of X (no qualifier)                       -> X, else the closest within ±10%
 *
 * Nothing here names a site or a product. Pure.
 */

export type PriceTargetKind = "around" | "max" | "min" | "exact";

export interface PriceTarget {
  kind: PriceTargetKind;
  amount: number;
  currency: string;
}

export interface TaskFacts {
  requestedQuantity: number | null;
  priceTarget: PriceTarget | null;
}

const CURRENCY = "(?:₹|rs\\.?|inr|\\$|€|£|usd|eur|gbp)";
const AMOUNT = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";
const PRICE_WITH_CURRENCY = new RegExp(`(around|about|approximately|approx\\.?|near|roughly|under|below|less than|at most|max(?:imum)?|within|over|above|more than|at least|min(?:imum)?|for|at|of)?\\s*(${CURRENCY})\\s*${AMOUNT}`, "i");
const PRICE_AFTER_AMOUNT = new RegExp(`(around|about|approximately|approx\\.?|near|roughly|under|below|less than|at most|max(?:imum)?|within|over|above|more than|at least|min(?:imum)?|for|at|of)?\\s*${AMOUNT}\\s*(rupees|rs|dollars|euros|pounds)`, "i");
const QUANTITY = /\b(\d{1,6})\s*(?:units?|pieces?|pcs|items?|qty|quantity|copies|packs?|pairs?|bottles?|boxes?)\b|\b(?:quantity|qty)\s*(?:of|to|=|:)?\s*(\d{1,6})\b|\badd\s+(\d{1,6})\s+(?:of\b|to\b)/i;
export const AROUND_TOLERANCE = 0.2;
export const EXACT_TOLERANCE = 0.1;

export function taskFacts(task: string): TaskFacts {
  return { requestedQuantity: requestedQuantityOf(task), priceTarget: priceTargetOf(task) };
}

export function requestedQuantityOf(task: string): number | null {
  const m = QUANTITY.exec(task);
  if (!m) return null;
  const n = Number(m[1] ?? m[2] ?? m[3]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function priceTargetOf(task: string): PriceTarget | null {
  let m = PRICE_WITH_CURRENCY.exec(task);
  let amountText: string | undefined;
  let qualifier: string | undefined;
  let currency = "";
  if (m) {
    qualifier = m[1];
    currency = m[2];
    amountText = m[3];
  } else {
    m = PRICE_AFTER_AMOUNT.exec(task);
    if (!m) return null;
    qualifier = m[1];
    amountText = m[2];
    currency = m[3];
  }
  const amount = Number((amountText ?? "").replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const q = (qualifier ?? "").toLowerCase();
  const kind: PriceTargetKind = /around|about|approx|near|roughly/.test(q) ? "around" : /under|below|less|most|max|within/.test(q) ? "max" : /over|above|more|least|min/.test(q) ? "min" : "exact";
  return { kind, amount, currency: normaliseCurrency(currency) };
}

function normaliseCurrency(text: string): string {
  const t = text.toLowerCase();
  if (t === "₹" || t.startsWith("rs") || t === "inr" || t === "rupees") return "₹";
  if (t === "$" || t === "usd" || t === "dollars") return "$";
  if (t === "€" || t === "eur" || t === "euros") return "€";
  if (t === "£" || t === "gbp" || t === "pounds") return "£";
  return text;
}

/** The policy in words, for the reasoner. Value-free apart from the user's own numbers. */
export function describePriceTarget(target: PriceTarget): string {
  const { kind, amount, currency } = target;
  const lo = Math.round(amount * (1 - AROUND_TOLERANCE));
  const hi = Math.round(amount * (1 + AROUND_TOLERANCE));
  switch (kind) {
    case "around":
      return `price target ${currency}${amount}: only ${currency}${lo}-${currency}${hi} qualifies; pick the closest to ${currency}${amount}, never a cheaper one outside the range.`;
    case "max":
      return `price limit ${currency}${amount}: only products at or below it qualify.`;
    case "min":
      return `price floor ${currency}${amount}: only products at or above it qualify.`;
    default:
      return `price ${currency}${amount}: exactly that, else the closest within ±${Math.round(EXACT_TOLERANCE * 100)}%.`;
  }
}

/** Guidance line reminding the reasoner of the task's numeric facts, or "" when there are none. */
export function taskConstraintsGuidance(task: string): string {
  const facts = taskFacts(task);
  const parts: string[] = [];
  if (facts.priceTarget) parts.push(describePriceTarget(facts.priceTarget));
  if (facts.requestedQuantity !== null) {
    parts.push(`requested quantity ${facts.requestedQuantity}: a QUANTITY, not a price, stock or rating; type it into the quantity field before adding, then check the page shows it.`);
  }
  const selection = selectionRule(task);
  if (selection) parts.push(selection);
  return parts.length ? `TASK CONSTRAINTS: ${parts.join(" ")}` : "";
}

const SUPERLATIVE = /\b(cheapest|lowest[- ]priced|least expensive|most expensive|highest[- ]rated|best[- ]rated|top[- ]rated|newest|latest)\b/i;
const TIE_BREAKER = /\b(tie|tied|if (?:two|several|more than one|both)|same price|equal price|otherwise|prefer|in that case)\b/i;

/**
 * A superlative choice ("the cheapest") with no tie-breaker in the task: an
 * exact tie must be reported, never resolved by an invented preference. When
 * the task does state a tie-breaker, the reasoner is told to apply that one.
 */
export function selectionRule(task: string): string {
  const superlative = SUPERLATIVE.exec(task);
  if (!superlative) return "";
  const word = superlative[1].toLowerCase();
  const noSubstitute = "Never substitute another item if that one cannot satisfy the task; report done with a stop code instead.";
  if (TIE_BREAKER.test(task)) return `selection: pick the ${word}; on an exact tie apply ONLY the tie-breaker the task states. ${noSubstitute}`;
  return `selection: pick the ${word}; if two or more items tie exactly on that attribute, do NOT choose between them: return done with value AMBIGUOUS_TARGET and name them, since the task gives no tie-breaker. ${noSubstitute}`;
}
