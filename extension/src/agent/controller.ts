/**
 * Local Browser Agent / Controller.
 *
 * Deterministic orchestration of one browser task. It is NOT an AI model:
 * the only local ML inference in this pipeline is the OCR engine behind the
 * `perceive` port, and the only reasoning model is the cloud reasoner behind
 * the `reason` port. The controller owns the task state and the bounded loop:
 *
 *   GUARD    local task safety guard: a clearly harmful task ends here with
 *            zero cloud requests and zero browser actions
 *   OBSERVE  capture the screen (local) and run local OCR on it
 *   PERCEIVE + SANITIZE  content script: DOM extraction, fusion, redaction,
 *            firewall (returns approved bytes or a block) — on EVERY round
 *   REASON   approved bytes -> backend -> structured action (untrusted)
 *   VALIDATE + EXECUTE  content script: action validator, then executor,
 *            which resolves the target again, acts, verifies, and watches
 *            the page for a bounded time
 *   RECORD   ACTION RESULT (success / failure / blocked) goes into the
 *            history with the observed effect. An action result is never a
 *            task result.
 *   VERIFY   TASK RESULT is decided locally from evidence (completion.ts):
 *            a "done" from the reasoner is a CLAIM. A verified goal ends the
 *            task as SUCCESS. A contradicted claim (goal not reached, or a
 *            blocker the current page does not show) is rejected with
 *            recovery guidance and the loop continues. Only after the
 *            recovery budget is spent does a page-supported blocker end the
 *            task as BLOCKED, with the verified reason.
 *   RE-OBSERVE  after every executed action, after a stale/ambiguous/
 *            covered target (at most MAX_ROUNDS per step) and after a
 *            failed action (recovery). Targeted: when the last action had
 *            no page effect or only filled a field, the next observation is
 *            DOM-only (no capture, no OCR)
 *
 * The task state (goal, step, current page, history, observations, failed
 * actions, recovery attempts, completion verdict) lives here for the whole
 * run: navigation, re-renders and tabs the page opens never reset it. The
 * step budget is an execution limit, not a plan: a task ends on SUCCESS,
 * BLOCKED, a safety/privacy stop, or the configured budget.
 *
 * Every stop condition is explicit and reported with an outcome code. The
 * controller has no way to reach the network except through `reason`, which
 * only accepts a firewall-approved body, and no way to touch the page except
 * through `execute`, which runs the validator first. It never chooses,
 * rewrites or substitutes a target: what the reasoner returned is what the
 * validator sees.
 */

import type { ApprovedPayload } from "../privacy/types";
import type { ActionEffect, ActionRecord } from "../shared/contract";
import type { ActionTrace, ExecuteActionResult, ExtractPageResult, PipelineStage, RunMetrics, StageState } from "../shared/messages";
import { classifyError, DONE_REASON_CODES, outcomeForValidation, type OutcomeCode } from "../shared/outcomes";
import { scaleRegions } from "../content/image-regions";
import type { BBox, OcrResult } from "../vision/types";
import { assessBlockerClaim, goalEndState, goalOf, pageFactsFromBody, verifyCompletion, type CompletionVerdict, type GoalKind, type PageFacts } from "./completion";
import { taskConstraintsGuidance } from "./task-facts";
import { assessTask } from "./task-guard";

export const MAX_ROUNDS = 3; // one observation plus at most two re-observations per step
/** Default execution budget: executed actions per task, "done" included. A limit, never a plan. */
export const DEFAULT_MAX_STEPS = 30;
/** @deprecated use DEFAULT_MAX_STEPS or the maxSteps option; kept for older tests. */
export const MAX_STEPS = DEFAULT_MAX_STEPS;
/** How many times a contradicted "done" (or a claimed blocker) is sent back with recovery guidance. */
export const DEFAULT_MAX_RECOVERIES = 3;
/** How many failed actions may be recovered from before the run fails. */
export const DEFAULT_MAX_FAILED_ACTIONS = 2;
/** Guidance text is local and value-free; the wire caps it, so cap it here too. */
export const MAX_GUIDANCE_LENGTH = 400;
const RETRYABLE_VALIDATION = new Set(["unknown_target", "incompatible_target", "ambiguous_target", "target_not_clickable", "target_occluded"]);

export interface AgentOptions {
  maxSteps?: number;
  maxRecoveries?: number;
  maxFailedActions?: number;
}

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
  /** Observes the current page; `guidance` is the controller's value-free note for this round (redacted like everything else). */
  extract(task: string, ocr: OcrResult | null, history: ActionRecord[], guidance?: string): Promise<ExtractPageResult>;
  reason(body: ApprovedPayload): Promise<unknown>;
  /** Validates and executes one action; the history lets the validator bound repeated consequential clicks. */
  execute(action: unknown, history?: ActionRecord[]): Promise<ExecuteActionResult>;
  /** Local masked preview for the popup. Never leaves the extension. */
  renderMask(capture: Capture, regions: BBox[], images?: BBox[]): Promise<string | null>;
  /** Waits for a navigation or DOM change after an executed action to finish. Optional. */
  settle?(): Promise<void>;
  /** Current tab URL; a non-http(s) URL means no content script can run there (Phase 7). Optional. */
  pageUrl?(): Promise<string>;
  /** Observation used when no page is open: sanitized "nothing here" context. Optional. */
  observeOffPage?(task: string, history: ActionRecord[], guidance?: string): Promise<ExtractPageResult>;
  /** Validates an action when no page is open: navigate (task-authorised) or done. Optional. */
  executeOffPage?(action: unknown): Promise<ExecuteActionResult>;
  /** Opens a validated URL in the tab and waits for it to load. Optional. */
  navigate?(url: string): Promise<void>;
  /** True when the host cancelled this run (a new task was started). Optional. */
  isCancelled?(): boolean;
  report(event: AgentEvent): void;
  now(): number;
}

