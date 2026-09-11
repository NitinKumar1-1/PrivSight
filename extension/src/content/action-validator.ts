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
 *   8. executor       the current executor implements the action
 *
 * The returned ValidatedAction brand is a compile-time aid so the executor
 * cannot be called with an unvalidated object. The runtime guarantee is this
 * function running in the content script on every EXECUTE_ACTION message.
 */

import type { PiiType } from "../privacy/types";
import type { ActionResponse, ActionType } from "../shared/contract";

export const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(["click", "type", "scroll", "select", "navigate", "done"]);
/** What content/executor.ts can actually perform today. */
export const EXECUTOR_SUPPORTED_ACTIONS: ReadonlySet<ActionType> = new Set(["click", "done"]);

const CONTRACT_FIELDS: ReadonlySet<string> = new Set(["action", "target", "value", "confidence", "reason"]);
const TARGET_FORMAT = /^el_[a-z0-9_]{1,64}$/;
const PLACEHOLDER_FORMAT = /^\[[A-Z]+_\d+\]$/;
const EXECUTABLE_CONTENT = /<\s*script|javascript:|vbscript:|data:\s*text\/html|\bon[a-z]+\s*=/i;
const SAFE_NAVIGATION = /^https?:\/\/[^\s]+$/i;
const SCROLL_VALUES: ReadonlySet<string> = new Set(["up", "down", "top", "bottom"]);
const ACTIONS_REQUIRING_TARGET: ReadonlySet<string> = new Set(["click", "type", "select"]);
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
  | "incompatible_target"
  | "missing_value"
  | "invalid_value"
  | "dangerous_navigation"
  | "sensitive_policy"
  | "unsupported_by_executor";

export type ValidationResult =
  | { ok: true; action: ValidatedAction }
  | { ok: false; code: ValidationCode; reason: string };

export interface ValidationContext {
  findElement(id: string): HTMLElement | null;
  sensitiveTypeOf(id: string): PiiType | undefined;
  placeholderType(placeholder: string): PiiType | undefined;
  supportedActions: ReadonlySet<ActionType>;
}

export function validateAction(input: unknown, ctx: ValidationContext): ValidationResult {
  if (!isPlainObject(input)) return fail("malformed", "Invalid structured action received");

  for (const key of Object.keys(input)) {
    if (!CONTRACT_FIELDS.has(key)) return fail("unexpected_field", `Unexpected field "${key}" blocked`);
  }

  const { action, target, value, confidence, reason } = input;
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

  if (!ctx.supportedActions.has(typed)) {
    return fail("unsupported_by_executor", `Action "${typed}" is valid but unsupported by current executor`);
  }

  const normalized: ActionResponse = {
    action: typed,
    target: target ?? null,
    value: value ?? null,
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

  const element = ctx.findElement(target);
  if (!element || !element.isConnected) return fail("unknown_target", "Target element not found on the current page");
  if (isDisabled(element)) return fail("incompatible_target", "Target element is disabled");

  if (action === "type" && !isTypeable(element)) return fail("incompatible_target", "Target is not a text field");
  if (action === "select" && element.tagName !== "SELECT") return fail("incompatible_target", "Target is not a select");
  return null;
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
      return null;
    case "scroll":
      if (value !== null && !SCROLL_VALUES.has(value)) return fail("invalid_value", "Scroll value must be up, down, top or bottom");
      return null;
    case "select":
      if (value === null) return fail("missing_value", "Select action has no value");
      return null;
    case "type":
      if (value === null) return fail("missing_value", "Type action has no value");
      return checkSensitivePolicy(target as string, value, ctx);
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
  if (element.tagName !== "INPUT") return false;
  return TYPEABLE_INPUT_TYPES.has((element.getAttribute("type") ?? "").toLowerCase());
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
