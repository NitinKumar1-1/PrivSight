/**
 * Local Action Validator.
 *
 * Everything the backend returns is untrusted input. Before the executor may
 * touch the page, the action must pass, in order:
 *
 *   1. structure      plain object, only the five contract fields, right types
 *   2. allowlist      action is one of the contract's six actions
 *   3. confidence     finite number in [0, 1]; metadata only, never a pass
 *   4. content        no executable content in any string field
 *   5. target         required where the action needs one, well-formed,
 *                     present in the live DOM, compatible with the action
 *   6. value          required where the action needs one, safe for navigate
 *   7. sensitive      placeholders only into fields of the same PII type,
 *                     never a raw value into a sensitive field
 *   8. consequential  a click on a purchase/checkout/payment/sign-in/destructive/
 *                     submit control needs matching intent in the user's task
 *   9. executor       the current executor implements the action
 *
 * The returned ValidatedAction brand is a compile-time aid so the executor
 * cannot be called with an unvalidated object. The runtime guarantee is this
 * function running in the content script on every EXECUTE_ACTION message.
 */

import type { PiiType } from "../privacy/types";
import type { ActionResponse, ActionType } from "../shared/contract";
import { DONE_REASON_CODES } from "../shared/outcomes";
import type { Resolution } from "./target-resolver";

export const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(["click", "type", "press", "scroll", "select", "navigate", "done"]);
/**
 * What content/executor.ts can actually perform today. Typing, selecting and
 * navigation stay unsupported on purpose: they are the consequential actions,
 * and a task that needs them fails closed here with a clear reason.
 */
export const EXECUTOR_SUPPORTED_ACTIONS: ReadonlySet<ActionType> = new Set(["click", "type", "press", "select", "scroll", "navigate", "done"]);

const CONTRACT_FIELDS: ReadonlySet<string> = new Set(["action", "target", "value", "confidence", "reason", "final"]);
const TARGET_FORMAT = /^el_[a-z0-9_]{1,64}$/;
const PLACEHOLDER_FORMAT = /^\[[A-Z]+_\d+\]$/;
const EXECUTABLE_CONTENT = /<\s*script|javascript:|vbscript:|data:\s*text\/html|\bon[a-z]+\s*=/i;
const SAFE_NAVIGATION = /^https?:\/\/[^\s]+$/i;
const SCROLL_VALUES: ReadonlySet<string> = new Set(["up", "down", "top", "bottom"]);
const ACTIONS_REQUIRING_TARGET: ReadonlySet<string> = new Set(["click", "type", "press", "select"]);
const PRESSABLE_KEYS: ReadonlySet<string> = new Set(["Enter"]);
const TYPEABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text", "email", "tel", "password", "search", "url", "number", "",
]);

export type ValidatedAction = ActionResponse & { readonly __privsightValidated: unique symbol };

export type ValidationCode =
  | "malformed"
  | "unexpected_field"
  | "unsupported_action"
  | "invalid_confidence"
  | "executable_content"
  | "missing_target"
  | "invalid_target"
  | "unknown_target"
  | "ambiguous_target"
  | "target_not_clickable"
  | "target_occluded"
  | "incompatible_target"
  | "missing_value"
  | "invalid_value"
  | "dangerous_navigation"
  | "sensitive_policy"
  | "consequential_action"
  | "repeated_action"
  | "navigation_not_authorised"
  | "unsupported_by_executor";

export type ValidationResult =
  | { ok: true; action: ValidatedAction }
  | { ok: false; code: ValidationCode; reason: string };