/** Value-free summary of the task state after one step, for the activity log. */
export interface TaskStateSummary {
  step: number;
  maxSteps: number;
  goal: GoalKind;
  /** Hostname of the page the step acted on. */
  page: string;
  action: string;
  actionResult: "success" | "failed" | "blocked";
  taskResult: "not complete" | "verified complete" | "unverified";
  taskDetail: string;
  next: string;
  recoveries: number;
  failedActions: number;
}

export type AgentEvent =
  | { kind: "stage"; stage: PipelineStage; state: StageState; detail?: string }
  | { kind: "status"; text: string; level: "info" | "success" | "error" }
  | { kind: "payload"; body: string }
  | { kind: "preview"; rawDataUrl: string | null; maskedDataUrl: string | null; maskCount: number; imageCount: number }
  | { kind: "page"; title: string; host: string; elements: number; placeholders: number; visualObservations: number }
  | { kind: "step"; step: number; maxSteps: number; action: string }
  | { kind: "metrics"; metrics: RunMetrics }
  | { kind: "phase"; phase: "re-observing" }
  | { kind: "trace"; trace: ActionTrace }
  | { kind: "state"; state: TaskStateSummary };

export interface AgentOutcome {
  /** "unverified": the actions ran but local evidence could not confirm the requested end state. */
  status: "completed" | "unverified" | "blocked" | "failed";
  code: OutcomeCode;
  rounds: number;
  /** Executed actions, "done" included. */
  steps: number;
  message: string;
  /** Whether any request reached the cloud reasoner during this run. */
  cloudContacted: boolean;
  /** Whether any browser action (click, type, press, scroll, navigate) was executed. */
  browserActed: boolean;
}

/** The persistent state of one task run. Survives navigation, re-renders and tab hand-offs. */
interface TaskState {
  task: string;
  goal: GoalKind;
  maxSteps: number;
  maxRecoveries: number;
  maxFailedActions: number;
  step: number;
  cloudContacted: boolean;
  browserActed: boolean;
  /** The reasoner marked the last executed action as completing the task; the next round confirms it. */
  confirmingFinal: boolean;
  /** Next observation may skip capture and OCR (targeted re-observation). */
  lightObservation: boolean;
  /** Value-free page facts per observation, from the sanitized bodies, for completion verification. */
  observations: Array<PageFacts | null>;
  /** Locally rejected "done" records inserted into the history; not steps. */
  rejectedDones: number;
  /** Recovery attempts used: contradicted claims sent back with guidance. */
  recoveries: number;
  /** Failed actions recovered from so far. */
  failedActions: number;
  /** Consequential-policy refusals answered with guidance (at most one per task). */
  policyRecoveries: number;
  /** Stale/ambiguous/occluded target refusals answered by a fresh observation (within a step's round budget). */
  staleRetries: number;
  /** Identical-action proposals answered with guidance instead of execution (at most one per task). */
  repeatWarnings: number;
  /** Controller guidance for the next observation (value-free), or null. */
  guidance: string | null;
  /** Latest completion verdict, for the activity log. */
  completion: CompletionVerdict | null;
}

