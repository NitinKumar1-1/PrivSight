/**
 * Executes a validated action against the current page and reports what
 * happened afterwards.
 *
 * Implemented: click, type, press (Enter), scroll, navigate (approval only;
 * the service worker performs it) and done. The validator rejects every
 * other action before it gets here.
 *
 * Every element action follows the same evidence-based pipeline:
 *
 *   resolve   the target is resolved again against the live DOM (ps-id, then
 *             semantic fingerprint); a stale or ambiguous target is reported
 *             as such and nothing is touched
 *   check     the element must be connected, visible, enabled and not
 *             covered by another element (an overlay or backdrop)
 *   act       the action itself, with normal browser semantics first
 *   verify    typing is read back from the field; a value that did not take
 *             is a failure, not a success
 *   watch     the page is watched for a bounded time and the effect
 *             (url_changed / dom_changed / no_change) is returned, so the
 *             controller never has to assume an action worked
 *
 * Typing is limited to plain text into non-sensitive fields. The validator
 * only lets a placeholder through into a field of the same PII type; this
 * executor refuses placeholders and password fields outright, so no
 * sensitive value is ever typed on the model's behalf. No model output is
 * ever evaluated as code.
 */

import { CART_ADD } from "../agent/completion";
import type { ActionTrace, ExecuteActionResult } from "../shared/messages";
import { findSelectOption, type ValidatedAction } from "./action-validator";
import { elementContext } from "./element-context";
import { getAccessibleText } from "./element-ids";
import { beginWatch, cartEvidenceBetween, cartSnapshot, watchForChange, type CartEvidence, type CartSnapshot, type PostActionEffect } from "./page-state";
import { isContentEditable, resolveTarget, stableName, type Resolution } from "./target-resolver";

/** Fraction of the viewport height one "up"/"down" scroll moves. */
export const SCROLL_STEP_FRACTION = 0.8;
const PLACEHOLDER_VALUE = /^\[[A-Z]+_\d+\]$/;
/** Longest text the executor will type in one action. */
export const MAX_TYPED_LENGTH = 200;
const CLICK_WATCH_MS = 1500;
const TYPE_WATCH_MS = 600;
const PRESS_WATCH_MS = 1500;
const SCROLL_WATCH_MS = 500;
const NATIVE_CONTROL_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "LABEL"]);

export interface ExecutorOptions {
  /** Resolves a target id against the live DOM. Defaults to the target resolver. */
  resolve?: (id: string) => Resolution;
  /** Whether the pointer-sequence fallback may be used on this element (never for consequential controls). */
  fallbackAllowed?: (element: HTMLElement) => boolean;
  /** Redacts a label before it goes into the developer trace. Defaults to identity. */
  redact?: (text: string) => string;
  /** Upper bound for the post-action watch, for tests. */
  watchMs?: number;
}

export async function executeAction(action: ValidatedAction, options: ExecutorOptions = {}): Promise<ExecuteActionResult> {
  switch (action.action) {
    case "click":
      return clickTarget(action.target, options);
    case "type":
      return typeInto(action.target, action.value, options);
    case "press":
      return pressKey(action.target, action.value, options);
    case "select":
      return selectOption(action.target, action.value, options);
    case "scroll":
      return scrollPage(action.value, options);
    case "navigate":
      // Performed by the service worker (the page unloads); the content script only approves it.
      return { ok: true, message: `Navigation to ${hostOf(action.value)} approved`, validation: "pass", navigateTo: action.value ?? undefined };
    case "done":
      return { ok: true, message: "Task reported as done", validation: "pass" };
    default:
      return { ok: false, message: `Action "${action.action}" is not supported by the executor`, validation: "pass" };
  }
}

// --- click -------------------------------------------------------------------

