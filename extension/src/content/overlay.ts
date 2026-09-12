/**
 * Overlay awareness for the observation.
 *
 * Real pages open dialogs and full-page overlays (a sign-in prompt, a cookie
 * wall, a variant picker) that are not always marked with a dialog role. The
 * reasoner needs two generic facts to handle them: which controls belong to
 * the overlay, and what an unlabelled icon button in it probably is (a close
 * control sits in a dialog's top-right corner on almost every site).
 *
 * Pure DOM geometry and attributes; no site knowledge. The hint text is
 * generic wording, never page content.
 */

const DIALOG_ROLES = new Set(["dialog", "alertdialog"]);
const MAX_ANCESTORS = 15;
/** An absolutely or fixed positioned ancestor covering this share of the viewport is an overlay. */
const MIN_OVERLAY_COVERAGE = 0.4;
const MIN_OVERLAY_Z = 100;
const ICON_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(close|dismiss|cancel|cross|times)\b|[-_](close|dismiss)\b/i, "close"],
  [/\b(back|prev|previous)\b/i, "back"],
  [/\b(next|forward)\b/i, "next"],
  [/\b(menu|hamburger|nav)\b/i, "menu"],
  [/\b(search)\b/i, "search"],
  [/\b(cart|bag|basket)\b/i, "cart"],
  [/\b(filter|sort)\b/i, "filter"],
];

/** The dialog or full-page overlay this element sits in, or null. Cached per extraction by the caller if needed. */
export function overlayAncestor(element: HTMLElement): HTMLElement | null {
  const view = element.ownerDocument.defaultView;
  const width = view?.innerWidth ?? 0;
  const height = view?.innerHeight ?? 0;
  let node: HTMLElement | null = element.parentElement;
  for (let depth = 0; node && depth < MAX_ANCESTORS; depth++, node = node.parentElement) {
    if (node.tagName === "BODY" || node.tagName === "HTML") break;
    const role = node.getAttribute("role");
    if ((role && DIALOG_ROLES.has(role)) || node.getAttribute("aria-modal") === "true" || node.tagName === "DIALOG") return node;
    if (!view) continue;
    const style = view.getComputedStyle(node);
    if (style.position !== "fixed" && style.position !== "absolute") continue;
    const z = Number(style.zIndex);
    const rect = node.getBoundingClientRect();
    const coverage = width && height ? (Math.min(rect.width, width) * Math.min(rect.height, height)) / (width * height) : 0;
    if (coverage >= MIN_OVERLAY_COVERAGE && (Number.isFinite(z) ? z >= MIN_OVERLAY_Z : true)) return node;
  }
  return null;
}

/**
 * A generic label for a control with no accessible name: an <svg><title>, a
 * class/id keyword, or its place inside an overlay. Empty when nothing can be
 * said. Wording is fixed text, so it carries no page content.
 */
export function iconHint(element: HTMLElement): string {
  const svgTitle = element.querySelector("svg title, svg desc")?.textContent?.trim();
  if (svgTitle) return svgTitle;
  const tokens = `${element.className && typeof element.className === "string" ? element.className : ""} ${element.id} ${element.getAttribute("data-testid") ?? ""} ${element.getAttribute("name") ?? ""}`;
  for (const [pattern, word] of ICON_KEYWORDS) if (pattern.test(tokens)) return `(icon: ${word})`;
  const overlay = overlayAncestor(element);
  if (overlay) {
    const box = overlay.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const topRight = rect.left + rect.width / 2 >= box.left + box.width * 0.75 && rect.top + rect.height / 2 <= box.top + box.height * 0.25;
    return topRight ? "(unlabelled icon button, top-right of the dialog: probably close)" : "(unlabelled icon button inside the dialog)";
  }
  return "(unlabelled icon button)";
}

/** Context note for a control inside an overlay, or "". */
export function overlayContext(element: HTMLElement): string {
  return overlayAncestor(element) ? "inside an open dialog/overlay" : "";
}
