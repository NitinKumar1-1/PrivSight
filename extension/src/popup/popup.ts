/**
 * Popup script. The user's natural-language task enters here and goes to
 * the Local Browser Controller in the service worker. The popup renders the
 * controller's events: one status word, the pipeline panel, page facts, the
 * locally masked preview, measured metrics and the sanitized payload.
 *
 * The last task is remembered in chrome.storage.local for convenience only.
 * It is never run automatically and goes through the same sanitization as a
 * freshly typed task.
 */

import {
  RUN_LOG_KEY,
  type GetRunLogMessage,
  type OutcomeMessage,
  type PageMessage,
  type PipelineStage,
  type RunLog,
  type RunMetrics,
  type RunTaskMessage,
  type RuntimeMessage,
  type StageMessage,
  type StatusMessage,
} from "../shared/messages";
import { nextState, stateHint, stateKind, TERMINAL_STATES, type AgentState } from "./state";

const STAGES: PipelineStage[] = ["dom", "vision", "visual-redaction", "detect", "leakage", "firewall", "reason", "validate", "execute"];
const LAST_TASK_KEY = "lastTask";
const MAX_TASK_LENGTH = 500;

const taskInput = document.getElementById("task") as HTMLTextAreaElement;
const runButton = document.getElementById("run") as HTMLButtonElement;
const statusList = document.getElementById("status") as HTMLUListElement;
const payloadView = document.getElementById("payload") as HTMLPreElement;
const badge = document.getElementById("privacy-badge") as HTMLSpanElement;
const stateBox = document.getElementById("agent-state") as HTMLDivElement;
const stateWord = document.getElementById("state-word") as HTMLElement;
const stateHintEl = document.getElementById("state-hint") as HTMLSpanElement;
const stateFactsEl = document.getElementById("state-facts") as HTMLSpanElement;
const pageInfo = document.getElementById("page-info") as HTMLParagraphElement;
const maskedPreview = document.getElementById("preview-masked") as HTMLImageElement;
const previewEmpty = document.getElementById("preview-empty") as HTMLDivElement;
const previewNote = document.getElementById("preview-note") as HTMLParagraphElement;
const metricsList = document.getElementById("metrics") as HTMLDListElement;

let agentState: AgentState = "Idle";
/** The run whose messages this popup shows; lines from an older, cancelled run are ignored. */
let currentRunId: string | null = null;

restoreLastTask();
restoreRunLog();

runButton.addEventListener("click", async () => {
  const task = taskInput.value.trim().slice(0, MAX_TASK_LENGTH);
  if (!task) {
    appendStatus("Enter a task first", "error");
    taskInput.focus();
    return;
  }

  clearRun();
  runButton.disabled = true;
  rememberTask(task);

  const message: RunTaskMessage = { type: "RUN_TASK", task };
  try {
    const response = (await chrome.runtime.sendMessage(message)) as { ok?: boolean; error?: string } | undefined;
    if (response && response.ok === false && !TERMINAL_STATES.has(agentState)) setState("Failed", "The run could not finish.");
  } catch (error) {
    appendStatus(error instanceof Error ? error.message : String(error), "error");
    if (!TERMINAL_STATES.has(agentState)) setState("Failed");
  } finally {
    runButton.disabled = false;
  }
});

// Full-size view of the masked preview: an extension page that reads the same
// locally stored image. The picture never leaves the browser.
maskedPreview.addEventListener("click", () => {
  if (!maskedPreview.src) return;
  chrome.tabs.create({ url: chrome.runtime.getURL("preview/preview.html") }).catch(() => undefined);
});

taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) runButton.click();
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  handleMessage(message);
});

/** Empties every panel for a new run (or before replaying a run in progress). */
function clearRun(): void {
  statusList.replaceChildren();
  payloadView.textContent = "(waiting for the sanitized context)";
  metricsList.replaceChildren();
  maskedPreview.removeAttribute("src");
  maskedPreview.hidden = true;
  previewEmpty.hidden = false;
  previewNote.textContent = "";
  pageInfo.textContent = "";
  resetPipeline();
  setState("Observing");
}

/**
 * The popup closes whenever the browser switches tabs, but the run continues
 * in the service worker. On open, replay what the run has sent so far so the
 * user sees where the agent is instead of an empty panel.
 */