async function clickTarget(target: string | null | undefined, options: ExecutorOptions): Promise<ExecuteActionResult> {
  if (!target) return { ok: false, message: "Click action has no target", validation: "pass" };
  const resolved = (options.resolve ?? resolveTarget)(target);
  const trace = startTrace("click", target, resolved, options);
  if (!resolved.ok) return stale(resolved, trace);
  const element = resolved.element;

  element.scrollIntoView({ block: "center", inline: "nearest" });
  const problem = clickabilityProblem(element);
  if (problem) {
    trace.validation = "FAIL";
    return { ok: false, message: `Target cannot be clicked: ${problem.reason}`, validation: "blocked", code: problem.code, trace };
  }

  // A control that puts an item in the cart: measure the cart signals around the click.
  const cartControl = CART_ADD.test(getAccessibleText(element));
  const cartBefore = cartControl ? cartSnapshot() : null;
  const watch = beginWatch();
  const before = watch.before;
  element.click();
  let post = await watch.finish({ timeoutMs: options.watchMs ?? CLICK_WATCH_MS });

  // Styled controls (a div acting as a button) sometimes listen only to
  // pointer/mouse events, which element.click() does not produce. When the
  // normal click had no observable effect, the control is still there
  // unchanged, nothing says it handles click itself, and it is not a
  // consequential control, send the sequence a real pointer produces once.
  // Native controls, ARIA buttons/links and elements with a click handler
  // never need this: their click handling is already proven.
  if (post.effect === "no_change" && needsPointerFallback(element) && element.isConnected && (options.fallbackAllowed?.(element) ?? true)) {
    dispatchPointerSequence(element);
    post = await watchForChange(before, { timeoutMs: Math.min(1000, options.watchMs ?? CLICK_WATCH_MS) });
    post.fallbackUsed = true;
  }

  trace.execution = "PASS";
  trace.postAction = post.effect;
  let cartEvidence: CartEvidence | undefined;
  let note: string | undefined;
  if (cartBefore) {
    // The DOM watch already waited; the cart poll shares its bound so a cart click never blocks longer than CART_EVIDENCE_WAIT_MS.
    cartEvidence = await awaitCartEvidence(cartBefore, Math.max(300, (options.watchMs ?? CART_EVIDENCE_WAIT_MS) - post.waitedMs));
    note = describeCart(cartEvidence);
  }
  return { ok: true, message: `Clicked ${target}`, validation: "pass", postAction: post, trace, ...(cartEvidence ? { cartEvidence } : {}), ...(note ? { note } : {}) };
}

/** Cart signals often arrive after the DOM has gone quiet (an async add); poll a bounded window for them. */
const CART_EVIDENCE_WAIT_MS = 3000;
const CART_POLL_MS = 250;

async function awaitCartEvidence(before: CartSnapshot, maxWaitMs: number): Promise<CartEvidence> {
  const deadline = Date.now() + maxWaitMs;
  let evidence = cartEvidenceBetween(before, cartSnapshot());
  while (!evidence.added && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(CART_POLL_MS, Math.max(0, deadline - Date.now()))));
    evidence = cartEvidenceBetween(before, cartSnapshot());
  }
  return evidence;
}

/** Value-free summary of what the cart did after an add-to-cart click, for the history. */
function describeCart(evidence: CartEvidence): string {
  const parts: string[] = [];
  if (evidence.countBefore !== null || evidence.countAfter !== null) parts.push(`cart count ${evidence.countBefore ?? "?"} -> ${evidence.countAfter ?? "?"}`);
  if (evidence.confirmationAppeared) parts.push("added-to-cart confirmation appeared");
  if (evidence.goToCartAppeared) parts.push("a go-to-cart control appeared");
  if (evidence.dialogAppeared) parts.push("a dialog opened (choose options in it, then use its add-to-cart control)");
  if (parts.length === 0) return "no cart change was detected after this click";
  return (evidence.added ? "item is in the cart: " : "") + parts.join("; ");
}

/** A control with no declared click semantics: not a native control, no ARIA control role, no click handler property. */
function needsPointerFallback(element: HTMLElement): boolean {
  if (NATIVE_CONTROL_TAGS.has(element.tagName)) return false;
  const role = (element.getAttribute("role") ?? "").toLowerCase();
  if (role === "button" || role === "link") return false;
  return typeof element.onclick !== "function";
}

export interface ClickabilityProblem {
  code: "target_not_clickable" | "target_occluded";
  reason: string;
}

/**
 * Why the element cannot receive a click right now, or null.
 *
 * Occlusion is tested by hit-testing: the centre point and four interior
 * points are resolved with elementFromPoint (which honours stacking order,
 * z-index and pointer-events). The centre must resolve to the target or one
 * of its descendants/ancestors; if most interior points resolve elsewhere the
 * target is largely covered. The intercepting element is described (dialog,
 * full-page overlay, transparent layer) so the controller can re-observe. A
 * target with pointer-events: none cannot take a click at all. When the
 * environment has no hit-testing (unit tests), nothing can be verified and
 * the check does not block.
 */
