/**
 * Message handlers for the content script, kept free of chrome.* so they can
 * be unit tested. index.ts wires them to chrome.runtime.onMessage.
 */

import { placeholderType, redactForLog, sensitiveTypeOf } from "../privacy/sanitize";
import type { ExecuteActionResult, ExtractPageResult } from "../shared/messages";
import type { OcrResult } from "../vision/types";
import { EXECUTOR_SUPPORTED_ACTIONS, validateAction, type ValidationContext } from "./action-validator";
import type { ActionRecord } from "../shared/contract";
import { elementContext } from "./element-context";
import { findElementByPsId, getAccessibleText } from "./element-ids";
import { executeAction } from "./executor";
import { visibleImageRegions } from "./image-regions";
import { authorizedIntents, CART_ADD_LABEL, CART_ADD_LIMIT, consequentialBlockReason, consequentialCategory, taskAllowsRepeatedCartAdds, type ConsequentialCategory } from "./intent";
import { navigationBlockReason } from "./navigation";
import { prepareRequest } from "./perception";
import { waitForDomSettle } from "./settle";
import { resolveTarget } from "./target-resolver";

/** Categories of consequential action the current task authorises. Set at extraction, read at execution. */
let taskIntents: Set<ConsequentialCategory> = new Set();
/** The task text, for navigation authorisation. Set at extraction. */
let taskText = "";

/** Waits for the DOM to stop mutating, then extracts, fuses, redacts and runs the firewall. */
export async function handleExtractPage(task: string, ocr: OcrResult | null = null, history: ActionRecord[] = [], guidance?: string): Promise<ExtractPageResult> {
  try {
    taskIntents = authorizedIntents(task);
    taskText = task;
    await waitForDomSettle();
    const { summary, firewall, visualPrivacy } = prepareRequest(task, ocr, history, guidance);
    return { ok: true, summary, firewall, visualPrivacy, imageRegions: visibleImageRegions() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Validates untrusted input from the backend, then executes only if it
 * passed. The validator resolves the target against the live DOM (ps-id,
 * then semantic fingerprint); the executor resolves it again immediately
 * before acting, so a re-render in between is caught, never clicked through.
 */
export async function handleExecuteAction(input: unknown, history: ActionRecord[] = []): Promise<ExecuteActionResult> {
  const result = validateAction(input, liveValidationContext(history));
  if (!result.ok) {
    return { ok: false, message: result.reason, validation: "blocked", code: result.code };
  }
  try {
    return await executeAction(result.action, {
      resolve: resolveTarget,
      // The pointer-sequence fallback re-sends a click; never for a control whose label is consequential.
      fallbackAllowed: (element) => consequentialCategory(getAccessibleText(element)) === null,
      redact: redactForLog,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Execution failed: ${message}`, validation: "pass", code: "action_failed" };
  }
}

function liveValidationContext(history: ActionRecord[]): ValidationContext {
  const cartClicks = history.filter((h) => h.action === "click" && h.label !== undefined && CART_ADD_LABEL.test(h.label));
  const priorCartAdds = cartClicks.length;
  const confirmed = cartClicks.filter((h) => h.cartAdded);
  return {
    findElement: findElementByPsId,
    resolveTarget,
    sensitiveTypeOf,
    placeholderType,
    supportedActions: EXECUTOR_SUPPORTED_ACTIONS,
    isConsequential: (element) => consequentialReason(element) ?? repeatedCartAddReason(element, priorCartAdds, confirmed),
    isNavigationAllowed: (url) => navigationBlockReason(url, taskText, window.location.href),
    typesSensitiveValues: false,
  };
}

/**
 * A click is consequential when its label belongs to a guarded category the
 * task did not authorise, or when it submits a form that holds a sensitive
 * field (password, card, OTP, CVV) and the task did not ask to submit.
 */
function consequentialReason(element: HTMLElement): string | null {
  // What the user can read on the control decides its category. The id/name
  // are a fallback for icon-only controls, but they never trigger the generic
  // "submit" category: every search form's button is a submit by id.
  const visible = [getAccessibleText(element), element.getAttribute("value") ?? "", element.getAttribute("title") ?? ""].join(" ");
  const byLabel = consequentialBlockReason(visible, taskIntents);
  if (byLabel) return byLabel;
  const byIdentity = consequentialBlockReason([element.id, element.getAttribute("name") ?? ""].join(" ").replace(/[-_]/g, " "), taskIntents, ["submit"]);
  if (byIdentity) return byIdentity;
  if (isSubmitControl(element) && formHasSensitiveField(element.closest("form")) && !taskIntents.has("submit") && !taskIntents.has("account") && !taskIntents.has("payment")) {
    return "Click blocked: it submits a form containing sensitive fields and the task does not ask to submit it";
  }
  return null;
}

/**
 * A cart-add control may be used a bounded number of times per task (the
 * listing button, then the variant dialog's button). A further click would
 * add the item again; the reasoner should have read the cart evidence
 * instead. Tasks asking for several items are exempt.
 */
function repeatedCartAddReason(element: HTMLElement, priorCartAdds: number, confirmed: ActionRecord[]): string | null {
  const label = getAccessibleText(element);
  if (!CART_ADD_LABEL.test(label)) return null;
  const multiple = taskAllowsRepeatedCartAdds(taskText);
  // State-based rule first: the cart already showed the item going in (count up,
  // confirmation, go-to-cart). Adding again is a duplicate, unless the task asks
  // for several items and this is a different product.
  if (confirmed.length > 0) {
    const context = elementContext(element, label);
    const sameProduct = confirmed.some((h) => (h.context ?? "") === (context ?? "") || !h.context || !context);
    if (!multiple || sameProduct) return "Repeated action refused: the cart already shows this item was added; clicking add-to-cart again would add it twice";
  }
  // Bounded backstop for pages that expose no cart signal at all.
  if (priorCartAdds < CART_ADD_LIMIT || multiple) return null;
  return `Repeated action refused: an add-to-cart control was already used ${priorCartAdds} times in this task; clicking again would add the item again`;
}

function isSubmitControl(element: HTMLElement): boolean {
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  if (element.tagName === "BUTTON") return type === "" || type === "submit";
  return element.tagName === "INPUT" && (type === "submit" || type === "image");
}

function formHasSensitiveField(form: HTMLFormElement | null): boolean {
  if (!form) return false;
  for (const field of form.querySelectorAll<HTMLElement>("input, textarea")) {
    const id = field.getAttribute("data-ps-id");
    if (id && sensitiveTypeOf(id)) return true;
    if ((field.getAttribute("type") ?? "").toLowerCase() === "password") return true;
  }
  return false;
}
