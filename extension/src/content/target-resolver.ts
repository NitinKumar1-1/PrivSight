/**
 * Website-agnostic target resolution.
 *
 * The reasoner names a target by its data-ps-id. That id is stable while the
 * node lives, but real pages re-render: a framework replaces the button
 * between observation and execution, a list refreshes, an attribute changes.
 * Resolution therefore uses more than the id:
 *
 *   1. ps-id      the node that carries the id, if it is still connected AND
 *                 still reads as the control the reasoner saw (same stable
 *                 name). A node reused for a different control is stale.
 *   2. semantic   otherwise, the control the reasoner saw is looked for again
 *                 among the live interactive elements by its fingerprint:
 *                 stable accessible name (label, aria-label, name, placeholder
 *                 for fields; visible text for controls) plus, when it was
 *                 recorded, the nearby product context. Exactly one match is
 *                 adopted (and tagged with the id); several matches are an
 *                 ambiguity, never a guess; none is a stale target.
 *
 * Fingerprints are recorded at observation time, so the executor resolves
 * against what the reasoner actually saw. Everything here is local; the
 * fingerprint text never leaves the content script.
 */

import { elementContext } from "./element-context";
import { PS_ID_ATTRIBUTE, findElementByPsId, findInteractiveElements, getAccessibleText } from "./element-ids";
import { sameStableName, stripVolatile } from "./volatile";

export interface TargetFingerprint {
  id: string;
  tag: string;
  role: string;
  /** Stable, normalised name of the control. */
  name: string;
  /** Nearby product/container context, when the observation recorded one. */
  context: string;
}

export type ResolutionMethod = "ps-id" | "semantic";

export type Resolution =
  | { ok: true; element: HTMLElement; method: ResolutionMethod; fingerprint: TargetFingerprint | null }
  | { ok: false; code: "unknown_target" | "ambiguous_target"; reason: string };

let registry = new Map<string, TargetFingerprint>();

/** Records what each observed control looked like, so it can be found again after a re-render. */
export function rememberTargets(elements: HTMLElement[], contexts: ReadonlyMap<string, string> = new Map()): void {
  registry = new Map();
  for (const element of elements) {
    const id = element.getAttribute(PS_ID_ATTRIBUTE);
    if (!id) continue;
    registry.set(id, { id, tag: element.tagName.toLowerCase(), role: roleOf(element), name: stableName(element), context: contexts.get(id) ?? "" });
  }
}

export function resetTargetRegistry(): void {
  registry = new Map();
}

export function fingerprintOf(id: string): TargetFingerprint | undefined {
  return registry.get(id);
}

export function resolveTarget(id: string): Resolution {
  const fingerprint = registry.get(id) ?? null;
  const live = findElementByPsId(id);

  if (live && live.isConnected) {
    // The same node, still on the page, reading as the same control (volatile parts such as a
    // countdown ignored) is the target. A node relabelled into a different control is not.
    if (!fingerprint || sameStableName(stableName(live), fingerprint.name)) return { ok: true, element: live, method: "ps-id", fingerprint };
  }

  if (!fingerprint) return { ok: false, code: "unknown_target", reason: "Target element not found on the current page" };

  const matches = findInteractiveElements().filter((candidate) => candidate !== live && matchesFingerprint(candidate, fingerprint));
  if (matches.length === 1) {
    const [match] = matches;
    if (!match.hasAttribute(PS_ID_ATTRIBUTE)) {
      live?.removeAttribute(PS_ID_ATTRIBUTE);
      match.setAttribute(PS_ID_ATTRIBUTE, id);
    }
    return { ok: true, element: match, method: "semantic", fingerprint };
  }
  if (matches.length > 1) {
    return { ok: false, code: "ambiguous_target", reason: `${matches.length} controls on the page now match the target; not guessing between them` };
  }
  return { ok: false, code: "unknown_target", reason: live ? "Target element changed after it was observed" : "Target element is no longer on the page" };
}

function matchesFingerprint(candidate: HTMLElement, fingerprint: TargetFingerprint): boolean {
  if (!fingerprint.name || !sameStableName(stableName(candidate), fingerprint.name)) return false;
  if (roleOf(candidate) !== fingerprint.role && candidate.tagName.toLowerCase() !== fingerprint.tag) return false;
  if (fingerprint.context) {
    const context = elementContext(candidate, getAccessibleText(candidate));
    if (context && context !== fingerprint.context) return false;
  }
  return true;
}

/**
 * A name that does not change when the user (or the agent) types: fields are
 * named by their label attributes, everything else by its accessible text.
 */
export function stableName(element: HTMLElement): string {
  if (isTextField(element)) {
    const label = element.getAttribute("aria-label") || element.getAttribute("name") || element.getAttribute("placeholder") || element.id || element.getAttribute("type") || element.tagName;
    return normalize(label);
  }
  return normalize(getAccessibleText(element));
}

function isTextField(element: HTMLElement): boolean {
  if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
  if (element.tagName === "INPUT") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    return !["submit", "button", "reset", "image", "checkbox", "radio"].includes(type);
  }
  return isContentEditable(element);
}

export function isContentEditable(element: HTMLElement): boolean {
  const value = (element.getAttribute("contenteditable") ?? "").toLowerCase();
  return value === "" && element.hasAttribute("contenteditable") ? true : value === "true" || value === "plaintext-only";
}

function roleOf(element: HTMLElement): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  switch (element.tagName) {
    case "BUTTON":
      return "button";
    case "A":
      return "link";
    case "SELECT":
      return "combobox";
    case "TEXTAREA":
      return "textbox";
    case "INPUT": {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      return ["submit", "button", "reset", "image"].includes(type) ? "button" : type === "checkbox" || type === "radio" ? type : "textbox";
    }
    default:
      return "button"; // styled clickables are listed only because they act as buttons
  }
}

function normalize(text: string): string {
  return stripVolatile(text).slice(0, 120);
}