export function clickabilityProblem(element: HTMLElement): ClickabilityProblem | null {
  if (!element.isConnected) return { code: "target_not_clickable", reason: "it is no longer on the page" };
  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return { code: "target_not_clickable", reason: "it is disabled" };
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return { code: "target_not_clickable", reason: "it is hidden" };
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { code: "target_not_clickable", reason: "it has no size on screen" };
  if (style.pointerEvents === "none") return { code: "target_occluded", reason: "it does not receive pointer events" };
  if (typeof document.elementFromPoint !== "function") return null;

  const dx = rect.width / 4;
  const dy = rect.height / 4;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const points = [[cx, cy], [cx - dx, cy - dy], [cx + dx, cy - dy], [cx - dx, cy + dy], [cx + dx, cy + dy]]
    .filter(([x, y]) => x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight);
  if (points.length === 0) return null; // off-screen after scrolling: cannot test cover
  const hits = points.map(([x, y]) => document.elementFromPoint(x, y));
  if (hits.every((h) => h === null)) return null; // no hit-testing available: nothing can be verified
  const own = (hit: Element | null) => hit !== null && (hit === element || element.contains(hit) || hit.contains(element));
  if (hits[0] !== null && !own(hits[0])) return { code: "target_occluded", reason: describeInterceptor(hits[0]) };
  const intercepted = hits.filter((h) => h !== null && !own(h));
  if (intercepted.length >= Math.ceil(hits.length / 2)) return { code: "target_occluded", reason: `most of it is under ${describeInterceptor(intercepted[0] as Element)}` };
  return null;
}

function describeInterceptor(hit: Element): string {
  const style = window.getComputedStyle(hit);
  const rect = hit.getBoundingClientRect();
  const transparent = Number(style.opacity) === 0 || ((style.backgroundColor === "transparent" || style.backgroundColor === "rgba(0, 0, 0, 0)") && !(hit.textContent ?? "").trim());
  const dialog = hit.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog') !== null;
  const fullPage = (style.position === "fixed" || style.position === "absolute") && rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8;
  if (dialog) return "a dialog is covering it";
  if (fullPage) return `a full-page overlay${transparent ? " (transparent)" : ""} is covering it`;
  if (transparent) return "a transparent element intercepts clicks over it";
  return "another element is covering it";
}

function dispatchPointerSequence(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const init: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
  element.dispatchEvent(pointerEvent("pointerdown", init));
  element.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
  element.dispatchEvent(pointerEvent("pointerup", init));
  element.dispatchEvent(new MouseEvent("mouseup", init));
  element.dispatchEvent(new MouseEvent("click", init));
}

function pointerEvent(type: string, init: MouseEventInit): Event {
  if (typeof PointerEvent === "function") return new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true });
  return new MouseEvent(type, init);
}

// --- type --------------------------------------------------------------------

async function typeInto(target: string | null | undefined, value: string | null | undefined, options: ExecutorOptions): Promise<ExecuteActionResult> {
  if (!target) return { ok: false, message: "Type action has no target", validation: "pass" };
  if (value === null || value === undefined) return { ok: false, message: "Type action has no value", validation: "pass" };
  if (PLACEHOLDER_VALUE.test(value)) {
    return { ok: false, message: "Typing sensitive values is disabled: placeholders are never resolved by this executor", validation: "pass" };
  }
  const resolved = (options.resolve ?? resolveTarget)(target);
  const trace = startTrace("type", target, resolved, options);
  if (!resolved.ok) return stale(resolved, trace);
  const element = resolved.element;
  const kind = editableKind(element);
  if (!kind) return { ok: false, message: "Target is not an editable text field", validation: "pass", trace };
  if (kind === "input" && (element.getAttribute("type") ?? "").toLowerCase() === "password") {
    return { ok: false, message: "Typing into a password field is disabled", validation: "pass", trace };
  }
  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || (element as HTMLInputElement).readOnly) {
    trace.validation = "FAIL";
    return { ok: false, message: "Target field is disabled or read-only", validation: "blocked", code: "target_not_clickable", trace };
  }
  const covered = clickabilityProblem(element);
  if (covered && covered.code === "target_occluded") {
    trace.validation = "FAIL";
    return { ok: false, message: `Target field cannot be reached: ${covered.reason}`, validation: "blocked", code: covered.code, trace };
  }

  const text = value.slice(0, MAX_TYPED_LENGTH);
  element.scrollIntoView({ block: "center", inline: "nearest" });
  element.focus();
  if (kind !== "contenteditable" && document.activeElement !== element) {
    // A dialog that traps focus would receive what is typed next; fail closed.
    trace.validation = "FAIL";
    return { ok: false, message: "Target field cannot take focus (another element, probably a dialog, holds it)", validation: "blocked", code: "target_occluded", trace };
  }
  const watch = beginWatch();

  writeText(element, kind, text);
  if (readText(element, kind) !== text) {
    // Frameworks that own the field (editors, some search boxes) ignore a set
    // value; inserting through the editing command goes through their input
    // handling instead.
    selectAll(element, kind);
    try {
      document.execCommand("insertText", false, text);
    } catch {
      // not supported: verification below decides
    }
  }
  if (readText(element, kind) !== text) {
    trace.execution = "FAIL";
    return { ok: false, message: "The field did not accept the typed text", validation: "pass", code: "action_failed", trace };
  }

  const post = await watch.finish({ timeoutMs: options.watchMs ?? TYPE_WATCH_MS });
  trace.execution = "PASS";
  trace.postAction = post.effect;
  return { ok: true, message: `Typed ${text.length} character(s) into ${target}`, validation: "pass", postAction: post, note: "typed text verified in the field; nothing submitted yet", trace };
}

