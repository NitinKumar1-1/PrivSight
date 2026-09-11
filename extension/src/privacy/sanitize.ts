/**
 * Builds the sanitized request that is allowed to leave the device.
 *
 *   raw PageInfo + DOM elements + task (+ local OCR result)
 *     -> hybrid field detection (registers values with the redactor)
 *     -> DOM + visual fusion (DOM first; visual supplements)
 *     -> redaction of task, url, title, element text, page text and every
 *        visual observation, with the same redactor and placeholder numbering
 *     -> bounding-box mask regions for every OCR line that held a value
 *     -> ReasonRequest
 *     -> Privacy Firewall (serialize + independent leakage verification)
 *     -> approved bytes, or a block
 *
 * The redactor for the most recent run is kept in module scope so the action
 * validator and executor can resolve placeholders and look up sensitive
 * fields locally. Nothing in this module is reachable from outside the
 * content script. No image data is ever placed in the request.
 */

import { PS_ID_ATTRIBUTE } from "../content/element-ids";
import { fuseObservations } from "../content/fusion";
import type { PageInfo, ReasonRequest, VisualContext, VisualObservation } from "../shared/contract";
import type { ButtonCandidate, OcrResult } from "../vision/types";
import { classifyFieldDetailed, fieldContext, fieldValue } from "./detectors";
import { inspectOutgoingRequest } from "./firewall";
import { maskRegionsForLine, padRegions, type MaskRegion } from "./masking";
import { Redactor } from "./redactor";
import type { FirewallVerdict, PiiType, PrivacySummary } from "./types";
import { findLayoutLabelledValues } from "./visual-pii";

export interface SanitizedPage {
  page: PageInfo;
  summary: PrivacySummary;
}

/** Value-free description of what visual privacy processing did. */
export interface VisualPrivacySummary {
  ocrLines: number;
  observationsSent: number;
  redactedObservations: number;
  maskRegions: MaskRegion[];
  conflicts: string[];
  fusion: { duplicatesDropped: number; visualOnly: number; buttonsMapped: number; conflictsDropped: number };
}

export interface PreparedRequest {
  summary: PrivacySummary;
  firewall: FirewallVerdict;
  visualPrivacy: VisualPrivacySummary | null;
}

let activeRedactor: Redactor | null = null;
let activeSensitiveFields = new Map<string, PiiType>();

/** Sanitizes a page. Kept for callers that only need the page (tests, diagnostics). */
export function sanitizePage(raw: PageInfo, elements: HTMLElement[]): SanitizedPage {
  const redactor = startRun(elements);
  return { page: redactPage(redactor, raw), summary: redactor.summary() };
}

/**
 * Sanitizes page, task and visual observations, then passes the serialized
 * request through the firewall.
 */
export function prepareOutgoingRequest(
  task: string,
  raw: PageInfo,
  elements: HTMLElement[],
  ocr: OcrResult | null = null,
): PreparedRequest {
  const redactor = startRun(elements);
  const buttons = buttonCandidates(raw);

  // Everything the OCR channel knows must be registered BEFORE the page text
  // is redacted, so a value the DOM channel alone would miss (a form-row OTP
  // typed by its neighbouring label, an OCR-only email) is replaced in the
  // DOM copy too. Registering it afterwards leaves the DOM copy in place and
  // the firewall then blocks the request (fail closed) — the bug this ordering fixes.
  if (ocr) registerOcrValues(redactor, ocr);

  const request: ReasonRequest = {
    task: redactor.redactText(task),
    page: redactPage(redactor, raw, elements),
    placeholders: [],
  };

  let visualPrivacy: VisualPrivacySummary | null = null;
  if (ocr) {
    const { visual, privacy } = sanitizeVisual(redactor, raw, ocr, buttons);
    request.visual = visual;
    visualPrivacy = privacy;
  }

  request.placeholders = redactor.summary().placeholders;
  const firewall = inspectOutgoingRequest(request, redactor.knownValues());
  return { summary: redactor.summary(), firewall, visualPrivacy };
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

function redactPage(redactor: Redactor, raw: PageInfo, elements: HTMLElement[] = []): PageInfo {
  return {
    url: redactor.redactText(raw.url),
    title: redactor.redactText(raw.title),
    elements: raw.elements.map((element, index) => ({
      ...element,
      text: redactWithContext(redactor, element.text, elements[index]),
    })),
    text: redactor.redactText(raw.text),
  };
}

/**
 * Redacts an element's text with its field context in front, so the text
 * detectors see the same label a person sees ("Order reference: 987..."),
 * then strips the context again. Values registered from sensitive fields are
 * already known to the redactor and are replaced regardless of context.
 */
function redactWithContext(redactor: Redactor, text: string, element: HTMLElement | undefined): string {
  const context = element ? fieldContext(element) : "";
  if (!context || !text) return redactor.redactText(text);
  const prefix = `${context}: `;
  const redacted = redactor.redactText(prefix + text);
  return redacted.startsWith(prefix) ? redacted.slice(prefix.length) : redactor.redactText(text);
}

function buttonCandidates(raw: PageInfo): ButtonCandidate[] {
  return raw.elements
    .filter((el) => el.role === "button" || el.role === "link" || el.tag === "button")
    .map((el) => ({ id: el.id, text: el.text }));
}

/** Registers every value the OCR lines reveal: in-line detections and layout-labelled values. */
function registerOcrValues(redactor: Redactor, ocr: OcrResult): void {
  for (const match of findLayoutLabelledValues(ocr.lines)) {
    const placeholder = redactor.placeholderFor(match.type, match.value);
    redactor.recordDetection({ type: match.type, elementId: "", placeholder, signals: ["visual-layout~label"] });
  }
  for (const line of ocr.lines) redactor.redactText(line.text); // registers regex/label matches inside lines
}

/**
 * Fuses OCR lines with the DOM, redacts every kept observation with the shared
 * redactor, and computes mask regions over ALL OCR lines so the local preview
 * covers values the DOM already had too.
 */
function sanitizeVisual(
  redactor: Redactor,
  raw: PageInfo,
  ocr: OcrResult,
  buttons: ButtonCandidate[],
): { visual: VisualContext; privacy: VisualPrivacySummary } {
  const fusion = fuseObservations(raw, ocr, buttons);

  const observations: VisualObservation[] = [];
  let redactedObservations = 0;
  for (const { observation } of fusion.kept) {
    const text = redactor.redactText(observation.text);
    if (text !== observation.text) redactedObservations++;
    observations.push({ ...observation, text });
  }

  const maskRegions: MaskRegion[] = [];
  for (const line of ocr.lines) {
    const sanitized = redactor.redactText(line.text);
    if (sanitized === line.text) continue;
    const rawValues = redactor.knownValues().map((k) => k.value).filter((v) => line.text.includes(v));
    maskRegions.push(...maskRegionsForLine(line, sanitized, rawValues));
  }

  return {
    visual: { engine: ocr.engine, observations, conflicts: fusion.conflicts },
    privacy: {
      ocrLines: ocr.lines.length,
      observationsSent: observations.length,
      redactedObservations,
      maskRegions: padRegions(maskRegions),
      conflicts: fusion.conflicts,
      fusion: {
        duplicatesDropped: fusion.stats.duplicatesDropped,
        visualOnly: fusion.stats.visualOnly,
        buttonsMapped: fusion.stats.buttonsMapped,
        conflictsDropped: fusion.stats.conflictsDropped,
      },
    },
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
