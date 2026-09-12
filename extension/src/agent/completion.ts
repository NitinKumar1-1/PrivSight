/**
 * Completion verification, independent of the model.
 *
 * The reasoner may CLAIM a task is done. This module decides, from local
 * evidence only, whether the requested end state is actually present:
 *
 *   MODEL CLAIM      "the task is complete"            (untrusted)
 *   LOCAL EVIDENCE   the page and the executed actions (trusted)
 *
 * Evidence comes from two places, both already local and sanitized:
 *   - the action history: what was executed, with the effect the executor
 *     observed after each action and, for cart controls, the cart evidence
 *     it measured (count change, confirmation, "go to cart" appearing)
 *   - page facts read from the sanitized observation bodies of each round:
 *     url, title, control labels and page text (the same bytes the cloud
 *     saw; nothing raw is kept)
 *
 * The task's goal kind is recognised from its wording in a generic way
 * (search / cart / purchase / open / other); no site, product or selector is
 * named here. For each goal kind the verdict is one of:
 *
 *   verified       objective evidence of the end state is present
 *   unverified     actions ran but the page offers no signal either way
 *   not_complete   evidence says the goal was NOT reached (typed but never
 *                  submitted, nothing added, no action at all)
 *
 * Pure: no DOM, no chrome.*, no network.
 */

import type { ActionRecord } from "../shared/contract";
import { requestedQuantityOf } from "./task-facts";

export type GoalKind = "search" | "cart" | "purchase" | "open" | "other";

/** Value-free facts about one observation, read from the sanitized request body. */
export interface PageFacts {
  url: string;
  title: string;
  /** Lower-cased control labels. */
  labels: string[];
  /** Lower-cased page text, capped. */
  text: string;
}

export interface CompletionVerdict {
  state: "verified" | "unverified" | "not_complete";
  goal: GoalKind;
  /** Short, value-free descriptions of the evidence found. */
  evidence: string[];
  /** What is missing when the state is not verified; value-free. */
  missing: string;
}

const MAX_TEXT = 20_000;
const CART = "(?:cart|bag|basket|trolley)";
export const CART_ADD = new RegExp(`\\badd(?:ed|ing)?\\b[^.]{0,60}?\\bto (?:the |my |your )?${CART}\\b`, "i");
const CART_COUNT_PATTERNS = [
  new RegExp(`(\\d+)\\s*(?:items?|products?)?\\s*(?:in|added to)\\s+(?:your |the |my )?${CART}\\b`, "i"),
  new RegExp(`\\b${CART}\\b\\D{0,3}(\\d+)\\b`, "i"),
  new RegExp(`\\b(\\d+)\\s*\\b${CART}\\b`, "i"),
];
export const GO_TO_CART = new RegExp(`^(?:go to|view|open|see|proceed to)\\s+(?:your |the |my )?${CART}\\b|^${CART}\\s*\\(\\d+\\)`, "i");
export const CART_CONFIRMATION = new RegExp(`\\badded to (?:your |the |my )?${CART}\\b|\\bitems? added\\b|\\bin your ${CART}\\b|\\bsuccessfully added\\b`, "i");
const PURCHASE_LABEL = /\b(buy( it)? now|buy|purchase|place (your |the )?order|order now|check ?out|proceed to (checkout|pay|payment|buy))\b/i;
const CHECKOUT_STATE = /checkout|payment|\bpay\b|order|purchase|\bbuy\b|address|shipping/i;
const SEARCH_CONTROL = /\b(search|go|find|submit|lookup|look up)\b|^🔍$|magnif/i;
const QUERY_PARAMS = ["q", "query", "search", "k", "s", "keyword", "keywords", "term", "text", "searchterm", "search_query", "field-keywords"];
const RESULTS_TEXT = /\bresults?\b|\bshowing\b|\bfound\b/i;
const STOPWORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "open", "page", "site", "website", "then", "please", "into", "onto", "about", "search", "find", "look", "show", "article", "click", "under", "over", "cheapest", "best"]);

// --- goal recognition ------------------------------------------------------------