type EditableKind = "input" | "textarea" | "contenteditable";

function editableKind(element: HTMLElement): EditableKind | null {
  if (element.tagName === "TEXTAREA") return "textarea";
  if (element.tagName === "INPUT") return "input";
  if (isContentEditable(element)) return "contenteditable";
  return null;
}

function writeText(element: HTMLElement, kind: EditableKind, text: string): void {
  if (kind === "contenteditable") {
    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }
  const field = element as HTMLInputElement | HTMLTextAreaElement;
  setNativeValue(field, text);
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

function readText(element: HTMLElement, kind: EditableKind): string {
  return kind === "contenteditable" ? (element.textContent ?? "") : (element as HTMLInputElement).value;
}

function selectAll(element: HTMLElement, kind: EditableKind): void {
  if (kind === "contenteditable") {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return;
  }
  try {
    (element as HTMLInputElement).select();
  } catch {
    // some input types cannot select; execCommand then appends, and verification catches it
  }
}

/** Sets the value through the prototype setter so framework-bound inputs (React and similar) notice the change. */
function setNativeValue(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(field, text);
  else field.value = text;
}

// --- press -------------------------------------------------------------------

/**
 * Presses Enter in a text field: the way a person submits a search box that
 * has no button. Key events are dispatched on the field; when the page does
 * not handle them itself and the field belongs to a form, the form is
 * submitted the way the browser would. Only "Enter" is supported.
 */
async function pressKey(target: string | null | undefined, value: string | null | undefined, options: ExecutorOptions): Promise<ExecuteActionResult> {
  if (!target) return { ok: false, message: "Press action has no target", validation: "pass" };
  if (value !== "Enter") return { ok: false, message: 'Only the "Enter" key can be pressed', validation: "pass" };
  const resolved = (options.resolve ?? resolveTarget)(target);
  const trace = startTrace("press", target, resolved, options);
  if (!resolved.ok) return stale(resolved, trace);
  const element = resolved.element;
  if (!editableKind(element)) return { ok: false, message: "Enter can only be pressed in a text field", validation: "pass", trace };
  // A key press goes to the page's handlers, not just the field: never press into a field
  // under a dialog, and never press when focus cannot be placed in the field (a modal that
  // traps focus would receive the key instead and submit its own form).
  const covered = clickabilityProblem(element);
  if (covered && covered.code === "target_occluded") {
    trace.validation = "FAIL";
    return { ok: false, message: `Target field cannot be reached: ${covered.reason}`, validation: "blocked", code: covered.code, trace };
  }
  element.scrollIntoView({ block: "center", inline: "nearest" });
  element.focus();
  if (document.activeElement !== element) {
    trace.validation = "FAIL";
    return { ok: false, message: "Target field cannot take focus (another element, probably a dialog, holds it)", validation: "blocked", code: "target_occluded", trace };
  }
  const watch = beginWatch();
  const init: KeyboardEventInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit;
  const handled = !element.dispatchEvent(new KeyboardEvent("keydown", init));
  element.dispatchEvent(new KeyboardEvent("keypress", init));
  const form = (element as HTMLInputElement).form ?? element.closest("form");
  if (!handled && form) submitForm(form);
  element.dispatchEvent(new KeyboardEvent("keyup", init));

  const post = await watch.finish({ timeoutMs: options.watchMs ?? PRESS_WATCH_MS });
  trace.execution = "PASS";
  trace.postAction = post.effect;
  return { ok: true, message: `Pressed Enter in ${target}`, validation: "pass", postAction: post, trace };
}

function submitForm(form: HTMLFormElement): void {
  if (typeof form.requestSubmit === "function") {
    try {
      form.requestSubmit();
      return;
    } catch {
      // environments without requestSubmit fall through to the event
    }
  }
  const event = new Event("submit", { bubbles: true, cancelable: true });
  if (form.dispatchEvent(event) && typeof form.submit === "function") {
    try {
      form.submit();
    } catch {
      // navigation not available (tests)
    }
  }
}

// --- select ------------------------------------------------------------------

/**
 * Chooses an option of a standard <select>. Only native single selects: the
 * option must already exist and be enabled (the validator checks this too),
 * the value is set, input/change events are dispatched for framework-bound
 * controls, and the selection is read back. Custom dropdowns built from divs
 * are not selects and stay fail-closed here.
 */
async function selectOption(target: string | null | undefined, value: string | null | undefined, options: ExecutorOptions): Promise<ExecuteActionResult> {
  if (!target) return { ok: false, message: "Select action has no target", validation: "pass" };
  if (value === null || value === undefined) return { ok: false, message: "Select action has no value", validation: "pass" };
  const resolved = (options.resolve ?? resolveTarget)(target);
  const trace = startTrace("select", target, resolved, options);
  if (!resolved.ok) return stale(resolved, trace);
  const element = resolved.element;
  if (element.tagName !== "SELECT" || (element as HTMLSelectElement).multiple) return { ok: false, message: "Target is not a standard single select", validation: "pass", trace };
  const select = element as HTMLSelectElement;
  if (select.disabled) {
    trace.validation = "FAIL";
    return { ok: false, message: "Target select is disabled", validation: "blocked", code: "target_not_clickable", trace };
  }
  const option = findSelectOption(select, value);
  if (!option) {
    trace.validation = "FAIL";
    return { ok: false, message: "Select value is not one of the control's enabled options", validation: "blocked", code: "invalid_value", trace };
  }

  element.scrollIntoView({ block: "center", inline: "nearest" });
  select.focus();
  const watch = beginWatch();
  select.value = option.value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  if (select.value !== option.value || select.selectedIndex !== option.index) {
    trace.execution = "FAIL";
    return { ok: false, message: "The select did not accept the option", validation: "pass", code: "action_failed", trace };
  }
  const post = await watch.finish({ timeoutMs: options.watchMs ?? TYPE_WATCH_MS });
  trace.execution = "PASS";
  trace.postAction = post.effect;
  return { ok: true, message: `Selected an option in ${target}`, validation: "pass", postAction: post, note: "selected option verified in the control", trace };
}

// --- scroll ------------------------------------------------------------------

async function scrollPage(value: string | null | undefined, options: ExecutorOptions): Promise<ExecuteActionResult> {
  const direction = value ?? "down";
  const step = Math.round(window.innerHeight * SCROLL_STEP_FRACTION);
  const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  const watch = beginWatch();
  switch (direction) {
    case "up":
      window.scrollBy({ top: -step, left: 0 });
      break;
    case "down":
      window.scrollBy({ top: step, left: 0 });
      break;
    case "top":
      window.scrollTo({ top: 0, left: 0 });
      break;
    case "bottom":
      window.scrollTo({ top: pageHeight, left: 0 });
      break;
    default:
      // The validator only lets up/down/top/bottom through; anything else is a programming error.
      return { ok: false, message: `Scroll direction "${direction}" is not supported`, validation: "pass" };
  }
  const post = await watch.finish({ timeoutMs: options.watchMs ?? SCROLL_WATCH_MS });
  const trace: ActionTrace = { action: "scroll", target: direction, resolution: "none", match: "window", validation: "PASS", execution: "PASS", postAction: post.effect };
  return { ok: true, message: `Scrolled ${direction}`, validation: "pass", postAction: post, trace };
}

// --- helpers -----------------------------------------------------------------

function startTrace(action: string, target: string, resolved: Resolution, options: ExecutorOptions): ActionTrace {
  const redact = options.redact ?? ((t: string) => t);
  if (!resolved.ok) return { action, target, resolution: "failed", match: resolved.reason, validation: "FAIL", execution: "SKIPPED", postAction: "unknown" };
  const element = resolved.element;
  const label = redact(getAccessibleText(element) || stableName(element)).slice(0, 60);
  const context = redact(elementContext(element, label)).slice(0, 120);
  return {
    action,
    target: label,
    resolution: resolved.method,
    match: `${element.tagName.toLowerCase()}${element.getAttribute("role") ? `[role=${element.getAttribute("role")}]` : ""} ${target}`,
    validation: "PASS",
    execution: "PENDING",
    postAction: "unknown",
    ...(context ? { context } : {}),
  };
}

function stale(resolved: Extract<Resolution, { ok: false }>, trace: ActionTrace): ExecuteActionResult {
  return { ok: false, message: resolved.reason, validation: "blocked", code: resolved.code, trace };
}

function hostOf(url: string | null | undefined): string {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "the site";
  }
}

export type { PostActionEffect };
