/**
 * Assigns stable PrivSight identifiers (data-ps-id) to interactive elements.
 *
 * ID derivation order:
 *   1. the element's own id attribute            -> el_<id>
 *   2. the element's accessible text             -> el_<slug>
 *   3. a per-page counter as a last resort        -> el_<n>
 *
 * Running this twice on the same page state yields the same IDs because
 * elements that already carry data-ps-id are left untouched.
 *
 * Discovery is general: every visible button, link, field, select and
 * ARIA button/link, in document order. Real pages can expose hundreds of
 * links, so the list is capped; when the cap applies, elements inside the
 * current viewport are kept first (still in document order), then the rest.
 * Subtrees hidden from assistive technology (aria-hidden) are skipped.
 */

import { findTextMatches } from "../privacy/detectors";
import { iconHint } from "./overlay";
import { stripVolatile } from "./volatile";

export const PS_ID_ATTRIBUTE = "data-ps-id";
const ID_PREFIX = "el_";
const MAX_SLUG_LENGTH = 32;
/** Upper bound on elements sent to the reasoner per observation. */
export const MAX_INTERACTIVE_ELEMENTS = 220;

export const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[contenteditable]:not([contenteditable=false])",
].join(",");

export function findInteractiveElements(root: ParentNode = document, limit = MAX_INTERACTIVE_ELEMENTS): HTMLElement[] {
  const native = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)).filter((el) => isVisible(el) && !isAriaHidden(el));
  const styled = findStyledClickables(root);
  const visible = styled.length === 0 ? native : inDocumentOrder([...native, ...styled]);
  return prioritizeViewport(visible, limit);
}

/** Generic containers that sites turn into buttons with a click handler and a pointer cursor. */
const STYLED_CLICKABLE_SELECTOR = "div, span, p, li, td, label, tr, article, [role=row], [role=option], [role=listitem], [role=menuitem], [role=tab], [role=treeitem], [role=gridcell]";
/** Longest text a styled clickable may carry; more is a card or a paragraph, not a control. */
const MAX_STYLED_CLICKABLE_TEXT = 40;
/**
 * A row or list item that is itself the control (a mail row, a search result,
 * a menu entry) legitimately carries a sentence: sender, subject, date. Rows
 * and role-bearing items get a longer allowance so they are not dropped.
 */
const MAX_ROW_CLICKABLE_TEXT = 160;
const ROW_LIKE = "tr, article, [role=row], [role=option], [role=listitem], [role=menuitem], [role=tab], [role=treeitem]";
/** Upper bound on styled clickables per observation, so they never crowd out the native controls. */
export const MAX_STYLED_CLICKABLES = 60;

/**
 * Controls that are not controls in the markup: a <div> or <p> that a script
 * turned into a button ("ADD TO BAG", "Add to cart", a size chip). They carry
 * no tag, role or attribute that says so. Two generic signals are accepted:
 *   - a click handler on the element itself (an onclick attribute, or the
 *     onclick property frameworks set on elements they handle: React does so
 *     for every element with an onClick prop, React Native Web included);
 *   - cursor: pointer in the computed style.
 * A candidate must be short, visible, outside any native control and not
 * contain one, and the outermost such element wins over its children.
 */
export function findStyledClickables(root: ParentNode = document): HTMLElement[] {
  const accepted: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(STYLED_CLICKABLE_SELECTOR)) {
    const rowLike = el.matches(ROW_LIKE);
    if (!rowLike && el.children.length > 3) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text || text.length > (rowLike ? MAX_ROW_CLICKABLE_TEXT : MAX_STYLED_CLICKABLE_TEXT)) continue;
    if (el.closest(INTERACTIVE_SELECTOR)) continue;
    // A row may contain small native controls (a star, a checkbox) and still be the thing to click.
    if (!rowLike && el.querySelector(INTERACTIVE_SELECTOR)) continue;
    if (!isVisible(el) || isAriaHidden(el)) continue;
    if (!hasClickHandler(el) && window.getComputedStyle(el).cursor !== "pointer") continue;
    if (accepted.some((outer) => outer.contains(el))) continue; // keep the outermost
    accepted.push(el);
    if (accepted.length >= MAX_STYLED_CLICKABLES) break;
  }
  return accepted;
}