export interface ValidationContext {
  findElement(id: string): HTMLElement | null;
  /**
   * Live resolution (Phase 8): ps-id first, then the semantic fingerprint
   * recorded at observation. When present it replaces findElement for
   * target checks, so a re-rendered control is found again and an
   * ambiguous one is rejected instead of guessed.
   */
  resolveTarget?(id: string): Resolution;
  sensitiveTypeOf(id: string): PiiType | undefined;
  placeholderType(placeholder: string): PiiType | undefined;
  supportedActions: ReadonlySet<ActionType>;
  /** Reason a click on this live element is a consequential action the task did not authorise, or null. */
  isConsequential(element: HTMLElement): string | null;
  /** Reason navigation to this URL is not authorised by the task (Phase 7), or null. */
  isNavigationAllowed(url: string): string | null;
  /**
   * Whether the executor resolves placeholders into sensitive fields. The live
   * executor declares false (Phase 7): a contract-valid placeholder type action
   * is then reported as unsupported by the executor. Undefined leaves the
   * contract-level rule alone (unit tests of the contract).
   */
  typesSensitiveValues?: boolean;
}

export function validateAction(input: unknown, ctx: ValidationContext): ValidationResult {
  if (!isPlainObject(input)) return fail("malformed", "Invalid structured action received");

  for (const key of Object.keys(input)) {
    if (!CONTRACT_FIELDS.has(key)) return fail("unexpected_field", `Unexpected field "${key}" blocked`);
  }

  const { action, target, value, confidence, reason, final } = input;
  if (final !== undefined && typeof final !== "boolean") return fail("malformed", "Action fields have invalid types");
  if (typeof action !== "string" || !ALLOWED_ACTIONS.has(action)) {
    return fail("unsupported_action", "Unsupported action blocked");
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return fail("invalid_confidence", "Confidence must be a number between 0 and 1");
  }
  if (!isOptionalString(target) || !isOptionalString(value) || (reason !== undefined && typeof reason !== "string")) {
    return fail("malformed", "Action fields have invalid types");
  }
  for (const text of [target, value, reason]) {
    if (typeof text === "string" && EXECUTABLE_CONTENT.test(text)) {
      return fail("executable_content", "Executable content in action blocked");
    }
  }

  const typed = action as ActionType;
  const targetCheck = checkTarget(typed, target ?? null, ctx);
  if (targetCheck) return targetCheck;

  const valueCheck = checkValue(typed, target ?? null, value ?? null, ctx);
  if (valueCheck) return valueCheck;

  if (typed === "click" && target) {
    const element = locate(target, ctx);
    const why = element ? ctx.isConsequential(element) : null;
    if (why) return fail(why.startsWith("Repeated") ? "repeated_action" : "consequential_action", why);
  }

  if (!ctx.supportedActions.has(typed)) {
    return fail("unsupported_by_executor", `Action "${typed}" is valid but unsupported by current executor`);
  }
  if (typed === "type" && typeof value === "string" && PLACEHOLDER_FORMAT.test(value) && ctx.typesSensitiveValues === false) {
    return fail("unsupported_by_executor", "Typing sensitive values is unsupported by current executor");
  }

  const normalized: ActionResponse = {
    action: typed,
    target: target ?? null,
    value: typed === "done" && value && !DONE_REASON_CODES.has(value) ? "INSUFFICIENT_EVIDENCE" : value ?? null,
    confidence,
    reason: reason ?? "",
  };
  return { ok: true, action: normalized as ValidatedAction };
}

function checkTarget(action: ActionType, target: string | null, ctx: ValidationContext): ValidationResult | null {
  if (!ACTIONS_REQUIRING_TARGET.has(action)) {
    if (target !== null && target !== "") return fail("invalid_target", `Action "${action}" must not have a target`);
    return null;
  }
  if (!target) return fail("missing_target", "Action has no target");
  if (!TARGET_FORMAT.test(target)) return fail("invalid_target", "Target is not a PrivSight element ID");

  let element: HTMLElement | null;
  if (ctx.resolveTarget) {
    const resolved = ctx.resolveTarget(target);
    if (!resolved.ok) return fail(resolved.code, resolved.reason);
    element = resolved.element;
  } else {
    element = ctx.findElement(target);
  }
  if (!element || !element.isConnected) return fail("unknown_target", "Target element not found on the current page");
  if (isDisabled(element)) return fail("incompatible_target", "Target element is disabled");

  if ((action === "type" || action === "press") && !isTypeable(element)) return fail("incompatible_target", "Target is not a text field");
  if (action === "select") {
    if (element.tagName !== "SELECT") return fail("incompatible_target", "Target is not a standard select control");
    if ((element as HTMLSelectElement).multiple) return fail("incompatible_target", "Multi-select controls are not supported");
  }
  return null;
}

