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
import type { PageElement, PageInfo } from "../shared/contract";
import type { OcrResult } from "../vision/types";
import {
  PS_ID_ATTRIBUTE,
  ensureElementIds,
  findInteractiveElements,
  getAccessibleText,
} from "./element-ids";

const MAX_PAGE_TEXT_LENGTH = 20_000;
const MAX_ELEMENT_TEXT_LENGTH = 200;

/** Extracts the page and returns only the sanitized representation. */
export function extractPageInfo(): SanitizedPage {
  const { page, elements } = extractRawPage();
  return sanitizePage(page, elements);
}

/** Extracts the page, fuses local OCR (if any), sanitizes everything with the task, and runs the privacy firewall. */
export function prepareRequest(task: string, ocr: OcrResult | null = null): PreparedRequest {
  const { page, elements } = extractRawPage();
  return prepareOutgoingRequest(task, page, elements, ocr);
}

function extractRawPage(): { page: PageInfo; elements: HTMLElement[] } {
  const elements = findInteractiveElements();
  ensureElementIds(elements);

  const page: PageInfo = {
    url: window.location.href,
    title: document.title,
    elements: elements.map(toPageElement),
    text: pageText().slice(0, MAX_PAGE_TEXT_LENGTH),
  };
  return { page, elements };
}

function pageText(): string {
  const body = document.body;
  if (!body) return "";
  // innerText respects layout and hidden elements; textContent is the fallback.
  return (body.innerText || body.textContent || "").trim();
}

function toPageElement(element: HTMLElement): PageElement {
  return {
    id: element.getAttribute(PS_ID_ATTRIBUTE) ?? "",
    tag: element.tagName.toLowerCase(),
    text: getAccessibleText(element).slice(0, MAX_ELEMENT_TEXT_LENGTH),
    role: element.getAttribute("role") ?? implicitRole(element),
  };
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
      return "";
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