export async function runAgent(task: string, ports: AgentPorts, options: AgentOptions = {}): Promise<AgentOutcome> {
  const startedAt = ports.now();
  const state: TaskState = {
    task,
    goal: goalOf(task),
    maxSteps: Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS),
    maxRecoveries: Math.max(0, options.maxRecoveries ?? DEFAULT_MAX_RECOVERIES),
    maxFailedActions: Math.max(0, options.maxFailedActions ?? DEFAULT_MAX_FAILED_ACTIONS),
    step: 0,
    cloudContacted: false,
    browserActed: false,
    confirmingFinal: false,
    lightObservation: false,
    observations: [],
    rejectedDones: 0,
    recoveries: 0,
    failedActions: 0,
    policyRecoveries: 0,
    staleRetries: 0,
    repeatWarnings: 0,
    guidance: null,
    completion: null,
  };

  // --- GUARD (local, before anything else) ------------------------------
  const verdict = assessTask(task);
  if (!verdict.safe) {
    ports.report({ kind: "stage", stage: "dom", state: "skipped", detail: "task blocked by the local safety guard" });
    skip(ports, ["vision", "detect", "visual-redaction", "leakage", "firewall", "reason", "validate", "execute"]);
    ports.report({ kind: "status", text: verdict.reason, level: "error" });
    return outcome("blocked", "SAFETY_BLOCK", 0, 0, verdict.reason, state);
  }

  await ports.ensureContentScript();
  const info = await ports.visionInfo().catch(() => null);
  const history: ActionRecord[] = [];
  let totalRounds = 0;
  let previousSignature: string | null = null;
  const recentSignatures: string[] = [];
  let noEffectStreak = 0;

  for (let step = 1; step <= state.maxSteps; step++) {
    state.step = step;
    if (ports.isCancelled?.()) {
      return outcome("blocked", "CANCELLED", totalRounds, history.length, "Task cancelled: a new task was started", state);
    }
    if (step > 1) {
      ports.report({ kind: "phase", phase: "re-observing" });
      ports.report({ kind: "status", text: `Step ${step} (budget ${state.maxSteps}): observing the page again${state.lightObservation ? " (DOM only)" : ""}...`, level: "info" });
      resetStages(ports);
    }
    const stepResult = await runStep(ports, info, history, step, startedAt, state);
    totalRounds += stepResult.rounds;
    if (stepResult.kind === "verified") {
      reportFinal(ports, state, "SUCCESS", stepResult.message);
      return outcome("completed", "COMPLETED", totalRounds, history.length, stepResult.message, state);
    }
    if (stepResult.kind === "recover") {
      // ACTION FAILED (or refused by policy), recovery possible: the reasoner is told and the loop continues.
      if (stepResult.policy) {
        reportState(ports, state, stepResult.action, "blocked", verifyCompletion(task, history, state.observations), "observe and use an allowed path");
      } else {
        state.failedActions++;
        state.guidance = clip(`The last action failed: ${stepResult.message}. It was not performed. Choose a different way to reach the goal (${goalEndState(state.goal)}); attempt ${state.failedActions} of ${state.maxFailedActions}.`);
        reportState(ports, state, stepResult.action, "failed", verifyCompletion(task, history, state.observations), "observe and choose another way");
      }
      state.lightObservation = false;
      if (ports.settle) await ports.settle().catch(() => undefined);
      await ports.ensureContentScript();
      continue;
    }
    if (stepResult.kind !== "executed") {
      reportFinal(ports, state, stepResult.status === "failed" ? "FAILED" : "BLOCKED", stepResult.message);
      return outcome(stepResult.status, stepResult.code, totalRounds, history.length, stepResult.message, state);
    }

    const { record } = stepResult;
    state.guidance = null;
    ports.report({ kind: "step", step, maxSteps: state.maxSteps, action: describeRecord(record) });

    // --- VERIFY (local evidence decides; the model only claims) ----------------
    if (record.action === "done") {
      const stopCode = record.value && DONE_REASON_CODES.has(record.value) ? (record.value as OutcomeCode) : null;
      const claim: "complete" | "blocked" = stopCode ? "blocked" : "complete";
      const completion = verifyCompletion(task, history, state.observations);
      state.completion = completion;
      const lastFacts = [...state.observations].reverse().find((o) => o !== null) ?? null;
      const blocker = assessBlockerClaim(claim === "blocked" ? stepResult.reason : "", lastFacts);
      ports.report({
        kind: "status",
        text: `Completion check (${completion.goal} task): claim=${claim}; ${completion.state.replace("_", " ")}${completion.evidence.length ? `; evidence: ${completion.evidence.join("; ")}` : ""}${completion.missing ? `; missing: ${completion.missing}` : ""}${claim === "blocked" ? `; blocker ${blocker.supported ? "is shown on the current page" : "is NOT shown on the current page"}` : ""}`,
        level: completion.state === "verified" ? "success" : "info",
      });

      if (completion.state === "verified") {
        history.push(record);
        const message = `${stepResult.message}; verified: ${completion.evidence.join("; ")}`;
        reportFinal(ports, state, "SUCCESS", message);
        return outcome("completed", "COMPLETED", totalRounds, history.length, message, state);
      }

      // The goal is not verified. A "done" here is a premature stop unless recovery is exhausted.
      // A data stop (missing data, an unresolved tie) is re-checked once; a blocker or a plain
      // "done" gets the full recovery budget.
      const contradicted = completion.state === "not_complete" || claim === "blocked";
      const dataStop = stopCode === "MISSING_REQUIRED_DATA" || stopCode === "AMBIGUOUS_TARGET";
      const budget = dataStop ? Math.min(1, state.maxRecoveries) : state.maxRecoveries;
      if (contradicted && state.recoveries < budget) {
        state.recoveries++;
        state.rejectedDones++;
        state.lightObservation = true;
        const attempt = `${state.recoveries} of ${state.maxRecoveries}`;
        const why = claim === "blocked"
          ? blocker.supported
            ? `you reported a blocker (${blocker.phrase}) and the current page shows it for the current item, but the task is not complete`
            : "you reported a blocker that the current page does not show"
          : `the task is not complete: ${completion.missing}`;
        state.guidance = clip(`TASK NOT COMPLETE (local check, recovery attempt ${attempt}): ${why}. Do not stop. Recover: go back to the results or search again, choose a different listing or path that satisfies the task, and continue until ${goalEndState(state.goal)}. Report done with a stop code only after recovery fails.`);
        history.push({ action: "done", target: null, value: null, effect: "no_change", note: `done was rejected locally (attempt ${attempt}): ${why}`, synthetic: true });
        ports.report({ kind: "status", text: `The reasoner reported ${claim === "blocked" ? "a blocker" : "done"}, but the goal is not reached: ${why}. Asking it to recover (attempt ${attempt}).`, level: "info" });
        reportState(ports, state, "done (claim)", "success", completion, "recover: re-observe and replan");
        continue;
      }

      history.push(record);
      const acted = history.some((h) => h.action !== "done");
      if (claim === "blocked" && blocker.supported) {
        const message = `Blocked: ${stepResult.reason || blocker.phrase} (shown on the current page; ${state.recoveries} recovery attempt(s) made)`;
        reportFinal(ports, state, "BLOCKED", message);
        return outcome("blocked", "TASK_BLOCKED", totalRounds, history.length, message, state);
      }
      if (dataStop && stopCode) {
        // The reasoner still reports missing data or an unresolved tie after a re-check: surface that reason.
        const message = `Stopped: ${stepResult.reason || completion.missing} (re-checked once; the page offers no way to verify or resolve it)`;
        reportFinal(ports, state, "BLOCKED", message);
        return outcome("blocked", stopCode, totalRounds, history.length, message, state);
      }
      if (claim === "blocked" || (!acted && completion.state === "not_complete")) {
        const message = `Stopped without reaching the goal: ${completion.missing || stepResult.reason} (${state.recoveries} recovery attempt(s) made; the claimed blocker is not shown on the page)`;
        reportFinal(ports, state, "BLOCKED", message);
        return outcome("blocked", "INSUFFICIENT_EVIDENCE", totalRounds, history.length, message, state);
      }
      const message = `Action completed, but the final result could not be verified: ${completion.missing}`;
      reportFinal(ports, state, "UNVERIFIED", message);
      return outcome("unverified", "COMPLETION_UNVERIFIED", totalRounds, history.length, message, state);
    }

    history.push(record);
    state.browserActed = true;

    // ACTION RESULT recorded; TASK RESULT checked locally for the log (never trusted from the model).
    const completion = verifyCompletion(task, history, state.observations);
    state.completion = completion;
    reportState(ports, state, describeRecord(record), "success", completion, completion.state === "verified" ? "observe; the reasoner should confirm done" : "observe and continue toward the goal");

    // A reasoner that repeats itself is not making progress: the identical action twice in a
    // row, or a cycle (A, B, A, B...) in which an action recurs a third time within the recent
    // window. If local evidence already verifies the goal, the loop ends as SUCCESS on that
    // evidence; otherwise it stops as no progress.
    const signature = JSON.stringify({ action: record.action, target: record.target, value: record.value });
    recentSignatures.push(signature);
    if (recentSignatures.length > 8) recentSignatures.shift();
    const repeats = recentSignatures.filter((sig) => sig === signature).length;
    if (signature === previousSignature || repeats >= 3) {
      if (completion.state === "verified") {
        const message = `Goal verified on the page while the reasoner kept repeating actions: ${completion.evidence.join("; ")}`;
        reportFinal(ports, state, "SUCCESS", message);
        return outcome("completed", "COMPLETED", totalRounds, history.length, message, state);
      }
      const message = signature === previousSignature
        ? `Stopped: the reasoner repeated the same action (${describeRecord(record)}) without progress`
        : `Stopped: the reasoner is cycling between the same actions (${describeRecord(record)} recurred ${repeats} times) without reaching the goal`;
      reportFinal(ports, state, "BLOCKED", message);
      return outcome("blocked", "NO_PROGRESS", totalRounds, history.length, message, state);
    }
    previousSignature = signature;
    // The last three records as the history holds them: earlier ones may have been corrected by
    // the next observation (a late render), so a genuine streak is required, not a raw one.
    const tail = history.filter((h) => !h.synthetic && h.action !== "done").slice(-3);
    noEffectStreak = tail.length === 3 && tail.every((h) => h.effect === "no_change") ? 3 : 0;
    if (noEffectStreak >= 3) {
      const message = "Stopped: three actions in a row had no effect on the page";
      reportFinal(ports, state, "BLOCKED", message);
      return outcome("blocked", "NO_PROGRESS", totalRounds, history.length, message, state);
    }

    // "final" is a hint, not a verdict: the resulting page is observed once
    // and the reasoner must confirm with "done" against that evidence.
    state.confirmingFinal = stepResult.final && record.action !== "type";
    if (state.confirmingFinal) ports.report({ kind: "status", text: "The reasoner expects the task to be complete; verifying on the resulting page.", level: "info" });
    state.lightObservation = record.effect === "no_change" || record.action === "type" || record.action === "scroll";

    if (ports.settle) await ports.settle().catch(() => undefined);
    await ports.ensureContentScript();
  }

  const message = `Stopped after ${state.maxSteps} steps (the execution budget) without the goal being verified`;
  reportFinal(ports, state, "BLOCKED", message);
  return outcome("blocked", "STEP_LIMIT", totalRounds, history.length, message, state);
}