/** The enabled option of a standard select that matches a value by option value or visible label. */
export function findSelectOption(select: HTMLSelectElement, value: string): HTMLOptionElement | null {
  const wanted = value.trim().toLowerCase();
  for (const option of Array.from(select.options)) {
    if (option.disabled) continue;
    if (option.value === value || option.value.trim().toLowerCase() === wanted || option.text.trim().toLowerCase() === wanted) return option;
  }
  return null;
}

/** The live element for a target, through the resolver when the context has one. */
function locate(target: string, ctx: ValidationContext): HTMLElement | null {
  if (ctx.resolveTarget) {
    const resolved = ctx.resolveTarget(target);
    return resolved.ok ? resolved.element : null;
  }
  return ctx.findElement(target);
}

function checkValue(
  action: ActionType,
  target: string | null,
  value: string | null,
  ctx: ValidationContext,
): ValidationResult | null {
  switch (action) {
    case "navigate":
      if (!value) return fail("missing_value", "Navigate action has no URL");
      if (!SAFE_NAVIGATION.test(value)) return fail("dangerous_navigation", "Navigation blocked: only http and https URLs are allowed");
      {
        const why = ctx.isNavigationAllowed(value);
        if (why) return fail("navigation_not_authorised", why);
      }
      return null;
    case "scroll":
      if (value !== null && !SCROLL_VALUES.has(value)) return fail("invalid_value", "Scroll value must be up, down, top or bottom");
      return null;
    case "select": {
      if (value === null) return fail("missing_value", "Select action has no value");
      const element = target ? locate(target, ctx) : null;
      if (element && element.tagName === "SELECT" && !findSelectOption(element as HTMLSelectElement, value)) {
        return fail("invalid_value", "Select value is not one of the control's enabled options");
      }
      return null;
    }
    case "type":
      if (value === null) return fail("missing_value", "Type action has no value");
      return checkSensitivePolicy(target as string, value, ctx);
    case "press":
      if (value === null) return fail("missing_value", "Press action has no key");
      if (!PRESSABLE_KEYS.has(value)) return fail("invalid_value", 'Only the "Enter" key can be pressed');
      return null;
    case "done":
      // "done" executes nothing, so an unrecognised stop code is not a risk; it is read as
      // "stopped without verified evidence" and the reasoner's stated reason is kept for the log.
      return null;
    default:
      return null;
  }
}

/**
 * A placeholder may be typed only into a field of the same detected type, and a
 * raw value may never be typed into a sensitive field. The real value is
 * resolved locally by the executor; the model never sees it.
 */
function checkSensitivePolicy(target: string, value: string, ctx: ValidationContext): ValidationResult | null {
  const fieldType = ctx.sensitiveTypeOf(target);
  if (PLACEHOLDER_FORMAT.test(value)) {
    const placeholderType = ctx.placeholderType(value);
    if (!placeholderType) return fail("sensitive_policy", "Placeholder is not known to this page");
    if (fieldType !== placeholderType) {
      return fail("sensitive_policy", `${placeholderType} placeholder may only be typed into a ${placeholderType} field`);
    }
    return null;
  }
  if (fieldType) return fail("sensitive_policy", `Raw value into ${fieldType} field blocked`);
  return null;
}

function isTypeable(element: HTMLElement): boolean {
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT") return TYPEABLE_INPUT_TYPES.has((element.getAttribute("type") ?? "").toLowerCase());
  const editable = (element.getAttribute("contenteditable") ?? "").toLowerCase();
  return element.hasAttribute("contenteditable") && (editable === "" || editable === "true" || editable === "plaintext-only");
}

function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function fail(code: ValidationCode, reason: string): ValidationResult {
  return { ok: false, code, reason };
}
