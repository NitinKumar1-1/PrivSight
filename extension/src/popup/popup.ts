/**
 * Popup script. Sends the task to the service worker and renders status
 * lines, the pipeline stage panel and the sanitized payload.
 */

import type {
  PipelineStage,
  RunTaskMessage,
  RuntimeMessage,
  StageMessage,
  StatusMessage,
} from "../shared/messages";

const STAGES: PipelineStage[] = ["detect", "leakage", "firewall", "reason", "validate", "execute"];

const taskInput = document.getElementById("task") as HTMLTextAreaElement;
const runButton = document.getElementById("run") as HTMLButtonElement;
const statusList = document.getElementById("status") as HTMLUListElement;
const payloadView = document.getElementById("payload") as HTMLPreElement;
const badge = document.getElementById("privacy-badge") as HTMLSpanElement;

runButton.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    appendStatus("Enter a task first", "error");
    return;
  }

  statusList.replaceChildren();
  payloadView.textContent = "(waiting for extraction)";
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
  if (message.type === "STATUS") appendStatus(message.text, message.level);
  if (message.type === "SANITIZED_PAYLOAD") payloadView.textContent = message.json;
  if (message.type === "STAGE") renderStage(message);
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
