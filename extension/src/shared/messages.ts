/**
 * Internal messages passed between popup, service worker and content script.
 * These never leave the browser. The wire contract lives in contract.ts.
 */

import type { ValidationCode } from "../content/action-validator";
import type { FirewallVerdict, PrivacySummary } from "../privacy/types";

/** Popup -> service worker */
export interface RunTaskMessage {
  type: "RUN_TASK";
  task: string;
}

/** Service worker -> content script, used only to check the script is present */
export interface PingMessage {
  type: "PING";
}

/** Service worker -> content script. The task travels down so the content script can build the whole request. */
export interface ExtractPageMessage {
  type: "EXTRACT_PAGE";
  task: string;
}

/** Service worker -> content script. The action is untrusted until the validator has seen it. */
export interface ExecuteActionMessage {
  type: "EXECUTE_ACTION";
  action: unknown;
}

/** Service worker -> popup, sent several times during one run */
export interface StatusMessage {
  type: "STATUS";
  text: string;
  level: "info" | "success" | "error";
}

/** Service worker -> popup, the exact JSON body sent to the backend */
export interface SanitizedPayloadMessage {
  type: "SANITIZED_PAYLOAD";
  json: string;
}

export type PipelineStage = "detect" | "leakage" | "firewall" | "reason" | "validate" | "execute";
export type StageState = "pending" | "pass" | "fail" | "skipped";

/** Service worker -> popup, one per pipeline stage transition */
export interface StageMessage {
  type: "STAGE";
  stage: PipelineStage;
  state: StageState;
  detail?: string;
}

export type ContentMessage = PingMessage | ExtractPageMessage | ExecuteActionMessage;
export type RuntimeMessage = RunTaskMessage | StatusMessage | SanitizedPayloadMessage | StageMessage | ContentMessage;

export interface PingResult {
  ok: true;
}

/** Content script reply to EXTRACT_PAGE. Carries the firewall verdict, never raw values. */
export type ExtractPageResult =
  | { ok: true; summary: PrivacySummary; firewall: FirewallVerdict }
  | { ok: false; error: string };

/** Content script reply to EXECUTE_ACTION */
export interface ExecuteActionResult {
  ok: boolean;
  message: string;
  validation: "pass" | "blocked";
  code?: ValidationCode;
}