async function restoreRunLog(): Promise<void> {
  let log: RunLog | undefined;
  try {
    const response = (await chrome.runtime.sendMessage({ type: "GET_RUN_LOG" } satisfies GetRunLogMessage).catch(() => undefined)) as { log?: RunLog } | undefined;
    log = response?.log;
    if (!log?.messages?.length) {
      const items = await chrome.storage?.session?.get(RUN_LOG_KEY).catch(() => undefined);
      log = items?.[RUN_LOG_KEY] as RunLog | undefined;
    }
  } catch {
    return;
  }
  if (!log || !Array.isArray(log.messages) || log.messages.length === 0) return;
  if (log.task && !taskInput.value) taskInput.value = log.task.slice(0, MAX_TASK_LENGTH);
  currentRunId = log.runId ?? null;
  clearRun();
  for (const message of log.messages) handleMessage(message);
}

function handleMessage(message: RuntimeMessage): void {
  if (!("type" in message)) return;
  switch (message.type) {
    case "RUN_STARTED":
      // A run started while another was shown: the old one was cancelled by the worker; show only the new one.
      if (currentRunId !== null && currentRunId !== message.runId) clearRun();
      currentRunId = message.runId;
      appendStatus(`TASK: ${message.task} · execution budget ${message.maxSteps} steps (a limit, not a plan)`, "info");
      break;
    case "STATE": {
      const s = message.state;
      const item = document.createElement("li");
      item.className = "state-line";
      item.textContent = [
        `STEP ${s.step} of budget ${s.maxSteps} · GOAL ${s.goal} · PAGE ${s.page || "(no page)"}`,
        `ACTION ${s.action} → ACTION RESULT ${s.actionResult}`,
        `TASK RESULT ${s.taskResult}${s.taskDetail ? ` (${s.taskDetail})` : ""}`,
        `NEXT ${s.next}${s.recoveries ? ` · recoveries ${s.recoveries}` : ""}${s.failedActions ? ` · failed actions ${s.failedActions}` : ""}`,
      ].join("\n");
      statusList.appendChild(item);
      statusList.scrollTop = statusList.scrollHeight;
      break;
    }
    case "STATUS":
      appendStatus(message.text, message.level);
      break;
    case "SANITIZED_PAYLOAD":
      payloadView.textContent = message.json;
      break;
    case "STAGE":
      renderStage(message);
      break;
    case "PAGE":
      renderPage(message);
      break;
    case "PREVIEW":
      if (message.maskedDataUrl) {
        maskedPreview.src = message.maskedDataUrl;
        maskedPreview.hidden = false;
        previewEmpty.hidden = true;
      }
      {
        previewNote.textContent = (message.maskCount > 0
          ? `${message.maskCount} sensitive region(s) masked locally before anything was sent. Everything else on screen is ordinary content the reasoner may read as text.`
          : "No sensitive screen regions were found in this capture.") +
          ` The cloud receives text observations only, never pixels${message.imageCount ? ` (${message.imageCount} picture(s) on screen stay on this device)` : ""}.`;
      }
      break;
    case "METRICS":
      renderMetrics(message.metrics);
      break;
    case "PHASE":
      if (message.phase === "re-observing" && !TERMINAL_STATES.has(agentState)) setState("Re-observing");
      break;
    case "OUTCOME":
      renderOutcome(message);
      break;
  }
}

/** The run's end, in user-facing words plus the two facts that matter. Technical detail goes to the console only. */
function renderOutcome(message: OutcomeMessage): void {
  const BLOCKED_CODES = new Set(["SAFETY_BLOCK", "PRIVACY_BLOCK", "STALE_TARGET", "TARGET_OCCLUDED", "AMBIGUOUS_TARGET", "MISSING_REQUIRED_DATA", "INSUFFICIENT_EVIDENCE", "NO_PROGRESS", "REPEATED_ACTION", "TASK_BLOCKED", "CANCELLED", "STEP_LIMIT"]);
  const state: AgentState = message.code === "COMPLETED" ? "Complete" : message.code === "COMPLETION_UNVERIFIED" ? "Unverified" : BLOCKED_CODES.has(message.code) ? "Blocked" : "Failed";
  setState(state, message.message, `${message.title} · Cloud: ${message.cloudContacted ? "Contacted" : "Not contacted"} · Browser action: ${message.browserActed ? "Executed" : "None"}`);
  if (message.code === "SAFETY_BLOCK" || message.code === "PRIVACY_BLOCK") setBadge(message.code === "SAFETY_BLOCK" ? "TASK BLOCKED" : "REQUEST BLOCKED", "blocked");
  if (message.detail) console.debug("[PrivSight] outcome detail:", message.detail);
}

