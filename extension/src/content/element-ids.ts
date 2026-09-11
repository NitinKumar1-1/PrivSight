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
 */

export const PS_ID_ATTRIBUTE = "data-ps-id";
const ID_PREFIX = "el_";
const MAX_SLUG_LENGTH = 32;

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
].join(",");

export function findInteractiveElements(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)).filter(isVisible);
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

  const input = element as HTMLInputElement;
  if (element.tagName === "INPUT" && (input.value || input.placeholder)) {
    return (input.value || input.placeholder).trim();
  }

  return (element.innerText || element.textContent || "").trim();
}

function deriveBaseId(element: HTMLElement): string {
  if (element.id) return ID_PREFIX + slugify(element.id);

  // Form fields never contribute their value to the ID: a filled email or
  // card field would otherwise leak its contents through the identifier.
  const text = isFormField(element) ? fieldLabel(element) : getAccessibleText(element);
  if (text) return ID_PREFIX + slugify(text);

  return "";
}

function isFormField(element: HTMLElement): boolean {
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
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
