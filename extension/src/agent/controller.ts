/**
 * Local Browser Agent / Controller.
 *
 * Deterministic orchestration of one browser task. It is NOT an AI model:
 * the only local ML inference in this pipeline is the OCR engine behind the
 * `perceive` port, and the only reasoning model is the cloud reasoner behind
 * the `reason` port. The controller owns the bounded loop:
 *
 *   OBSERVE  capture the screen (local) and run local OCR on it
 *   PERCEIVE + SANITIZE  content script: DOM extraction, fusion, redaction,
 *            firewall (returns approved bytes or a block)
 *   REASON   approved bytes -> backend -> structured action (untrusted)
 *   VALIDATE + EXECUTE  content script: action validator, then executor
 *   RE-OBSERVE  only when the validator reports an unknown/stale target,
 *            at most MAX_ROUNDS times in total
 *
 * Every stop condition is explicit and reported. The controller has no way
 * to reach the network except through `reason`, which only accepts a
 * firewall-approved body, and no way to touch the page except through
 * `execute`, which runs the validator first.
 */

import type { ApprovedPayload } from "../privacy/types";
import type { ExecuteActionResult, ExtractPageResult, PipelineStage, RunMetrics, StageState } from "../shared/messages";
import type { BBox, OcrResult } from "../vision/types";

export const MAX_ROUNDS = 3; // one observation plus at most two re-observations
const RETRYABLE_VALIDATION = new Set(["unknown_target", "incompatible_target"]);

export interface Capture {
  dataUrl: string;
  devicePixelRatio: number;
}

export interface VisionInfo {
  engine: string;
  backend: string;
  webgpu: string;
}

export interface AgentPorts {
  ensureContentScript(): Promise<void>;
  /** Local screenshot of the visible tab, or null when capture is unavailable. */
  capture(): Promise<Capture | null>;
  /** Local OCR over the capture. Throws or returns null on engine failure. */
  perceive(capture: Capture): Promise<OcrResult | null>;
  visionInfo(): Promise<VisionInfo | null>;
  extract(task: string, ocr: OcrResult | null): Promise<ExtractPageResult>;
  reason(body: ApprovedPayload): Promise<unknown>;
  execute(action: unknown): Promise<ExecuteActionResult>;
  /** Local masked preview for the popup. Never leaves the extension. */
  renderMask(capture: Capture, regions: BBox[]): Promise<string | null>;
  report(event: AgentEvent): void;
  now(): number;
}

export type AgentEvent =
  | { kind: "stage"; stage: PipelineStage; state: StageState; detail?: string }
  | { kind: "status"; text: string; level: "info" | "success" | "error" }
  | { kind: "payload"; body: string }
  | { kind: "preview"; rawDataUrl: string | null; maskedDataUrl: string | null; maskCount: number }
  | { kind: "metrics"; metrics: RunMetrics };

export interface AgentOutcome {
  status: "completed" | "blocked" | "failed";
  rounds: number;
  message: string;
}