/** True when the element itself carries a click handler (attribute or property). */
function hasClickHandler(element: HTMLElement): boolean {
  return typeof element.onclick === "function";
}

/** True for an element found only through its pointer cursor (no native control semantics). */
export function isStyledClickable(element: HTMLElement): boolean {
  return !element.matches(INTERACTIVE_SELECTOR) && element.matches(STYLED_CLICKABLE_SELECTOR);
}

function inDocumentOrder(elements: HTMLElement[]): HTMLElement[] {
  return elements.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

/**
 * Keeps document order when the page fits under the cap. Over the cap:
 * elements inside the viewport first, then the remaining buttons, fields and
 * selects (the controls a task usually needs), then the remaining links,
 * each group in document order, up to the cap.
 */
export function prioritizeViewport(elements: HTMLElement[], limit: number): HTMLElement[] {
  if (elements.length <= limit) return elements;
  const inView = elements.filter(isInViewport);
  const rest = elements.filter((el) => !isInViewport(el));
  const controls = rest.filter((el) => !isLink(el));
  const links = rest.filter(isLink);
  return [...inView, ...controls, ...links].slice(0, limit);
}

function isLink(element: HTMLElement): boolean {
  return element.tagName === "A" || element.getAttribute("role") === "link";
}

export function ensureElementIds(elements: HTMLElement[]): void {
  const taken = new Set<string>(
    Array.from(document.querySelectorAll(`[${PS_ID_ATTRIBUTE}]`))
      .map((el) => el.getAttribute(PS_ID_ATTRIBUTE))
      .filter((id): id is string => id !== null),
  );

  let counter = 1;
  for (const element of elements) {
    if (element.hasAttribute(PS_ID_ATTRIBUTE)) continue;

    let candidate = deriveBaseId(element);
    while (!candidate || taken.has(candidate)) {
      candidate = `${ID_PREFIX}${counter++}`;
    }

    element.setAttribute(PS_ID_ATTRIBUTE, candidate);
    taken.add(candidate);
  }
}

export function findElementByPsId(id: string): HTMLElement | null {
  // Compare attribute values directly so the id never needs CSS escaping.
  for (const element of document.querySelectorAll<HTMLElement>(`[${PS_ID_ATTRIBUTE}]`)) {
    if (element.getAttribute(PS_ID_ATTRIBUTE) === id) return element;
  }
  return null;
}

export function getAccessibleText(element: HTMLElement): string {
  const fromAria = element.getAttribute("aria-label");
  if (fromAria) return fromAria.trim();
  const fromLabelledBy = labelledByText(element);
  if (fromLabelledBy) return fromLabelledBy;

  const input = element as HTMLInputElement;
  if (element.tagName === "INPUT" && (input.value || input.placeholder)) {
    return (input.value || input.placeholder).trim();
  }
  if (element.tagName === "SELECT") {
    // The selected option is what a person reads; the full option list travels separately.
    const select = element as HTMLSelectElement;
    const selected = select.options[select.selectedIndex];
    return (selected?.text ?? "").trim();
  }

  const text = (element.innerText || element.textContent || "").trim();
  if (text) return glyphHint(text);
  // Icon-only controls: fall back to a title or an image alt inside the control.
  const title = element.getAttribute("title");
  if (title) return title.trim();
  const img = element.querySelector("img[alt]");
  const alt = (img?.getAttribute("alt") ?? "").trim();
  if (alt) return alt;
  // Button-like inputs drawn by a wrapper: <span class="button"><input type="submit">
  // <span aria-hidden="true">Add to cart</span></span> (Amazon and similar widget
  // kits). The input is the control, its label is a sibling; read the wrapper.
  if (isButtonInput(element)) return wrapperLabel(element);
  // Icon-only buttons and links with no name at all: a generic hint (svg title,
  // class keyword, or place inside an overlay) so the reasoner can still tell a
  // dialog's close control from a carousel arrow.
  if (element.tagName === "BUTTON" || element.tagName === "A" || element.getAttribute("role") === "button") return iconHint(element);
  return "";
}

/** Common single glyphs used as icon labels, with the word a person reads them as. */
const GLYPH_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^[✕✖✗✘×⨯╳❌]$/u, "close"],
  [/^[←⟵◀◁‹«]$/u, "back"],
  [/^[→⟶▶▷›»]$/u, "next"],
  [/^[☰≡]$/u, "menu"],
  [/^[🔍🔎]$/u, "search"],
  [/^[🛒]$/u, "cart"],
  [/^[♡♥❤]$/u, "wishlist"],
];

