/**
 * Consequential-action policy (Phase 7).
 *
 * A click on a control whose label reads like a purchase, checkout, payment,
 * sign-in, account change, destructive step or form submission is allowed
 * only when the user's own task asks for that category of action in an
 * affirmative sentence. "Do not purchase anything" authorises nothing;
 * "buy the cheapest shirt" authorises the purchase category.
 *
 * This is a deterministic local rule over the user's words and the live
 * control's label. It never consults the model, and the model cannot widen
 * it: the task text comes from the popup, not from the cloud.
 */

export type ConsequentialCategory = "purchase" | "checkout" | "payment" | "account" | "destructive" | "submit";

interface CategoryRule {
  category: ConsequentialCategory;
  /** Words in the user's task that authorise the category. */
  intents: RegExp;
  /** Control labels that belong to the category. */
  labels: RegExp;
}

const RULES: CategoryRule[] = [
  { category: "purchase", intents: /\b(buy|purchase|order it|place (an |the |my )?order)\b/i, labels: /\b(buy( it)? now|buy|purchase|place (your |the )?order|order now|complete (the )?purchase|confirm (the )?order)\b/i },
  { category: "checkout", intents: /\b(check ?out|proceed to (checkout|pay))\b/i, labels: /\b(check ?out|proceed to (checkout|pay|payment|buy))\b/i },
  { category: "payment", intents: /\b(pay|payment|make (a |the )?payment)\b/i, labels: /\b(pay( now)?|make payment|pay with|confirm payment)\b/i },
  { category: "account", intents: /\b(sign ?in|log ?in|log ?on|register|sign ?up|create (an |my )?account)\b/i, labels: /\b(sign ?in|log ?in|log ?on|register|sign ?up|create (an |your )?account|continue with (google|apple|facebook))\b/i },
  { category: "destructive", intents: /\b(delete|remove|cancel|unsubscribe|deactivate|close (my |the )?account)\b/i, labels: /\b(delete|remove|cancel (order|subscription|account)|unsubscribe|deactivate|close account)\b/i },
  { category: "submit", intents: /\b(submit|send|post|apply|confirm)\b/i, labels: /\b(submit|send|post|apply now|confirm)\b/i },
];

/** Sentences that negate whatever they mention. */
const NEGATION = /\b(do not|don't|dont|never|without|not|no)\b/i;

/** Controls that put an item in the cart. Generic e-commerce wording, not a site. */
export const CART_ADD_LABEL = /\b(add(ed)? to (cart|bag|basket|trolley))\b/i;
/**
 * How many times a cart-add control may be clicked in one task: the listing
 * button plus the variant dialog's button is the common two-step pattern. A
 * task that asks for several items lifts the bound.
 */
export const CART_ADD_LIMIT = 2;
const MULTIPLE_ITEMS = /\b([2-9]|[1-9]\d+|two|three|four|five|six|both|multiple|several|each|all|pairs?|sets?|pack of)\b/i;

export function taskAllowsRepeatedCartAdds(task: string): boolean {
  return MULTIPLE_ITEMS.test(task);
}

/** Categories the task authorises: read only from affirmative sentences. */
export function authorizedIntents(task: string): Set<ConsequentialCategory> {
  const allowed = new Set<ConsequentialCategory>();
  for (const sentence of task.split(/[.!?\n;]+/)) {
    const clean = sentence.trim();
    if (!clean || NEGATION.test(clean)) continue;
    for (const rule of RULES) if (rule.intents.test(clean)) allowed.add(rule.category);
  }
  return allowed;
}

/** The category a control label belongs to, or null when it is an ordinary control. */
export function consequentialCategory(label: string): ConsequentialCategory | null {
  const text = label.trim();
  if (!text) return null;
  for (const rule of RULES) if (rule.labels.test(text)) return rule.category;
  return null;
}

/**
 * Reason to block a click on this label under the task's authorisation, or
 * null to allow. `ignore` lists categories not to enforce for this label
 * source (an element id such as "nav-search-submit-button" says "submit"
 * about every search form, so ids never trigger the submit category).
 */
export function consequentialBlockReason(label: string, authorized: Set<ConsequentialCategory>, ignore: ConsequentialCategory[] = []): string | null {
  const category = consequentialCategory(label);
  if (!category || authorized.has(category) || ignore.includes(category)) return null;
  const shown = label.trim().slice(0, 40);
  return `Click on "${shown}" blocked: it is a ${category} action and the task does not ask for one`;
}
