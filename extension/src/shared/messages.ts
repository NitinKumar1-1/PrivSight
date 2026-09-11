/**
 * Internal messages passed between popup, service worker, offscreen document
 * and content script. These never leave the browser. The wire contract lives
 * in contract.ts.
 */

import type { ValidationCode } from "../content/action-validator";
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
}

/** Service worker -> popup. Measured numbers from this run. */
export interface MetricsMessage {
  type: "METRICS";
  metrics: RunMetrics;
}

export interface RunMetrics {
  round: number;
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
  | StatusMessage
  | SanitizedPayloadMessage
  | StageMessage
  | PreviewMessage
  | MetricsMessage
  | ContentMessage
  | OffscreenRequest;

export interface PingResult {
  ok: true;
}

/** Content script reply to EXTRACT_PAGE. Carries the firewall verdict, never raw values or images. */
export type ExtractPageResult =
  | { ok: true; summary: PrivacySummary; firewall: FirewallVerdict; visualPrivacy: VisualPrivacySummary | null }
  | { ok: false; error: string };

/** Content script reply to EXECUTE_ACTION */
export interface ExecuteActionResult {
  ok: boolean;
  message: string;
  validation: "pass" | "blocked";
  code?: ValidationCode;
}

// --- offscreen document -----------------------------------------------------

/** Service worker -> offscreen document. The screenshot stays inside the extension. */
export type OffscreenRequest =
  | { target: "offscreen"; type: "OCR_IMAGE"; dataUrl: string; devicePixelRatio: number }
  | { target: "offscreen"; type: "MASK_IMAGE"; dataUrl: string; regions: BBox[] }
  | { target: "offscreen"; type: "VISION_INFO" };

export type OffscreenResponse =
  | { ok: true; result: OcrResult }
  | { ok: true; dataUrl: string }
  | { ok: true; info: { engine: string; backend: string; webgpu: string } }
  | { ok: false; error: string };