type StepResult =
  | { kind: "executed"; rounds: number; record: ActionRecord; message: string; final: boolean; reason: string }
  | { kind: "stopped"; rounds: number; status: "blocked" | "failed"; code: OutcomeCode; message: string }
  /** A refused repeat where local evidence already verifies the goal: the task is complete. */
  | { kind: "verified"; rounds: number; message: string }
  /** The action failed (or was refused by policy) and the budget allows a recovery round. */
  | { kind: "recover"; rounds: number; action: string; message: string; policy?: boolean };

async function runStep(
  ports: AgentPorts,
  info: VisionInfo | null,
  history: ActionRecord[],
  step: number,
  startedAt: number,
  state: TaskState,
): Promise<StepResult> {
  const task = state.task;
  let lastRetryCode: string | undefined;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const metrics: RunMetrics = { round, step, engine: info?.engine, webgpu: info?.webgpu };
    if (round > 1) {
      ports.report({ kind: "phase", phase: "re-observing" });
      ports.report({ kind: "status", text: `Re-observing the page (round ${round} of ${MAX_ROUNDS})...`, level: "info" });
    }

    // A browser start page or internal page cannot be observed: nothing to capture, no content script.
    const urlBefore = ports.pageUrl ? await ports.pageUrl().catch(() => "") : "";
    const offPage = ports.pageUrl && ports.observeOffPage && ports.executeOffPage ? !/^https?:\/\//i.test(urlBefore) : false;
    const light = state.lightObservation && round === 1;

    // --- OBSERVE (local) --------------------------------------------------
    const captureStart = ports.now();
    let captureError: string | null = null;
    const capture = offPage || light ? null : await ports.capture().catch((error: unknown) => {
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
    } else if (offPage) {
      ports.report({ kind: "stage", stage: "vision", state: "skipped", detail: "no web page is open in this tab; nothing to capture" });
      ports.report({ kind: "status", text: "No web page is open in this tab. Asking the reasoner which site to open...", level: "info" });
    } else if (light) {
      ports.report({ kind: "stage", stage: "vision", state: "skipped", detail: "targeted re-observation: the last action changed a field or nothing on the page; DOM only" });
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
    const constraints = taskConstraintsGuidance(task);
    const guidance = [constraints, state.guidance ?? ""].filter(Boolean).join(" ").slice(0, MAX_GUIDANCE_LENGTH) || undefined;
    let extracted = offPage && ports.observeOffPage ? await ports.observeOffPage(task, history, guidance) : await extractWithRetry(ports, task, ocr, history, guidance);
    metrics.privacyMs = round1(ports.now() - privacyStart);
    if (!extracted.ok) {
      ports.report({ kind: "stage", stage: "dom", state: "fail", detail: extracted.error });
      return stopped(round, "failed", "PAGE_UNAVAILABLE", `Page extraction failed: ${extracted.error}`);
    }
    ports.report({ kind: "stage", stage: "dom", state: "pass", detail: describeDetections(extracted.summary.detections.length, extracted.summary.placeholders.length) });
    ports.report({ kind: "stage", stage: "detect", state: "pass", detail: describePlaceholders(extracted.summary.placeholders, extracted.summary.types) });
    ports.report({ kind: "status", text: describePrivacy(extracted.summary.placeholders, extracted.summary.types), level: "success" });

    const visualPrivacy = extracted.visualPrivacy;
    const images = capture ? scaleRegions(extracted.imageRegions ?? [], capture.devicePixelRatio) : [];
    if (visualPrivacy) {
      metrics.observationsSent = visualPrivacy.observationsSent;
      metrics.maskRegions = visualPrivacy.maskRegions.length;
      const detail = `${visualPrivacy.maskRegions.length} region(s) masked; ${visualPrivacy.observationsSent} observation(s) kept; ` +
        `${visualPrivacy.fusion.duplicatesDropped} duplicate(s) dropped; ${visualPrivacy.fusion.buttonsMapped} button(s) mapped` +
        (visualPrivacy.conflicts.length ? `; ${visualPrivacy.conflicts.length} conflict(s), DOM preferred` : "");
      ports.report({ kind: "stage", stage: "visual-redaction", state: "pass", detail });
      if (capture) {
        const masked = await ports.renderMask(capture, visualPrivacy.maskRegions.map((r) => r.bbox), images).catch(() => null);
        ports.report({ kind: "preview", rawDataUrl: capture.dataUrl, maskedDataUrl: masked, maskCount: visualPrivacy.maskRegions.length, imageCount: images.length });
      }
    } else {
      ports.report({ kind: "stage", stage: "visual-redaction", state: "skipped", detail: "no visual observations this round" });
      if (capture) {
        // No OCR this round, but the preview must still be rendered for the popup.
        const masked = await ports.renderMask(capture, [], images).catch(() => null);
        ports.report({ kind: "preview", rawDataUrl: capture.dataUrl, maskedDataUrl: masked, maskCount: 0, imageCount: images.length });
      }
    }

    const { firewall } = extracted;
    const checks = firewall.checks.map((c) => `${c.name}:${c.passed ? "pass" : "fail"}`).join(" ");
    if (firewall.verdict === "blocked") {
      ports.report({ kind: "stage", stage: "leakage", state: "fail", detail: checks });
      ports.report({ kind: "stage", stage: "firewall", state: "fail", detail: "REQUEST BLOCKED" });
      skip(ports, ["reason", "validate", "execute"]);
      return stopped(round, "blocked", "PRIVACY_BLOCK", firewall.reason);
    }
    ports.report({ kind: "stage", stage: "leakage", state: "pass", detail: checks });
    ports.report({ kind: "stage", stage: "firewall", state: "pass", detail: "REQUEST ALLOWED" });
    ports.report({ kind: "payload", body: firewall.body });
    const pageFacts = describePage(firewall.body);
    if (pageFacts) ports.report({ kind: "page", ...pageFacts });
    state.observations.push(pageFactsFromBody(firewall.body));
    if (reconcileLastEffect(history, state) && !offPage) {
      // The history the request was built from said "no change"; the page proves otherwise.
      // Re-extract locally (no cloud call) so the reasoner sees the corrected history.
      const again = await extractWithRetry(ports, task, ocr, history, guidance);
      if (again.ok && again.firewall.verdict === "allowed") {
        extracted = again;
        state.observations[state.observations.length - 1] = pageFactsFromBody(again.firewall.body);
      }
    }

    // --- REASON (cloud, sanitized bytes only) ------------------------------
    ports.report({ kind: "stage", stage: "reason", state: "pending" });
    ports.report({ kind: "status", text: "Sending sanitized request to backend...", level: "info" });
    const reasonStart = ports.now();
    let raw: unknown;
    try {
      state.cloudContacted = true;
      raw = await ports.reason(firewall.body);
    } catch (error) {
      const message = describe(error);
      const code = classifyError(message);
      if (code === "INVALID_MODEL_RESPONSE" && round < MAX_ROUNDS) {
        ports.report({ kind: "stage", stage: "reason", state: "fail", detail: message });
        ports.report({ kind: "status", text: "The reasoner returned an unusable action. Observing again.", level: "error" });
        continue;
      }
      ports.report({ kind: "stage", stage: "reason", state: "fail", detail: message });
      skip(ports, ["validate", "execute"]);
      return stopped(round, "failed", code, message);
    }
    metrics.reasonMs = round1(ports.now() - reasonStart);
    ports.report({ kind: "stage", stage: "reason", state: "pass", detail: "structured action received" });
    ports.report({ kind: "status", text: `Action received: ${describeRaw(raw)}`, level: "info" });

    // The exact action just executed, proposed again: not performed. The reasoner is told what
    // that action already did and asked for the NEXT step; a second identical proposal ends the run.
    const proposed = signatureOf(raw);
    const previous = history[history.length - 1];
    if (previous && !previous.synthetic && previous.action !== "done" && proposed === signatureOf(previous) && state.repeatWarnings < 1 && round < MAX_ROUNDS) {
      state.repeatWarnings++;
      state.guidance = clip(`You proposed the same action you just performed (${describeRecord(previous)}); its effect was "${previous.effect ?? "unknown"}". It was not repeated. Do the NEXT step toward ${goalEndState(state.goal)} (for a typed search: submit it; for an opened item: use its controls).`);
      ports.report({ kind: "status", text: `The reasoner repeated its previous action; not repeating it. Asking for the next step.`, level: "info" });
      continue;
    }

    // --- VALIDATE + EXECUTE (content script) --------------------------------
    ports.report({ kind: "stage", stage: "validate", state: "pending" });
    const executeStart = ports.now();
    let result: ExecuteActionResult;
    try {
      result = offPage && ports.executeOffPage ? await ports.executeOffPage(raw) : await ports.execute(raw, history);
    } catch (error) {
      // The content script did not answer. If the page navigated away, the click
      // that caused it did run (the executor acts before it watches); otherwise
      // nothing can be assumed to have happened.
      const message = describe(error);
      // Give a navigation the action may have started time to commit before judging.
      if (ports.settle) await ports.settle().catch(() => undefined);
      const urlAfter = ports.pageUrl ? await ports.pageUrl().catch(() => "") : "";
      if (isClickLike(raw) && urlBefore && urlAfter && urlAfter !== urlBefore) {
        result = { ok: true, message: "Action executed; the page navigated", validation: "pass", postAction: { effect: "url_changed", mutations: 0, urlChanged: true, titleChanged: false, controlsChanged: true, modalAppeared: false, modalClosed: false, waitedMs: 0 } };
      } else {
        ports.report({ kind: "stage", stage: "execute", state: "fail", detail: message });
        return stopped(round, "failed", classifyError(message), `The page could not be reached to perform the action: ${message}`);
      }
    }
    metrics.executeMs = round1(ports.now() - executeStart);
    metrics.totalMs = round1(ports.now() - startedAt);
    metrics.stepsTotal = history.length + (result.ok ? 1 : 0);
    ports.report({ kind: "metrics", metrics });
    if (result.trace) ports.report({ kind: "trace", trace: { ...result.trace, reobserve: result.ok && !isDone(raw) ? "YES" : "NO", final: result.ok ? (isDone(raw) ? "DONE" : "CONTINUE") : result.validation === "blocked" ? "BLOCKED" : "FAILED" } });

    if (result.validation === "blocked") {
      ports.report({ kind: "stage", stage: "validate", state: "fail", detail: result.message });
      const retryable = result.code !== undefined && RETRYABLE_VALIDATION.has(result.code);
      if (retryable && round < MAX_ROUNDS) {
        lastRetryCode = result.code;
        state.staleRetries++;
        // Tell the reasoner why the action was refused so the re-observation can replan, not repeat.
        state.guidance = clip(
          result.code === "target_occluded"
            ? `The last action was refused: ${result.message}. A dialog or overlay is in front of that control. Deal with the overlay first: use a control inside it, or close it (a close, cancel or × control), then continue toward ${goalEndState(state.goal)}.`
            : `The last action was refused: ${result.message}. The page changed since it was observed; pick the target again from the current elements.`,
        );
        ports.report({ kind: "status", text: `Action stopped by the local validator: ${result.message}. The page may have changed; re-observing.`, level: "error" });
        continue;
      }
      skip(ports, ["execute"]);
      if (result.code === "consequential_action" && state.policyRecoveries < 1) {
        // The click was refused and never performed. The task may still be reachable through a
        // control it does authorise; the reasoner is told once, then the policy ends the run.
        state.policyRecoveries++;
        state.guidance = clip(`The last action was refused by the local policy and NOT performed: ${result.message}. That control needs an authorisation the task does not give. Use only what the task allows (for a checkout task: the cart's proceed-to-checkout control; never a place-order or payment control), and continue toward ${goalEndState(state.goal)}. If no allowed path exists, report done with a stop code.`);
        return { kind: "recover", rounds: round, action: describeRaw(raw), message: result.message, policy: true };
      }
      if (result.code === "repeated_action") {
        // The reasoner wanted to repeat a cart add the page already accepted. Local evidence
        // owns the result: when the cart goal is verified, the task is complete without it.
        const verdict = verifyCompletion(task, history, state.observations);
        ports.report({ kind: "status", text: `Completion check (${verdict.goal} task) after a refused repeat: ${verdict.state.replace("_", " ")}${verdict.evidence.length ? `; evidence: ${verdict.evidence.join("; ")}` : ""}`, level: verdict.state === "verified" ? "success" : "info" });
        if (verdict.state === "verified") return { kind: "verified", rounds: round, message: `Repeated add refused; the goal is already verified: ${verdict.evidence.join("; ")}` };
      }
      const code = outcomeForValidation(result.code === "action_failed" ? undefined : result.code);
      return stopped(round, "blocked", code, `Action blocked by local validator: ${result.message}`);
    }
    ports.report({ kind: "stage", stage: "validate", state: "pass", detail: "action verified against the live page" });

    if (!result.ok) {
      ports.report({ kind: "stage", stage: "execute", state: "fail", detail: result.message });
      if (state.failedActions < state.maxFailedActions) {
        ports.report({ kind: "status", text: `Action failed: ${result.message}. Recovering (attempt ${state.failedActions + 1} of ${state.maxFailedActions}).`, level: "error" });
        return { kind: "recover", rounds: round, action: describeRaw(raw), message: result.message };
      }
      return stopped(round, "failed", "ACTION_FAILED", `Action failed: ${result.message}`);
    }
    if (result.navigateTo) {
      if (!ports.navigate) {
        ports.report({ kind: "stage", stage: "execute", state: "fail", detail: "navigation is not available in this host" });
        return stopped(round, "failed", "UNSUPPORTED_ACTION", "Navigation is not available in this host");
      }
      ports.report({ kind: "status", text: `Opening ${hostOf(result.navigateTo)}...`, level: "info" });
      try {
        await ports.navigate(result.navigateTo);
      } catch (error) {
        ports.report({ kind: "stage", stage: "execute", state: "fail", detail: describe(error) });
        return stopped(round, "failed", "PAGE_UNAVAILABLE", `Navigation failed: ${describe(error)}`);
      }
    }
    const effect: ActionEffect = result.navigateTo ? "url_changed" : result.postAction?.effect ?? (isDone(raw) ? "no_change" : "unknown");
    ports.report({ kind: "stage", stage: "execute", state: "pass", detail: `${result.message}${result.postAction ? ` (${describeEffect(result.postAction.effect)})` : ""}` });
    ports.report({ kind: "status", text: `Action executed: ${result.message}${result.postAction ? `; page: ${describeEffect(result.postAction.effect)}` : ""}`, level: "success" });
    return { kind: "executed", rounds: round, record: toRecord(raw, effect, result.note, result.trace?.target, result.cartEvidence?.added, result.trace?.context), message: result.message, final: isFinal(raw), reason: reasonOf(raw) };
  }

  const code = lastRetryCode === "ambiguous_target" ? "AMBIGUOUS_TARGET" : lastRetryCode === "target_occluded" ? "TARGET_OCCLUDED" : lastRetryCode ? "STALE_TARGET" : "INVALID_MODEL_RESPONSE";
  return stopped(MAX_ROUNDS, "blocked", code, `Stopped after ${MAX_ROUNDS} observation rounds without a valid action`);

  function stopped(rounds: number, status: "blocked" | "failed", code: OutcomeCode, message: string): StepResult {
    return { kind: "stopped", rounds, status, code, message };
  }
}

/**
 * Real pages sometimes navigate or reload while the content script is
 * extracting (the message channel closes with no reply). Wait for the tab to
 * settle and try once more before giving up; the retry is a fresh extraction,
 * never a reuse of partial data.
 */
async function extractWithRetry(ports: AgentPorts, task: string, ocr: OcrResult | null, history: ActionRecord[], guidance: string | undefined): Promise<ExtractPageResult> {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await ports.extract(task, ocr, history, guidance);
    } catch (error) {
      lastError = describe(error);
      if (attempt === 2) break;
      ports.report({ kind: "status", text: `Page changed during observation (${lastError}); waiting for it to settle and observing again.`, level: "info" });
      if (ports.settle) await ports.settle().catch(() => undefined);
      await ports.ensureContentScript().catch(() => undefined);
    }
  }
  return { ok: false, error: lastError };
}