export async function runAgent(task: string, ports: AgentPorts): Promise<AgentOutcome> {
  const startedAt = ports.now();
  await ports.ensureContentScript();
  const info = await ports.visionInfo().catch(() => null);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const metrics: RunMetrics = { round, engine: info?.engine, webgpu: info?.webgpu };
    if (round > 1) ports.report({ kind: "status", text: `Re-observing the page (round ${round} of ${MAX_ROUNDS})...`, level: "info" });

    // --- OBSERVE (local) --------------------------------------------------
    const captureStart = ports.now();
    let captureError: string | null = null;
    const capture = await ports.capture().catch((error: unknown) => {
      captureError = describe(error);
      return null;
    });
    metrics.captureMs = round1(ports.now() - captureStart);

    let ocr: OcrResult | null = null;
    if (capture) {
      const perceiveStart = ports.now();
      try {
        ocr = await ports.perceive(capture);
      } catch (error) {
        ocr = null;
        ports.report({ kind: "stage", stage: "vision", state: "fallback", detail: `local OCR failed: ${describe(error)}; continuing with DOM only` });
      }
      if (ocr) {
        metrics.ocrLoadMs = round1(ocr.timings.loadMs);
        metrics.ocrRecognizeMs = round1(ocr.timings.recognizeMs);
        metrics.perceptionMs = round1(ports.now() - perceiveStart);
        metrics.usedJsHeapMb = ocr.usedJsHeapMb;
        metrics.ocrLines = ocr.lines.length;
        ports.report({ kind: "stage", stage: "vision", state: "pass", detail: `${ocr.engine}: ${ocr.lines.length} lines in ${metrics.ocrRecognizeMs} ms` });
      }
    } else {
      ports.report({
        kind: "stage",
        stage: "vision",
        state: "fallback",
        detail: `screen capture unavailable${captureError ? ` (${captureError})` : ""}; continuing with DOM only`,
      });
    }

    // --- PERCEIVE + SANITIZE (content script) ------------------------------
    const privacyStart = ports.now();
    const extracted = await ports.extract(task, ocr);
    metrics.privacyMs = round1(ports.now() - privacyStart);
    if (!extracted.ok) {
      ports.report({ kind: "stage", stage: "dom", state: "fail", detail: extracted.error });
      return finish("failed", round, `Page extraction failed: ${extracted.error}`);
    }
    ports.report({ kind: "stage", stage: "dom", state: "pass", detail: describeDetections(extracted.summary.detections.length, extracted.summary.placeholders.length) });
    ports.report({ kind: "stage", stage: "detect", state: "pass", detail: describePlaceholders(extracted.summary.placeholders, extracted.summary.types) });
    ports.report({ kind: "status", text: describePrivacy(extracted.summary.placeholders, extracted.summary.types), level: "success" });

    const visualPrivacy = extracted.visualPrivacy;
    if (visualPrivacy) {
      metrics.observationsSent = visualPrivacy.observationsSent;
      metrics.maskRegions = visualPrivacy.maskRegions.length;
      const detail = `${visualPrivacy.maskRegions.length} region(s) masked; ${visualPrivacy.observationsSent} observation(s) kept; ` +
        `${visualPrivacy.fusion.duplicatesDropped} duplicate(s) dropped; ${visualPrivacy.fusion.buttonsMapped} button(s) mapped` +
        (visualPrivacy.conflicts.length ? `; ${visualPrivacy.conflicts.length} conflict(s), DOM preferred` : "");
      ports.report({ kind: "stage", stage: "visual-redaction", state: "pass", detail });
      if (capture) {
        const masked = await ports.renderMask(capture, visualPrivacy.maskRegions.map((r) => r.bbox)).catch(() => null);
        ports.report({ kind: "preview", rawDataUrl: capture.dataUrl, maskedDataUrl: masked, maskCount: visualPrivacy.maskRegions.length });
      }
    } else {
      ports.report({ kind: "stage", stage: "visual-redaction", state: "skipped", detail: "no visual observations this round" });
    }

    const { firewall } = extracted;
    const checks = firewall.checks.map((c) => `${c.name}:${c.passed ? "pass" : "fail"}`).join(" ");
    if (firewall.verdict === "blocked") {
      ports.report({ kind: "stage", stage: "leakage", state: "fail", detail: checks });
      ports.report({ kind: "stage", stage: "firewall", state: "fail", detail: "REQUEST BLOCKED" });
      skip(ports, ["reason", "validate", "execute"]);
      return finish("blocked", round, firewall.reason);
    }
    ports.report({ kind: "stage", stage: "leakage", state: "pass", detail: checks });
    ports.report({ kind: "stage", stage: "firewall", state: "pass", detail: "REQUEST ALLOWED" });
    ports.report({ kind: "payload", body: firewall.body });

    // --- REASON (cloud, sanitized bytes only) ------------------------------
    ports.report({ kind: "stage", stage: "reason", state: "pending" });
    ports.report({ kind: "status", text: "Sending sanitized request to backend...", level: "info" });
    const reasonStart = ports.now();
    let raw: unknown;
    try {
      raw = await ports.reason(firewall.body);
    } catch (error) {
      ports.report({ kind: "stage", stage: "reason", state: "fail", detail: describe(error) });
      skip(ports, ["validate", "execute"]);
      return finish("failed", round, describe(error));
    }
    metrics.reasonMs = round1(ports.now() - reasonStart);
    ports.report({ kind: "stage", stage: "reason", state: "pass", detail: "structured action received" });
    ports.report({ kind: "status", text: `Action received: ${describeRaw(raw)}`, level: "info" });

    // --- VALIDATE + EXECUTE (content script) --------------------------------
    ports.report({ kind: "stage", stage: "validate", state: "pending" });
    const executeStart = ports.now();
    const result = await ports.execute(raw);
    metrics.executeMs = round1(ports.now() - executeStart);
    metrics.totalMs = round1(ports.now() - startedAt);
    ports.report({ kind: "metrics", metrics });

    if (result.validation === "blocked") {
      ports.report({ kind: "stage", stage: "validate", state: "fail", detail: result.message });
      const retryable = result.code !== undefined && RETRYABLE_VALIDATION.has(result.code);
      if (retryable && round < MAX_ROUNDS) {
        ports.report({ kind: "status", text: `Action blocked by local validator: ${result.message}. Target may have changed; re-observing.`, level: "error" });
        continue;
      }
      skip(ports, ["execute"]);
      return finish("blocked", round, `Action blocked by local validator: ${result.message}`);
    }
    ports.report({ kind: "stage", stage: "validate", state: "pass", detail: "action verified against the live page" });

    if (!result.ok) {
      ports.report({ kind: "stage", stage: "execute", state: "fail", detail: result.message });
      return finish("failed", round, `Action failed: ${result.message}`);
    }
    ports.report({ kind: "stage", stage: "execute", state: "pass", detail: result.message });
    ports.report({ kind: "status", text: `Action executed: ${result.message}`, level: "success" });
    return finish("completed", round, result.message);
  }

  return finish("blocked", MAX_ROUNDS, `Stopped after ${MAX_ROUNDS} observation rounds without a valid action`);

  function finish(status: AgentOutcome["status"], rounds: number, message: string): AgentOutcome {
    return { status, rounds, message };
  }
}

function skip(ports: AgentPorts, stages: PipelineStage[]): void {
  for (const stage of stages) ports.report({ kind: "stage", stage, state: "skipped" });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeDetections(fields: number, placeholders: number): string {
  return `${fields} sensitive field(s), ${placeholders} value(s) redacted`;
}

function describePlaceholders(placeholders: string[], types: Record<string, string>): string {
  return placeholders.length === 0 ? "nothing sensitive found" : placeholders.map((p) => `${types[p]} -> ${p}`).join(", ");
}

function describePrivacy(placeholders: string[], types: Record<string, string>): string {
  return `Local PII detection: ${describePlaceholders(placeholders, types)}`;
}

/** Describes untrusted backend output without assuming its shape. */
function describeRaw(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "unrecognized response";
  const record = raw as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action : "?";
  const target = typeof record.target === "string" ? ` ${record.target}` : "";
  const confidence = typeof record.confidence === "number" ? ` (confidence ${Math.round(record.confidence * 100)}%)` : "";
  const reason = typeof record.reason === "string" ? ` - ${record.reason}` : "";
  return `${action}${target}${confidence}${reason}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
