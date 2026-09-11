/**
 * Builds the sanitized request that is allowed to leave the device.
 *
 *   raw PageInfo + DOM elements + task
 *     -> hybrid field detection (registers values with the redactor)
 *     -> redaction of task, url, title, element text and page text
 *     -> ReasonRequest
 *     -> Privacy Firewall (serialize + independent leakage verification)
 *     -> approved bytes, or a block
 *
 * The redactor for the most recent run is kept in module scope so the action
 * validator and executor can resolve placeholders and look up sensitive
 * fields locally. Nothing in this module is reachable from outside the
 * content script.
 */

import { PS_ID_ATTRIBUTE } from "../content/element-ids";
import type { PageInfo, ReasonRequest } from "../shared/contract";
import { classifyFieldDetailed, fieldValue } from "./detectors";
import { inspectOutgoingRequest } from "./firewall";
import { Redactor } from "./redactor";
import type { FirewallVerdict, PiiType, PrivacySummary } from "./types";

export interface SanitizedPage {
  page: PageInfo;
  summary: PrivacySummary;
}

export interface PreparedRequest {
  summary: PrivacySummary;
  firewall: FirewallVerdict;
}

let activeRedactor: Redactor | null = null;
let activeSensitiveFields = new Map<string, PiiType>();

/** Sanitizes a page. Kept for callers that only need the page (tests, diagnostics). */
export function sanitizePage(raw: PageInfo, elements: HTMLElement[]): SanitizedPage {
  const redactor = startRun(elements);
  return { page: redactPage(redactor, raw), summary: redactor.summary() };
}

/** Sanitizes page and task, then passes the serialized request through the firewall. */
export function prepareOutgoingRequest(task: string, raw: PageInfo, elements: HTMLElement[]): PreparedRequest {
  const redactor = startRun(elements);
  const request: ReasonRequest = {
    task: redactor.redactText(task),
    page: redactPage(redactor, raw),
    placeholders: redactor.summary().placeholders,
  };
  const firewall = inspectOutgoingRequest(request, redactor.knownValues());
  return { summary: redactor.summary(), firewall };
}

/** Resolves a placeholder from the most recent run. Local only. */
export function resolvePlaceholder(placeholder: string): string | undefined {
  return activeRedactor?.resolve(placeholder);
}

/** PII type of a placeholder from the most recent run, if it exists. */
export function placeholderType(placeholder: string): PiiType | undefined {
  return activeRedactor?.typeOf(placeholder);
}

/** PII type of a sensitive form field (by data-ps-id) from the most recent run. */
export function sensitiveTypeOf(elementId: string): PiiType | undefined {
  return activeSensitiveFields.get(elementId);
}

function startRun(elements: HTMLElement[]): Redactor {
  const redactor = new Redactor();
  activeRedactor = redactor;
  activeSensitiveFields = new Map();
  registerFieldValues(redactor, elements);
  return redactor;
}

function redactPage(redactor: Redactor, raw: PageInfo): PageInfo {
  return {
    url: redactor.redactText(raw.url),
    title: redactor.redactText(raw.title),
    elements: raw.elements.map((element) => ({ ...element, text: redactor.redactText(element.text) })),
    text: redactor.redactText(raw.text),
  };
}

function registerFieldValues(redactor: Redactor, elements: HTMLElement[]): void {
  for (const element of elements) {
    const classification = classifyFieldDetailed(element);
    if (!classification) continue;

    const elementId = element.getAttribute(PS_ID_ATTRIBUTE) ?? "";
    if (elementId) activeSensitiveFields.set(elementId, classification.type);

    const value = fieldValue(element);
    if (!value) continue;
    const placeholder = redactor.placeholderFor(classification.type, value);
    redactor.recordDetection({ type: classification.type, elementId, placeholder, signals: classification.signals });
  }
}