/**
 * The executor watches the page for a bounded time; a slow render can land
 * after that window, so an action is recorded as "no change" although the
 * next observation plainly differs from the one the action was chosen from.
 * Local evidence corrects the record before the reasoner sees the history.
 */
function reconcileLastEffect(history: ActionRecord[], state: TaskState): boolean {
  const last = history[history.length - 1];
  const observations = state.observations;
  if (!last || last.synthetic || last.action === "done" || observations.length < 2) return false;
  if (last.effect !== "no_change" && last.effect !== "unknown") return false;
  const before = observations[observations.length - 2];
  const after = observations[observations.length - 1];
  if (!before || !after) return false;
  let corrected: ActionEffect | null = null;
  if (after.url !== before.url) corrected = "url_changed";
  else if (after.title !== before.title || after.labels.join("|") !== before.labels.join("|")) corrected = "dom_changed";
  if (!corrected) return false;
  last.effect = corrected;
  const note = "the page had changed by the next observation (late render)";
  last.note = last.note ? `${last.note}; ${note}` : note;
  return true;
}

// --- activity log ------------------------------------------------------------------

function reportState(ports: AgentPorts, state: TaskState, action: string, actionResult: TaskStateSummary["actionResult"], completion: CompletionVerdict, next: string): void {
  const last = [...state.observations].reverse().find((o) => o !== null) ?? null;
  ports.report({
    kind: "state",
    state: {
      step: state.step,
      maxSteps: state.maxSteps,
      goal: state.goal,
      page: hostOf(last?.url ?? ""),
      action,
      actionResult,
      taskResult: completion.state === "verified" ? "verified complete" : completion.state === "unverified" ? "unverified" : "not complete",
      taskDetail: completion.state === "verified" ? completion.evidence.join("; ") : completion.missing,
      next,
      recoveries: state.recoveries,
      failedActions: state.failedActions,
    },
  });
}

