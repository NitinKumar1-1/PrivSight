/**
 * Popup script. Sends the task to the local agent (service worker) and
 * renders status lines, the pipeline panel, local previews, measured
 * metrics and the sanitized payload.
 */

import type {
  PipelineStage,
  RunMetrics,
  RunTaskMessage,
  RuntimeMessage,
  StageMessage,
  StatusMessage,
} from "../shared/messages";

const STAGES: PipelineStage[] = ["dom", "vision", "visual-redaction", "detect", "leakage", "firewall", "reason", "validate", "execute"];

const taskInput = document.getElementById("task") as HTMLTextAreaElement;
const runButton = document.getElementById("run") as HTMLButtonElement;
const statusList = document.getElementById("status") as HTMLUListElement;
const payloadView = document.getElementById("payload") as HTMLPreElement;
const badge = document.getElementById("privacy-badge") as HTMLSpanElement;
const rawPreview = document.getElementById("preview-raw") as HTMLImageElement;
const maskedPreview = document.getElementById("preview-masked") as HTMLImageElement;
const previewNote = document.getElementById("preview-note") as HTMLParagraphElement;
const metricsList = document.getElementById("metrics") as HTMLDListElement;

runButton.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    appendStatus("Enter a task first", "error");
    return;
  }

  statusList.replaceChildren();
  payloadView.textContent = "(waiting for extraction)";
  metricsList.replaceChildren();
  rawPreview.removeAttribute("src");
  maskedPreview.removeAttribute("src");
  previewNote.textContent = "";
  resetPipeline();
  runButton.disabled = true;

  const message: RunTaskMessage = { type: "RUN_TASK", task };
  try {
    await chrome.runtime.sendMessage(message);
  } catch (error) {
    appendStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    runButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (!("type" in message)) return;
  switch (message.type) {
    case "STATUS":
      appendStatus(message.text, message.level);
      break;
    case "SANITIZED_PAYLOAD":
      payloadView.textContent = message.json;
      break;
    case "STAGE":
      renderStage(message);
      break;
    case "PREVIEW":
      if (message.rawDataUrl) rawPreview.src = message.rawDataUrl;
      if (message.maskedDataUrl) maskedPreview.src = message.maskedDataUrl;
      previewNote.textContent = `${message.maskCount} region(s) masked locally. These images never leave the browser.`;
      break;
    case "METRICS":
      renderMetrics(message.metrics);
      break;
  }
});

function appendStatus(text: string, level: StatusMessage["level"]): void {
  const item = document.createElement("li");
  item.textContent = text;
  item.className = level;
  statusList.appendChild(item);
}

function resetPipeline(): void {
  for (const stage of STAGES) setStage(stage, "pending", "");
  setBadge("CHECKING", "idle");
}

function renderStage(message: StageMessage): void {
  setStage(message.stage, message.state, message.detail ?? "");
  if (message.stage === "firewall" && message.state === "pass") setBadge("PROTECTED", "ok");
  if (message.stage === "firewall" && message.state === "fail") setBadge("REQUEST BLOCKED", "blocked");
  if (message.stage === "validate" && message.state === "fail") setBadge("ACTION BLOCKED", "blocked");
}

function setStage(stage: PipelineStage, state: string, detail: string): void {
  const row = document.querySelector<HTMLLIElement>(`#pipeline li[data-stage="${stage}"]`);
  if (!row) return;
  row.dataset.state = state;
  const stateCell = row.querySelector<HTMLSpanElement>(".state");
  if (stateCell) stateCell.textContent = state.toUpperCase();
  row.title = detail;
}

function setBadge(text: string, kind: "idle" | "ok" | "blocked"): void {
  badge.textContent = text;
  badge.className = `badge ${kind}`;
}

function renderMetrics(metrics: RunMetrics): void {
  const rows: Array<[string, string | undefined]> = [
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