/** Sentences that negate what they mention ("Do not buy anything") never set the goal. */
const NEGATED = /\b(do not|don't|dont|never|without|not|no)\b/i;

export function goalOf(task: string): GoalKind {
  const text = task
    .toLowerCase()
    .split(/[.!?;\n]+/)
    .filter((sentence) => sentence.trim() && !NEGATED.test(sentence))
    .join(". ");
  if (CART_ADD.test(text) || new RegExp(`\\b(?:put|place)\\b[^.]{0,30}\\bin (?:the |my )?${CART}\\b`).test(text)) return "cart";
  if (/\b(buy|purchase|order|checkout|check out|pay for)\b/.test(text)) return "purchase";
  if (/\b(search|find|look for|look up|show me|locate|browse for)\b/.test(text)) return "search";
  if (/\b(open|go to|visit|navigate to|load)\b/.test(text)) return "open";
  return "other";
}

// --- page facts ------------------------------------------------------------------

/** Facts from a firewall-approved body. Never throws; null when the body is not the expected shape. */
export function pageFactsFromBody(body: string): PageFacts | null {
  try {
    const parsed = JSON.parse(body) as { page?: { url?: string; title?: string; elements?: Array<{ text?: string }>; text?: string } };
    const page = parsed.page;
    if (!page) return null;
    return {
      url: (page.url ?? "").toLowerCase(),
      title: (page.title ?? "").toLowerCase(),
      labels: Array.isArray(page.elements) ? page.elements.map((e) => (e.text ?? "").toLowerCase().trim()).filter(Boolean) : [],
      text: (page.text ?? "").toLowerCase().slice(0, MAX_TEXT),
    };
  } catch {
    return null;
  }
}

// --- verification --------------------------------------------------------------------

/**
 * @param task the user's task
 * @param history executed actions, oldest first (with effects and local evidence fields)
 * @param observations page facts per observation, oldest first; the last one is the page on which "done" was claimed
 */
export function verifyCompletion(task: string, history: ActionRecord[], observations: Array<PageFacts | null>): CompletionVerdict {
  const goal = goalOf(task);
  const first = observations.find((o) => o !== null) ?? null;
  const last = [...observations].reverse().find((o) => o !== null) ?? null;
  const actions = history.filter((h) => h.action !== "done");
  switch (goal) {
    case "search":
      return verifySearch(actions, first, last);
    case "cart":
      return verifyCart(actions, observations, requestedQuantityOf(task));
    case "purchase":
      return verifyPurchase(actions, last);
    case "open":
      return verifyOpen(task, actions, last);
    default:
      if (actions.length === 0) return { state: "verified", goal, evidence: ["no browser state change was requested; the answer is in the reasoner's report"], missing: "" };
      return { state: "unverified", goal, evidence: [], missing: "the task names no end state that can be checked on the page" };
  }
}

function verifySearch(actions: ActionRecord[], first: PageFacts | null, last: PageFacts | null): CompletionVerdict {
  const evidence: string[] = [];
  const typedIndex = findLastIndex(actions, (a) => a.action === "type" && a.value !== null);
  const typed = typedIndex >= 0 ? (actions[typedIndex].value ?? "").toLowerCase().trim() : "";
  const afterTyping = typedIndex >= 0 ? actions.slice(typedIndex + 1) : [];
  const submissions = afterTyping.filter((a) => (a.action === "press" || a.action === "click") && a.effect !== "no_change" && a.effect !== "unknown");
  const submitted = submissions.length > 0;
  const navigated = submissions.some((a) => a.effect === "url_changed");
  const viaSearchControl = submissions.some((a) => a.action === "press" || SEARCH_CONTROL.test(a.label ?? ""));
  if (navigated) evidence.push("the typed query was submitted and the browser moved to a results page");
  else if (submitted) evidence.push(viaSearchControl ? "the typed query was submitted through the search control and the page changed" : "a control was used after typing and the page changed");

  if (last) {
    const query = queryFromUrl(last.url);
    if (query && (!typed || query.includes(typed) || typed.includes(query))) evidence.push("the page url carries the search query");
    if (typed && last.title.includes(typed)) evidence.push("the page title names the query");
    if (RESULTS_TEXT.test(last.text) && (!typed || last.text.includes(typed))) evidence.push("the page shows results");
    if (first && last.url !== first.url && /search|results|\?q=|\?k=|query=/.test(last.url)) evidence.push("the url moved to a results page");
  }

  if (typed && !submitted && !evidence.some((e) => /url|title|results/.test(e))) {
    return { state: "not_complete", goal: "search", evidence, missing: "the query was typed but never submitted: no search button was clicked and Enter was not pressed, and the page shows no results" };
  }
  if (evidence.length >= 2 || (evidence.length === 1 && /url|title|results/.test(evidence[0])) || navigated) return { state: "verified", goal: "search", evidence, missing: "" };
  if (actions.length === 0) return { state: "not_complete", goal: "search", evidence, missing: "no search was performed and the page shows no results for it" };
  return { state: "unverified", goal: "search", evidence, missing: "the page shows no results signal that can be checked" };
}

/** The quantity a page currently shows for the item: a quantity control's value or a "qty N"/"N units" text. */
export function shownQuantity(facts: PageFacts): number | null {
  const fromText = /\b(?:qty|quantity)\s*[:=]?\s*(\d{1,6})\b|\b(\d{1,6})\s*(?:units?|pcs|pieces?)\b|[x×]\s*(\d{1,6})\b/i.exec(facts.text);
  if (fromText) return Number(fromText[1] ?? fromText[2] ?? fromText[3]);
  return null;
}

function verifyCart(actions: ActionRecord[], observations: Array<PageFacts | null>, requestedQuantity: number | null = null): CompletionVerdict {
  const evidence: string[] = [];
  const cartClicks = actions.filter((a) => a.action === "click" && a.label !== undefined && CART_ADD.test(a.label));
  if (cartClicks.some((c) => c.cartAdded)) evidence.push("the executor saw the cart change right after the add-to-cart click");

  const facts = observations.filter((o): o is PageFacts => o !== null);
  if (facts.length >= 2) {
    const before = facts[0];
    const after = facts[facts.length - 1];
    const countBefore = cartCount(before);
    const countAfter = cartCount(after);
    if (countBefore !== null && countAfter !== null && countAfter > countBefore) evidence.push("the cart count went up");
    if (!before.labels.some((l) => GO_TO_CART.test(l)) && after.labels.some((l) => GO_TO_CART.test(l))) evidence.push("a go-to-cart control appeared");
    if (!CART_CONFIRMATION.test(before.text) && CART_CONFIRMATION.test(after.text)) evidence.push("an added-to-cart confirmation appeared");
  }

  if (evidence.length > 0 && requestedQuantity !== null) {
    // The user asked for a specific quantity: the page must show that quantity, not merely an add.
    const after = facts[facts.length - 1];
    const shown = after ? shownQuantity(after) : null;
    if (shown === requestedQuantity) {
      evidence.push(`the page shows quantity ${requestedQuantity}`);
      return { state: "verified", goal: "cart", evidence, missing: "" };
    }
    if (shown !== null) return { state: "not_complete", goal: "cart", evidence, missing: `the page shows quantity ${shown}, not the requested ${requestedQuantity}` };
    return { state: "unverified", goal: "cart", evidence, missing: `the item was added but no quantity of ${requestedQuantity} is shown on the page` };
  }
  if (evidence.length > 0) return { state: "verified", goal: "cart", evidence, missing: "" };
  if (cartClicks.length === 0) return { state: "not_complete", goal: "cart", evidence, missing: "no add-to-cart control was used and the cart shows no change" };
  if (cartClicks.every((c) => c.effect === "no_change")) return { state: "not_complete", goal: "cart", evidence, missing: "the add-to-cart click changed nothing on the page" };
  return { state: "unverified", goal: "cart", evidence, missing: "an add-to-cart control was clicked and the page changed, but no cart count, confirmation or go-to-cart control could be found to confirm it" };
}

function verifyPurchase(actions: ActionRecord[], last: PageFacts | null): CompletionVerdict {
  const evidence: string[] = [];
  const purchaseClicks = actions.filter((a) => a.action === "click" && a.label !== undefined && PURCHASE_LABEL.test(a.label) && a.effect !== "no_change");
  if (purchaseClicks.length > 0) evidence.push("a purchase control was clicked and the page changed");
  if (last && (CHECKOUT_STATE.test(last.url) || CHECKOUT_STATE.test(last.title))) evidence.push("the page is a checkout, payment or order page");
  if (last && /order (?:placed|confirmed)|thank you for your (?:order|purchase)/.test(last.text)) evidence.push("the page confirms the order");
  if (evidence.length >= 2) return { state: "verified", goal: "purchase", evidence, missing: "" };
  if (purchaseClicks.length === 0) return { state: "not_complete", goal: "purchase", evidence, missing: "no purchase control was used and the page is not a checkout page" };
  return { state: "unverified", goal: "purchase", evidence, missing: "the purchase flow could not be confirmed from the page" };
}

function verifyOpen(task: string, actions: ActionRecord[], last: PageFacts | null): CompletionVerdict {
  const evidence: string[] = [];
  const moved = actions.some((a) => a.effect === "url_changed" || a.action === "navigate");
  if (moved) evidence.push("the browser moved to a new page");
  if (last) {
    const keywords = task.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    const hit = keywords.find((w) => last.title.includes(w) || last.url.includes(w));
    if (hit) evidence.push("the page title or url names what the task asked to open");
  }
  if (evidence.length >= 2 || (evidence.length === 1 && !moved)) return { state: "verified", goal: "open", evidence, missing: "" };
  if (!moved && actions.length === 0) return { state: "not_complete", goal: "open", evidence, missing: "nothing was opened" };
  return { state: "unverified", goal: "open", evidence, missing: "the opened page could not be matched to the task" };
}

// --- blockers and goals ----------------------------------------------------------------

/** Generic wording a page uses when something cannot proceed. Not site-specific. */
const BLOCKER_PHRASES = [
  "out of stock", "sold out", "currently unavailable", "not available", "unavailable", "no longer available", "no results",
  "no matching", "notify me", "coming soon", "discontinued", "cannot be delivered", "not deliverable", "does not deliver",
  "sign in", "log in", "login", "access denied", "captcha", "verify you are human", "something went wrong", "error",
  "minimum order", "not eligible", "restricted", "temporarily",
];

export interface BlockerAssessment {
  /** The reasoner claimed a blocker. */
  claimed: boolean;
  /** The claimed blocker wording is visible on the current page. */
  supported: boolean;
  phrase: string | null;
}

/**
 * Whether a blocker the reasoner reports is actually shown by the current
 * page. The reason is model output; only phrases that also appear in the
 * page's labels or text count as observed. Value-free: phrases only.
 */
export function assessBlockerClaim(reason: string, facts: PageFacts | null): BlockerAssessment {
  const text = reason.toLowerCase();
  if (!text.trim()) return { claimed: false, supported: false, phrase: null };
  const claimedPhrases = BLOCKER_PHRASES.filter((p) => text.includes(p));
  if (claimedPhrases.length === 0) return { claimed: true, supported: false, phrase: null };
  if (!facts) return { claimed: true, supported: false, phrase: claimedPhrases[0] };
  const haystack = `${facts.text} ${facts.labels.join(" ")} ${facts.title}`;
  const shown = claimedPhrases.find((p) => haystack.includes(p));
  return { claimed: true, supported: shown !== undefined, phrase: shown ?? claimedPhrases[0] };
}

/** The end state a goal kind needs, in words the reasoner is told. */
export function goalEndState(goal: GoalKind): string {
  switch (goal) {
    case "search":
      return "the search is submitted and results are visible";
    case "cart":
      return "the item is in the cart (count up, added confirmation or a go-to-cart control)";
    case "purchase":
      return "the checkout or payment page is reached";
    case "open":
      return "the requested page is open";
    default:
      return "the task's requested outcome is visible on the page";
  }
}

// --- helpers -------------------------------------------------------------------------

/** The cart count shown on the page (from control labels first, then text), or null when none is visible. */
export function cartCount(facts: PageFacts): number | null {
  for (const label of facts.labels) {
    if (!/cart|bag|basket|trolley/i.test(label)) continue;
    for (const pattern of CART_COUNT_PATTERNS) {
      const m = pattern.exec(label);
      if (m) return Number(m[1]);
    }
  }
  for (const pattern of CART_COUNT_PATTERNS) {
    const m = pattern.exec(facts.text);
    if (m && Number(m[1]) < 1000) return Number(m[1]);
  }
  return null;
}

function queryFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    for (const key of QUERY_PARAMS) {
      const value = parsed.searchParams.get(key);
      if (value) return value.toLowerCase().replace(/\+/g, " ").trim();
    }
    if (/\/search\b/.test(parsed.pathname)) return parsed.pathname.split("/").pop()?.replace(/[-_]+/g, " ") || "";
  } catch {
    // not a url
  }
  return null;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}
