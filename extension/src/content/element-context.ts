/**
 * Local context for generic controls (Phase 7).
 *
 * Shopping and listing pages repeat the same control label many times
 * ("Add to cart" x 48). The reasoner refers to elements by id only, so it
 * cannot tell such buttons apart. This module derives, deterministically
 * and locally, a short context string for a control: the nearest heading or
 * descriptive link text in its enclosing card, plus the first price-like
 * amount found there. Pure DOM inspection; no site-specific selectors.
 *
 * The text goes through the same redactor as everything else before it
 * leaves the content script.
 */

export const MAX_CONTEXT_LENGTH = 120;
/** Controls with labels longer than this are distinctive enough on their own. */
const GENERIC_LABEL_MAX = 30;
const MAX_ANCESTORS = 12;
/** A container bigger than this is a list or the page, not a card (real listing cards run to a few thousand characters). */
const MAX_CONTAINER_TEXT = 6000;
/** Currency words must not be the tail of another word: "users7,238,551" is not a rupee amount. */
const PRICE = /(?:₹|(?<![a-z])rs\.?|(?<![a-z])inr|\$|€|£)\s?\d[\d,]*(?:\.\d+)?/i;
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role=heading]";

/**
 * Context for an element, or "" when it is not needed or cannot be found.
 * The walk stops at the first ancestor that reads like a card: it holds
 * exactly one heading (or, failing that, exactly one descriptive link). An
 * ancestor holding several headings is a list or the page, not a card, and
 * the walk ends there with no context.
 */
export function elementContext(element: HTMLElement, label: string): string {
  if (label.trim().length > GENERIC_LABEL_MAX) return "";
  let node: HTMLElement | null = element.parentElement;
  for (let depth = 0; node && depth < MAX_ANCESTORS; depth++, node = node.parentElement) {
    if (node.tagName === "BODY" || node.tagName === "HTML") break;
    const text = (node.innerText || node.textContent || "").trim();
    if (text.length > MAX_CONTAINER_TEXT) break;
    const title = describe(node, element);
    if (title === null) break; // several titles: a list level, stop
    if (!title) continue;
    const price = text.match(PRICE)?.[0]?.replace(/\s+/g, " ");
    return truncate(price ? `${title} | ${price}` : title);
  }
  return "";
}

/**
 * The card's title: its single heading, else its single descriptive link,
 * excluding the control itself. "" when the container has neither; null when
 * it has more than one candidate (so the caller stops walking up).
 */
function describe(container: HTMLElement, self: HTMLElement): string | null {
  const headings = Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR)).filter((h) => !h.contains(self) && textOf(h));
  if (headings.length > 1) return null;
  if (headings.length === 1) return textOf(headings[0]);
  const links = Array.from(container.querySelectorAll<HTMLElement>("a[href]")).filter((a) => a !== self && !a.contains(self) && textOf(a).length >= 15);
  if (links.length > 1) return null;
  return links.length === 1 ? textOf(links[0]) : "";
}

function textOf(node: HTMLElement): string {
  return (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
}

function truncate(text: string): string {
  return text.length > MAX_CONTEXT_LENGTH ? `${text.slice(0, MAX_CONTEXT_LENGTH - 1)}…` : text;
}
