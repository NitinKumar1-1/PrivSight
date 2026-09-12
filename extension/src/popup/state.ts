/**
 * Popup agent-state machine. Pure: maps the controller's stage events onto
 * the single status word the popup shows. No chrome.*, no DOM, so it can be
 * unit tested. The controller decides what happens; this only names it.
 */

import type { PipelineStage, StageState } from "../shared/messages";

export type AgentState =
  | "Idle"
  | "Observing"
  | "Protecting privacy"
  | "Reasoning"
  | "Validating"
  | "Executing"
  | "Re-observing"
  | "Complete"
  | "Unverified"
  | "Blocked"
  | "Failed";

export const TERMINAL_STATES: ReadonlySet<AgentState> = new Set(["Complete", "Unverified", "Blocked", "Failed"]);

/** State after a stage event. Re-observation after a validator block moves back to Observing. */
export function nextState(current: AgentState, stage: PipelineStage, state: StageState): AgentState {
  switch (stage) {
    case "vision":
    case "dom":
      return state === "fail" ? "Failed" : "Observing";
    case "detect":
    case "visual-redaction":
    case "leakage":
      return state === "fail" ? "Blocked" : "Protecting privacy";
    case "firewall":
      return state === "fail" ? "Blocked" : "Reasoning";
    case "reason":
      if (state === "fail") return "Failed";
      if (state === "skipped") return current;
      return state === "pass" ? "Validating" : "Reasoning";
    case "validate":
      if (state === "fail") return "Blocked";
      if (state === "skipped") return current;
      return state === "pass" ? "Executing" : "Validating";
    case "execute":
      if (state === "pass") return "Complete";
      if (state === "fail") return "Failed";
      return current;
    default:
      return current;
  }
}

/** Badge kind for a state, used for colour only. */
export function stateKind(state: AgentState): "idle" | "busy" | "ok" | "blocked" | "failed" | "unverified" {
  switch (state) {
    case "Idle":
      return "idle";
    case "Complete":
      return "ok";
    case "Unverified":
      return "unverified";
    case "Blocked":
      return "blocked";
    case "Failed":
      return "failed";
    default:
      return "busy";
  }
}

/** Short human line for each state, shown under the status word. */
export function stateHint(state: AgentState): string {
  switch (state) {
    case "Idle":
      return "Enter a task and press Run Task.";
    case "Observing":
      return "Reading the page: DOM and a local screen capture.";
    case "Protecting privacy":
      return "Detecting and redacting sensitive values on this device.";
    case "Reasoning":
      return "Sanitized context sent. Waiting for a structured action.";
    case "Validating":
      return "Checking the action against the live page.";
    case "Executing":
      return "Performing the validated browser action.";
    case "Re-observing":
      return "Reading the page again after the last action.";
    case "Complete":
      return "Done and verified on the page. Nothing sensitive left this browser.";
    case "Unverified":
      return "Action was performed, but the final result could not be verified.";
    case "Blocked":
      return "Stopped by a local safety check. Nothing was sent or clicked.";
    case "Failed":
      return "The run could not finish. See the log below.";
  }
}
