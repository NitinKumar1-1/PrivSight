/**
 * Service worker entry. Receives the user's task from the popup and hands it
 * to the Local Browser Agent / Controller, wiring the controller's ports to
 * the Chrome host layer, the content script, the backend client and the
 * popup. The service worker never holds a raw PII value: the content script
 * only ever returns firewall-approved bytes or a block. The screenshot it
 * holds goes only to the offscreen document and the popup preview.
 */

import { runAgent, type AgentEvent, type AgentPorts } from "../agent/controller";
import {
  captureVisibleTab,
  ensureContentScript,
  getActiveTabId,
  ocrCapture,
  renderMaskedPreview,
  sendToContent,
  visionInfo,
} from "../host/chrome";
import type {
  ExecuteActionResult,
  ExtractPageResult,
  MetricsMessage,
  PreviewMessage,
  RuntimeMessage,
  SanitizedPayloadMessage,
  StageMessage,
  StatusMessage,
} from "../shared/messages";
import { postReason } from "./api";

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (!("type" in message) || message.type !== "RUN_TASK") return;

  runTask(message.task, message.tabId)
    .then((outcome) => sendResponse({ ok: outcome.status === "completed", error: outcome.status === "completed" ? undefined : outcome.message }))
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      toPopup({ type: "STATUS", text, level: "error" });
      sendResponse({ ok: false, error: text });
    });

  return true; // keep the message channel open for the async response
});

async function runTask(task: string, explicitTabId?: number) {
  const tabId = explicitTabId ?? (await getActiveTabId());
  const ports: AgentPorts = {
    ensureContentScript: () => ensureContentScript(tabId),
    capture: () => captureVisibleTab(tabId),
    perceive: (capture) => ocrCapture(capture),
    visionInfo,
    extract: (t, ocr) => sendToContent<ExtractPageResult>(tabId, { type: "EXTRACT_PAGE", task: t, ocr }),
    reason: postReason,
    execute: (action) => sendToContent<ExecuteActionResult>(tabId, { type: "EXECUTE_ACTION", action }),
    renderMask: renderMaskedPreview,
    report: relay,
    now: () => performance.now(),
  };

  toPopup({ type: "STATUS", text: "Local agent: observing the page...", level: "info" });
  const outcome = await runAgent(task, ports);
  if (outcome.status !== "completed") toPopup({ type: "STATUS", text: outcome.message, level: "error" });
  return outcome;
}

function relay(event: AgentEvent): void {
  switch (event.kind) {
    case "stage":
      toPopup({ type: "STAGE", stage: event.stage, state: event.state, detail: event.detail } satisfies StageMessage);
      return;
    case "status":
      toPopup({ type: "STATUS", text: event.text, level: event.level } satisfies StatusMessage);
      return;
    case "payload":
      toPopup({ type: "SANITIZED_PAYLOAD", json: pretty(event.body) } satisfies SanitizedPayloadMessage);
      return;
    case "preview":
      toPopup({ type: "PREVIEW", rawDataUrl: event.rawDataUrl, maskedDataUrl: event.maskedDataUrl, maskCount: event.maskCount } satisfies PreviewMessage);
      return;
    case "metrics":
      toPopup({ type: "METRICS", metrics: event.metrics } satisfies MetricsMessage);
      return;
  }
}

function toPopup(message: StatusMessage | StageMessage | SanitizedPayloadMessage | PreviewMessage | MetricsMessage): void {
  // The popup may have been closed; ignore "no receiver" errors.
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
