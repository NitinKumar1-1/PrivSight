/**
 * Message handlers for the content script, kept free of chrome.* so they can
 * be unit tested. index.ts wires them to chrome.runtime.onMessage.
 */

import { placeholderType, sensitiveTypeOf } from "../privacy/sanitize";
import type { ExecuteActionResult, ExtractPageResult } from "../shared/messages";
import { EXECUTOR_SUPPORTED_ACTIONS, validateAction, type ValidationContext } from "./action-validator";
import { findElementByPsId } from "./element-ids";
import { executeAction } from "./executor";
import { prepareRequest } from "./perception";

export function handleExtractPage(task: string): ExtractPageResult {
  try {
    const { summary, firewall } = prepareRequest(task);
    return { ok: true, summary, firewall };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Validates untrusted input from the backend, then executes only if it passed. */
export function handleExecuteAction(input: unknown): ExecuteActionResult {
  const result = validateAction(input, liveValidationContext());
  if (!result.ok) {
    return { ok: false, message: result.reason, validation: "blocked", code: result.code };
  }
  try {
    return executeAction(result.action);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Execution failed: ${message}`, validation: "pass" };
  }
}

function liveValidationContext(): ValidationContext {
  return {
    findElement: findElementByPsId,
    sensitiveTypeOf,
    placeholderType,
    supportedActions: EXECUTOR_SUPPORTED_ACTIONS,
  };
}
