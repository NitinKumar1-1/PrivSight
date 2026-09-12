/**
 * Internal messages passed between popup, service worker, offscreen document
 * and content script. These never leave the browser. The wire contract lives
 * in contract.ts.
 */

import type { ValidationCode } from "../content/action-validator";
import type { CartEvidence, PostActionEffect } from "../content/page-state";
import type { OutcomeCode } from "./outcomes";
import type { ActionRecord } from "./contract";
import type { VisualPrivacySummary } from "../privacy/sanitize";
import type { FirewallVerdict, PrivacySummary } from "../privacy/types";
import type { BBox, OcrResult } from "../vision/types";

/** Popup -> service worker */
export interface RunTaskMessage {
  type: "RUN_TASK";
  task: string;
  /** Optional explicit tab. The toolbar popup omits it; automated tests set it. */
  tabId?: number;
}

/** Popup -> service worker: the messages of the current run so far, for a popup opened mid-run. */
export interface GetRunLogMessage {
  type: "GET_RUN_LOG";
}

/** Everything the popup was sent during one run. Mirrored to chrome.storage.session under RUN_LOG_KEY. */
export interface RunLog {
  task: string;
  runId?: string;
  messages: Array<StatusMessage | SanitizedPayloadMessage | StageMessage | PreviewMessage | PageMessage | MetricsMessage | OutcomeMessage | PhaseMessage | StateMessage>;
}
export const RUN_LOG_KEY = "runLog";

/** Service worker -> content script, used only to check the script is present */
export interface PingMessage {
  type: "PING";
}

/**
 * Service worker -> content script. The task travels down so the content
 * script can build the whole request. The OCR result (text and boxes only,
 * never the image) travels down so it can be fused and redacted next to the
 * DOM with the same redactor.
 */
export interface ExtractPageMessage {
  type: "EXTRACT_PAGE";
  task: string;
  ocr: OcrResult | null;
  /** Actions already executed for this task (Phase 7 multi-step). */
  history?: ActionRecord[];
  /** Controller guidance for this round (value-free), forwarded into the sanitized request. */
  guidance?: string;
}

/** Service worker -> content script. The action is untrusted until the validator has seen it. */
export interface ExecuteActionMessage {
  type: "EXECUTE_ACTION";
  action: unknown;
  /** Actions already executed for this task, so repeated consequential clicks can be bounded locally. */
  history?: ActionRecord[];
}

/** Service worker -> popup, sent several times during one run */
export interface StatusMessage {
  type: "STATUS";
  text: string;
  level: "info" | "success" | "error";
}

/** Service worker -> popup: how the run ended, in user-facing words plus two facts. */
export interface OutcomeMessage {
  type: "OUTCOME";
  code: OutcomeCode;
  title: string;
  message: string;
  cloudContacted: boolean;
  browserActed: boolean;
  /** Technical detail for developer logs only; the popup never renders it as text. */
  detail?: string;
}

/** Service worker -> popup: an execution phase the pipeline stages alone cannot express. */
export interface PhaseMessage {
  type: "PHASE";
  phase: "re-observing";
}

/** Service worker -> popup: a new run started; messages carry its id so an older run's lines are ignored. */
export interface RunStartedMessage {
  type: "RUN_STARTED";
  runId: string;
  task: string;
  maxSteps: number;
}

/** Service worker -> popup: the task state after one step (value-free). */
export interface StateMessage {
  type: "STATE";
  state: {
    step: number;
    maxSteps: number;
    goal: string;
    page: string;
    action: string;
    actionResult: string;
    taskResult: string;
    taskDetail: string;
    next: string;
    recoveries: number;
    failedActions: number;
  };
}

/**
 * Development-only trace of one attempted action. Labels are redacted with
 * the page redactor before they get here; values are never included.
 */
export interface ActionTrace {
  action: string;
  /** Redacted accessible label of the target (or scroll direction). */
  target: string;
  resolution: "ps-id" | "semantic" | "failed" | "none";
  match: string;
  validation: "PASS" | "FAIL";
  execution: "PASS" | "FAIL" | "SKIPPED" | "PENDING";
  postAction: string;
  /** Redacted product context of the target when the page has one. */
  context?: string;
  reobserve?: "YES" | "NO";
  final?: "CONTINUE" | "DONE" | "BLOCKED" | "FAILED";
}