/** "✕" -> "✕ (icon: close)". Text with letters or digits is returned unchanged. */
function glyphHint(text: string): string {
  if (/[\p{L}\p{N}]/u.test(text)) return text;
  const glyph = text.replace(/\s+/g, "");
  for (const [pattern, word] of GLYPH_WORDS) if (pattern.test(glyph)) return `${text} (icon: ${word})`;
  return text;
}

/** Longest wrapper text accepted as a control's label: longer is a card, not a button. */
const MAX_WRAPPER_LABEL_LENGTH = 60;
const MAX_WRAPPER_DEPTH = 3;

/** Text of the elements an aria-labelledby points at, in order, or "". */
function labelledByText(element: HTMLElement): string {
  const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  if (ids.length === 0) return "";
  const parts = ids
    .map((id) => element.ownerDocument.getElementById(id))
    .filter((node): node is HTMLElement => node !== null && node !== element)
    .map((node) => normalize(node.textContent ?? ""))
    .filter(Boolean);
  return parts.join(" ").trim();
}

function isButtonInput(element: HTMLElement): boolean {
  if (element.tagName !== "INPUT") return false;
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  return type === "submit" || type === "button" || type === "reset" || type === "image";
}

/**
 * The label a small wrapper draws for a text-less button input. Walks a few
 * ancestors and takes the first one with text, provided it is short and holds
 * no other interactive control (otherwise it is a toolbar or a card, and its
 * text would name the wrong thing).
 */
function wrapperLabel(element: HTMLElement): string {
  let node = element.parentElement;
  for (let depth = 0; node && depth < MAX_WRAPPER_DEPTH; depth++, node = node.parentElement) {
    if (node.querySelectorAll(INTERACTIVE_SELECTOR).length > 1) return "";
    const text = normalize(node.textContent ?? "");
    if (text) return text.length <= MAX_WRAPPER_LABEL_LENGTH ? text : "";
  }
  return "";
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function deriveBaseId(element: HTMLElement): string {
  if (element.id) return ID_PREFIX + slugify(element.id);

  // Form fields never contribute their value to the ID: a filled email or
  // card field would otherwise leak its contents through the identifier. A
  // control whose visible text is itself a value (a mailto link showing the
  // address, a "call 98765 43210" link) gets a counter id for the same reason.
  const text = isFormField(element) ? fieldLabel(element) : getAccessibleText(element);
  if (text && findTextMatches(text).length > 0) return "";
  // A symbol-only label ("✕", "→") slugifies to nothing: fall back to a counter id
  // rather than the malformed "el_", which no action could ever target.
  const slug = text ? slugify(stripVolatile(text)) : ""; // volatile parts (a countdown, "6 more") never enter the id
  if (slug) return ID_PREFIX + slug;

  return "";
}

/** Fields that hold user data. A button-like input holds a label, not data, and is named like a button. */
function isFormField(element: HTMLElement): boolean {
  if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
  if (element.tagName === "INPUT") return !isButtonInput(element);
  return element.hasAttribute("contenteditable") && (element.getAttribute("contenteditable") ?? "").toLowerCase() !== "false";
}

function fieldLabel(element: HTMLElement): string {
  return (
    element.getAttribute("name") ||
    element.getAttribute("aria-label") ||
    element.getAttribute("placeholder") ||
    ""
  ).trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isAriaHidden(element: HTMLElement): boolean {
  return element.closest('[aria-hidden="true"]') !== null;
}

function isInViewport(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const height = window.innerHeight || document.documentElement.clientHeight;
  const width = window.innerWidth || document.documentElement.clientWidth;
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
}