function reportFinal(ports: AgentPorts, state: TaskState, result: "SUCCESS" | "BLOCKED" | "FAILED" | "UNVERIFIED", reason: string): void {
  ports.report({ kind: "status", text: `TASK RESULT: ${result} · step ${state.step} of budget ${state.maxSteps} · recoveries ${state.recoveries} · stale-target retries ${state.staleRetries} · REASON: ${reason}`, level: result === "SUCCESS" ? "success" : result === "UNVERIFIED" ? "info" : "error" });
}

function clip(text: string): string {
  return text.length > MAX_GUIDANCE_LENGTH ? `${text.slice(0, MAX_GUIDANCE_LENGTH - 1)}…` : text;
}

function outcome(status: AgentOutcome["status"], code: OutcomeCode, rounds: number, steps: number, message: string, state: TaskState): AgentOutcome {
  return { status, code, rounds, steps: steps - state.rejectedDones, message, cloudContacted: state.cloudContacted, browserActed: state.browserActed };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

function skip(ports: AgentPorts, stages: PipelineStage[]): void {
  for (const stage of stages) ports.report({ kind: "stage", stage, state: "skipped" });
}

function resetStages(ports: AgentPorts): void {
  for (const stage of ["dom", "vision", "detect", "visual-redaction", "leakage", "firewall", "reason", "validate", "execute"] as PipelineStage[]) {
    ports.report({ kind: "stage", stage, state: "pending" });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeEffect(effect: ActionEffect): string {
  switch (effect) {
    case "url_changed":
      return "URL changed";
    case "dom_changed":
      return "page content changed";
    case "no_change":
      return "no visible change";
    default:
      return "effect unknown";
  }
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

/**
 * Facts about the page for the popup, read back from the approved (sanitized)
 * body so the popup only ever sees what the cloud sees, never raw text.
 */
function describePage(body: string): { title: string; host: string; elements: number; placeholders: number; visualObservations: number } | null {
  try {
    const parsed = JSON.parse(body) as { page?: { url?: string; title?: string; elements?: unknown[] }; placeholders?: unknown[]; visual?: { observations?: unknown[] } | null };
    const page = parsed.page ?? {};
    let host = "";
    try {
      host = new URL(page.url ?? "").host;
    } catch {
      host = "";
    }
    return {
      title: (page.title ?? "").slice(0, 120),
      host,
      elements: Array.isArray(page.elements) ? page.elements.length : 0,
      placeholders: Array.isArray(parsed.placeholders) ? parsed.placeholders.length : 0,
      visualObservations: Array.isArray(parsed.visual?.observations) ? parsed.visual.observations.length : 0,
    };
  } catch {
    return null;
  }
}

/**
 * The executed action as a history record. Only read after the validator
 * passed it, so the fields are the contract's; anything odd becomes null.
 */
function toRecord(raw: unknown, effect: ActionEffect, note: string | undefined, label: string | undefined, cartAdded: boolean | undefined, context: string | undefined): ActionRecord {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action : "done";
  return {
    action: action as ActionRecord["action"],
    target: typeof record.target === "string" ? record.target : null,
    value: typeof record.value === "string" ? record.value : null,
    effect,
    ...(note ? { note } : {}),
    ...(label ? { label } : {}),
    ...(cartAdded ? { cartAdded } : {}),
    ...(context ? { context } : {}),
  };
}

/** The reasoner marked this action as completing the task. Read only after validation. */
function isFinal(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).final === true;
}

function isDone(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).action === "done";
}

function isClickLike(raw: unknown): boolean {
  const action = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).action : undefined;
  return action === "click" || action === "press";
}

/** The reasoner's stated reason (model output, used locally for the log and the blocker check only). */
function reasonOf(raw: unknown): string {
  const reason = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).reason : undefined;
  return typeof reason === "string" ? reason.slice(0, 300) : "";
}

/** Action identity for repeat detection: kind, target and value. */
function signatureOf(raw: unknown): string {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return JSON.stringify({ action: r.action ?? null, target: typeof r.target === "string" ? r.target : null, value: typeof r.value === "string" ? r.value : null });
}

function describeRecord(record: ActionRecord): string {
  return `${record.action}${record.target ? ` ${record.target}` : ""}${record.value !== null ? ` "${record.value.slice(0, 40)}"` : ""}`;
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