/** Service worker -> popup, the exact JSON body sent to the backend */
export interface SanitizedPayloadMessage {
  type: "SANITIZED_PAYLOAD";
  json: string;
}

export type PipelineStage =
  | "dom"
  | "vision"
  | "visual-redaction"
  | "detect"
  | "leakage"
  | "firewall"
  | "reason"
  | "validate"
  | "execute";
export type StageState = "pending" | "pass" | "fail" | "skipped" | "fallback";

/** Service worker -> popup, one per pipeline stage transition */
export interface StageMessage {
  type: "STAGE";
  stage: PipelineStage;
  state: StageState;
  detail?: string;
}

/**
 * Service worker -> popup. Local previews for the demonstration only:
 * the raw capture and the locally masked capture. Extension UI, never network.
 */
export interface PreviewMessage {
  type: "PREVIEW";
  rawDataUrl: string | null;
  maskedDataUrl: string | null;
  maskCount: number;
  /** Pictures covered in the local preview (they never leave the browser). */
  imageCount?: number;
}

/**
 * Service worker -> popup. What the agent is looking at, taken from the
 * sanitized request body after the firewall approved it: never raw page text.
 */
export interface PageMessage {
  type: "PAGE";
  /** Sanitized title (same redactor as the page). */
  title: string;
  host: string;
  elements: number;
  placeholders: number;
  visualObservations: number;
}

/** Service worker -> popup. Measured numbers from this run. */
export interface MetricsMessage {
  type: "METRICS";
  metrics: RunMetrics;
}

export interface RunMetrics {
  round: number;
  /** Step of the multi-step task this round belongs to (Phase 7). */
  step?: number;
  /** Steps executed for the whole task, reported with the final metrics. */
  stepsTotal?: number;
  captureMs?: number;
  ocrLoadMs?: number;
  ocrRecognizeMs?: number;
  perceptionMs?: number;
  privacyMs?: number;
  reasonMs?: number;
  executeMs?: number;
  totalMs?: number;
  usedJsHeapMb?: number;
  ocrLines?: number;
  observationsSent?: number;
  maskRegions?: number;
  engine?: string;
  webgpu?: string;
}

export type ContentMessage = PingMessage | ExtractPageMessage | ExecuteActionMessage;
export type RuntimeMessage =
  | RunTaskMessage
  | GetRunLogMessage
  | StatusMessage
  | SanitizedPayloadMessage
  | StageMessage
  | PreviewMessage
  | PageMessage
  | MetricsMessage
  | OutcomeMessage
  | PhaseMessage
  | RunStartedMessage
  | StateMessage
  | ContentMessage
  | OffscreenRequest;

export interface PingResult {
  ok: true;
}

/** Content script reply to EXTRACT_PAGE. Carries the firewall verdict, never raw values or images. */
export type ExtractPageResult =
  | { ok: true; summary: PrivacySummary; firewall: FirewallVerdict; visualPrivacy: VisualPrivacySummary | null; /** Visible pictures (CSS px, viewport) for the local preview only. */ imageRegions?: BBox[] }
  | { ok: false; error: string };

/** Content script reply to EXECUTE_ACTION */
export interface ExecuteActionResult {
  ok: boolean;
  message: string;
  validation: "pass" | "blocked";
  code?: ValidationCode | "action_failed";
  /** A validated navigate: the service worker opens this URL in the tab (Phase 7). */
  navigateTo?: string;
  /** What the page did after the action, observed locally for a bounded time (Phase 8). */
  postAction?: PostActionEffect;
  /** Value-free note about the result, carried into the history for the reasoner. */
  note?: string;
  /** Cart signals measured locally around a click on an add-to-cart control (numbers and booleans only). */
  cartEvidence?: CartEvidence;
  /** Development trace (redacted labels, no values). */
  trace?: ActionTrace;
}

// --- offscreen document -----------------------------------------------------

/** Service worker -> offscreen document. The screenshot stays inside the extension. */
export type OffscreenRequest =
  | { target: "offscreen"; type: "OCR_IMAGE"; dataUrl: string; devicePixelRatio: number }
  | { target: "offscreen"; type: "MASK_IMAGE"; dataUrl: string; regions: BBox[]; images?: BBox[] }
  | { target: "offscreen"; type: "VISION_INFO" };

export type OffscreenResponse =
  | { ok: true; result: OcrResult }
  | { ok: true; dataUrl: string }
  | { ok: true; info: { engine: string; backend: string; webgpu: string } }
  | { ok: false; error: string };