function appendStatus(text: string, level: StatusMessage["level"]): void {
  const item = document.createElement("li");
  item.textContent = text;
  item.className = level;
  statusList.appendChild(item);
  statusList.scrollTop = statusList.scrollHeight;
}

function resetPipeline(): void {
  for (const stage of STAGES) setStage(stage, "pending", "");
  setBadge("CHECKING", "idle");
}

function renderStage(message: StageMessage): void {
  setStage(message.stage, message.state, message.detail ?? "");
  setState(nextState(agentState, message.stage, message.state));
  if (message.stage === "firewall" && message.state === "pass") setBadge("PROTECTED", "ok");
  if (message.stage === "firewall" && message.state === "fail") setBadge("REQUEST BLOCKED", "blocked");
  if (message.stage === "validate" && message.state === "fail") setBadge("ACTION BLOCKED", "blocked");
}

function renderPage(message: PageMessage): void {
  pageInfo.replaceChildren();
  const where = document.createElement("b");
  where.textContent = message.title || message.host || "current page";
  pageInfo.append("Page: ", where);
  if (message.host && message.title) pageInfo.append(` (${message.host})`);
  pageInfo.append(` · ${message.elements} interactive element(s) · ${message.placeholders} value(s) redacted · ${message.visualObservations} visual observation(s)`);
}

function setStage(stage: PipelineStage, state: string, detail: string): void {
  const row = document.querySelector<HTMLLIElement>(`#pipeline li[data-stage="${stage}"]`);
  if (!row) return;
  row.dataset.state = state;
  const stateCell = row.querySelector<HTMLSpanElement>(".state-cell");
  if (stateCell) {
    stateCell.textContent = state === "pending" && detail === "" && agentState !== "Idle" ? "WORKING" : state.toUpperCase();
    stateCell.classList.toggle("live", state === "pending");
  }
  row.title = detail;
}

function setState(state: AgentState, hint?: string, facts = ""): void {
  agentState = state;
  stateBox.dataset.kind = stateKind(state);
  stateWord.textContent = state;
  stateHintEl.textContent = hint ?? stateHint(state);
  stateFactsEl.textContent = facts;
}

function setBadge(text: string, kind: "idle" | "ok" | "blocked"): void {
  badge.textContent = text;
  badge.className = `badge ${kind}`;
}

function renderMetrics(metrics: RunMetrics): void {
  const rows: Array<[string, string | undefined]> = [
    ["Step", metrics.step !== undefined ? `${metrics.step}${metrics.stepsTotal !== undefined ? ` (${metrics.stepsTotal} executed)` : ""}` : undefined],
    ["Round", String(metrics.round)],
    ["Vision engine", metrics.engine],
    ["WebGPU", metrics.webgpu],
    ["Capture", ms(metrics.captureMs)],
    ["OCR load", ms(metrics.ocrLoadMs)],
    ["OCR recognize", ms(metrics.ocrRecognizeMs)],
    ["Local perception", ms(metrics.perceptionMs)],
    ["Privacy processing", ms(metrics.privacyMs)],
    ["Cloud reasoning", ms(metrics.reasonMs)],
    ["Validate + execute", ms(metrics.executeMs)],
    ["Total", ms(metrics.totalMs)],
    ["JS heap (vision doc)", metrics.usedJsHeapMb !== undefined ? `${metrics.usedJsHeapMb} MB` : undefined],
    ["OCR lines", metrics.ocrLines !== undefined ? String(metrics.ocrLines) : undefined],
    ["Observations sent", metrics.observationsSent !== undefined ? String(metrics.observationsSent) : undefined],
    ["Regions masked", metrics.maskRegions !== undefined ? String(metrics.maskRegions) : undefined],
  ];
  metricsList.replaceChildren();
  for (const [label, value] of rows) {
    if (value === undefined) continue;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    metricsList.append(dt, dd);
  }
}

function ms(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${Math.round(value)} ms`;
}

/** Prefills the field with the last task. Never runs it. */
function restoreLastTask(): void {
  try {
    chrome.storage?.local?.get(LAST_TASK_KEY).then((items) => {
      const last = items?.[LAST_TASK_KEY];
      if (typeof last === "string" && !taskInput.value) taskInput.value = last.slice(0, MAX_TASK_LENGTH);
    }).catch(() => undefined);
  } catch {
    // storage unavailable: nothing to restore
  }
}

function rememberTask(task: string): void {
  try {
    chrome.storage?.local?.set({ [LAST_TASK_KEY]: task }).catch(() => undefined);
  } catch {
    // storage unavailable: nothing to remember
  }
}
