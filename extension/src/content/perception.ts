/**
 * Reads the current DOM into a raw PageInfo and hands it to the privacy
 * module. Raw DOM text and field values exist only inside these calls.
 */

import {
  prepareOutgoingRequest,
  sanitizePage,
  type PreparedRequest,
  type SanitizedPage,
} from "../privacy/sanitize";
import type { ActionRecord, PageElement, PageInfo } from "../shared/contract";
import type { OcrResult } from "../vision/types";
import { elementContext } from "./element-context";
import { overlayContext } from "./overlay";
import { rememberTargets } from "./target-resolver";
import {
  PS_ID_ATTRIBUTE,
  ensureElementIds,
  findInteractiveElements,
  getAccessibleText,
  isStyledClickable,
} from "./element-ids";

const MAX_PAGE_TEXT_LENGTH = 30_000;
/** Landmarks that hold site chrome rather than content. Their text goes last so the cap trims it first. */
const CHROME_SELECTOR = "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [role=complementary]";
const MAIN_SELECTOR = "main, [role=main]";
/** Below this, a main landmark is a stub and the whole body is used instead. */
const MIN_MAIN_TEXT = 200;
const MAX_ELEMENT_TEXT_LENGTH = 200;
/** Options of a standard select sent to the reasoner: enough to choose from, capped like everything else. */
const MAX_SELECT_OPTIONS = 30;
const MAX_OPTION_LENGTH = 60;

/** Extracts the page and returns only the sanitized representation. */
export function extractPageInfo(): SanitizedPage {
  const { page, elements } = extractRawPage();
  return sanitizePage(page, elements);
}

/** Extracts the page, fuses local OCR (if any), sanitizes everything with the task, and runs the privacy firewall. */
export function prepareRequest(task: string, ocr: OcrResult | null = null, history: ActionRecord[] = [], guidance?: string): PreparedRequest {
  const { page, elements } = extractRawPage();
  return prepareOutgoingRequest(task, page, elements, ocr, history, guidance);
}

function extractRawPage(): { page: PageInfo; elements: HTMLElement[] } {
  const elements = findInteractiveElements();
  ensureElementIds(elements);

  const labels = elements.map((el) => getAccessibleText(el).slice(0, MAX_ELEMENT_TEXT_LENGTH));
  const counts = new Map<string, number>();
  for (const label of labels) {
    const key = label.toLowerCase().replace(/\s+/g, " ").trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const page: PageInfo = {
    url: window.location.href,
    title: document.title,
    elements: elements.map((el, index) => toPageElement(el, labels[index], (counts.get(labels[index].toLowerCase().replace(/\s+/g, " ").trim()) ?? 0) > 1)),
    text: pageText().slice(0, MAX_PAGE_TEXT_LENGTH),
  };
  // What each control looked like, so the executor can find it again after a re-render.
  rememberTargets(elements, new Map(page.elements.filter((e) => e.context).map((e) => [e.id, e.context as string])));
  return { page, elements };
}

/**
 * Page text with the content first. Real pages open with menus, keyboard
 * shortcut lists and category trees; under a length cap that chrome would
 * push the content the task needs out of the prompt. So: the main landmark's
 * text first when the page has one, then everything else, then the chrome.
 * The full body text is still what a person sees; only the order changes.
 */
function pageText(): string {
  const body = document.body;
  if (!body) return "";
  const main = Array.from(document.querySelectorAll<HTMLElement>(MAIN_SELECTOR)).map(textOf).filter((t) => t.length >= MIN_MAIN_TEXT);
  const chrome = Array.from(document.querySelectorAll<HTMLElement>(CHROME_SELECTOR)).filter((el) => !el.closest(MAIN_SELECTOR)).map(textOf).filter(Boolean);
  const whole = textOf(body);
  if (main.length === 0 && chrome.length === 0) return whole;
  let rest = whole;
  for (const part of [...main, ...chrome]) rest = rest.replace(part, "");
  return [...main, rest.trim(), ...chrome].filter(Boolean).join("\n");
}

function textOf(element: HTMLElement): string {
  // innerText respects layout and hidden elements; textContent is the fallback.
  return (element.innerText || element.textContent || "").trim();
}

/**
 * Context is attached only when the same label occurs on more than one control
 * ("Add to cart" x 48): unique labels need nothing extra, and the wire shape of
 * ordinary pages stays exactly as before.
 */
function toPageElement(element: HTMLElement, text: string, duplicated: boolean): PageElement {
  const page: PageElement = {
    id: element.getAttribute(PS_ID_ATTRIBUTE) ?? "",
    tag: element.tagName.toLowerCase(),
    text,
    role: element.getAttribute("role") ?? implicitRole(element),
  };
  if (duplicated) {
    const context = elementContext(element, text);
    if (context) page.context = context;
  }
  // Controls that belong to an open dialog or full-page overlay are marked, so the
  // reasoner can tell the overlay's controls from the page underneath it.
  const overlay = overlayContext(element);
  if (overlay) page.context = (page.context ? `${page.context} | ${overlay}` : overlay).slice(0, 160);
  if (element.tagName === "SELECT") {
    const options = Array.from((element as HTMLSelectElement).options)
      .filter((o) => !o.disabled)
      .map((o) => o.text.replace(/\s+/g, " ").trim().slice(0, MAX_OPTION_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_SELECT_OPTIONS);
    if (options.length > 0) page.options = options;
  }
  return page;
}

function implicitRole(element: HTMLElement): string {
  switch (element.tagName) {
    case "BUTTON":
      return "button";
    case "A":
      return "link";
    case "SELECT":
      return "combobox";
    case "TEXTAREA":
      return "textbox";
    case "INPUT":
      return inputRole(element as HTMLInputElement);
    default:
      if (element.hasAttribute("contenteditable") && (element.getAttribute("contenteditable") ?? "").toLowerCase() !== "false") return "textbox";
      // A styled clickable is listed only because it behaves as a button.
      return isStyledClickable(element) ? "button" : "";
  }
}

function inputRole(input: HTMLInputElement): string {
  switch (input.type) {
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "submit":
    case "button":
      return "button";
    default:
      return "textbox";
  }
}
