/**
 * Centralised outcome codes and their user-facing wording.
 *
 * Every way a run can end maps to one code. The popup shows the title and
 * message for the code, plus two facts a person cares about: whether the
 * cloud was contacted and whether the browser did anything. Technical
 * detail (HTTP status, validator reason, internal ids) stays in developer
 * logs and never reaches the normal popup text.
 */

import type { ValidationCode } from "../content/action-validator";

export type OutcomeCode =
  | "COMPLETED"
  | "COMPLETION_UNVERIFIED"
  | "TARGET_OCCLUDED"
  | "SAFETY_BLOCK"
  | "PRIVACY_BLOCK"
  | "STALE_TARGET"
  | "AMBIGUOUS_TARGET"
  | "MISSING_REQUIRED_DATA"
  | "INSUFFICIENT_EVIDENCE"
  | "UNSUPPORTED_ACTION"
  | "INVALID_MODEL_RESPONSE"
  | "CLOUD_TIMEOUT"
  | "NETWORK_ERROR"
  | "CLOUD_ERROR"
  | "PAGE_UNAVAILABLE"
  | "ACTION_FAILED"
  | "NO_PROGRESS"
  | "REPEATED_ACTION"
  | "TASK_BLOCKED"
  | "CANCELLED"
  | "STEP_LIMIT"
  | "UNKNOWN_ERROR";

export interface OutcomeText {
  title: string;
  message: string;
}

const TEXT: Record<OutcomeCode, OutcomeText> = {
  COMPLETED: { title: "Task complete", message: "Done and verified on the page. Nothing sensitive left this browser." },
  COMPLETION_UNVERIFIED: { title: "Action performed, result not verified", message: "Action was performed, but the final result could not be verified. Check the page before relying on it." },
  TARGET_OCCLUDED: { title: "Target was covered", message: "The target was covered by another page element, so no action was taken." },
  SAFETY_BLOCK: {
    title: "Task blocked for safety",
    message: "This request appears to involve harming someone. PrivSight cannot perform or assist with harmful actions.",
  },
  PRIVACY_BLOCK: {
    title: "Request blocked",
    message: "Sensitive information was detected. Nothing was sent to the AI service.",
  },
  STALE_TARGET: { title: "Page changed", message: "The selected item is no longer available. No action was taken." },
  AMBIGUOUS_TARGET: { title: "I couldn't safely determine which item to use", message: "More than one control matched, so PrivSight did not guess." },
  MISSING_REQUIRED_DATA: { title: "Not enough information on the page", message: "The page does not provide enough information to complete this task safely." },
  INSUFFICIENT_EVIDENCE: { title: "Could not confirm the result", message: "PrivSight could not verify that the task reached its goal, so it stopped instead of guessing." },
  UNSUPPORTED_ACTION: { title: "This type of task isn't supported yet", message: "The action the task needs is not available in this version." },
  INVALID_MODEL_RESPONSE: { title: "Action blocked", message: "The AI returned an unsafe or invalid action. Nothing was executed." },
  CLOUD_TIMEOUT: { title: "AI service didn't respond in time", message: "Please try again. No browser action was performed." },
  NETWORK_ERROR: { title: "AI service unavailable", message: "Please try again. No browser action was performed." },
  CLOUD_ERROR: { title: "AI service unavailable", message: "Please try again. No browser action was performed." },
  PAGE_UNAVAILABLE: { title: "The webpage couldn't be accessed", message: "PrivSight could not read this page. Reload it and try again." },
  ACTION_FAILED: { title: "The requested action could not be completed", message: "The page did not accept the action. Nothing else was changed." },
  NO_PROGRESS: { title: "Stopped: no progress", message: "The same step kept repeating without any effect, so PrivSight stopped." },
  REPEATED_ACTION: { title: "Stopped: that step was already done", message: "The add-to-cart step was already carried out for this task, so PrivSight stopped rather than add the item again. Check the cart." },
  TASK_BLOCKED: { title: "Task blocked", message: "The page shows a condition that prevents the task, and the recovery attempts did not find another way. See the activity log for the observed reason." },
  CANCELLED: { title: "Task cancelled", message: "A new task was started, so this one was stopped safely." },
  STEP_LIMIT: { title: "Stopped: step limit reached", message: "The task needed more steps than PrivSight allows in one run." },
  UNKNOWN_ERROR: { title: "Something went wrong", message: "Something went wrong; no action was taken." },
};

export function describeOutcome(code: OutcomeCode): OutcomeText {
  return TEXT[code] ?? TEXT.UNKNOWN_ERROR;
}

/** Codes the reasoner may put in the value of a "done" action to explain why it stopped. */
export const DONE_REASON_CODES: ReadonlySet<string> = new Set(["MISSING_REQUIRED_DATA", "AMBIGUOUS_TARGET", "INSUFFICIENT_EVIDENCE"]);

/** Maps a validator code to the outcome code shown when the run ends on it. */
export function outcomeForValidation(code: ValidationCode | undefined): OutcomeCode {
  switch (code) {
    case "unknown_target":
    case "incompatible_target":
    case "target_not_clickable":
      return "STALE_TARGET";
    case "target_occluded":
      return "TARGET_OCCLUDED";
    case "ambiguous_target":
      return "AMBIGUOUS_TARGET";
    case "unsupported_action":
    case "unsupported_by_executor":
      return "UNSUPPORTED_ACTION";
    case "repeated_action":
      return "REPEATED_ACTION";
    case "consequential_action":
    case "navigation_not_authorised":
    case "sensitive_policy":
    case "dangerous_navigation":
      return "SAFETY_BLOCK";
    case undefined:
      return "UNKNOWN_ERROR";
    default:
      return "INVALID_MODEL_RESPONSE";
  }
}

/** Classifies a raw error message from the cloud, network or host into an outcome code. */
export function classifyError(message: string): OutcomeCode {
  const text = message.toLowerCase();
  if (/privacy firewall|leakage/.test(text)) return "PRIVACY_BLOCK";
  if (/timed? ?out|timeout|aborted/.test(text)) return "CLOUD_TIMEOUT";
  if (/invalid action from reasoning provider|not valid json|does not match the contract|unusable action/.test(text)) return "INVALID_MODEL_RESPONSE";
  if (/failed to fetch|networkerror|network error|econnrefused|could not connect|fetch failed/.test(text)) return "NETWORK_ERROR";
  if (/backend returned \d{3}|reasoning provider error|cloud reasoner unavailable|quota/.test(text)) return "CLOUD_ERROR";
  if (/could not establish connection|receiving end does not exist|message port closed|no active tab|cannot access|frame was removed|no web page|execution context was destroyed|because of a navigation/.test(text)) return "PAGE_UNAVAILABLE";
  if (/page extraction failed|extract/.test(text)) return "PAGE_UNAVAILABLE";
  return "UNKNOWN_ERROR";
}
