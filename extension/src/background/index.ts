/**
 * Service worker. Orchestrates one run:
 *
 *   popup -> content script (extract + redact + firewall)
 *         -> POST approved bytes -> content script (validate + execute)
 *         -> popup status and pipeline stages
 *
 * The service worker never holds a raw value: the content script only ever
 * returns firewall-approved bytes or a block.
 */

import type { PrivacySummary } from "../privacy/types";
import type {
  ContentMessage,
  ExecuteActionResult,
  ExtractPageResult,
  PipelineStage,
  RuntimeMessage,
  SanitizedPayloadMessage,
  StageMessage,
  StageState,
  StatusMessage,
} from "../shared/messages";
import { postReason } from "./api";

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type !== "RUN_TASK") return;

  runTask(message.task)
    .then(() => sendResponse({ ok: true }))
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      reportStatus(text, "error");
      sendResponse({ ok: false, error: text });
    });

  return true; // keep the message channel open for the async response
});

async function runTask(task: string): Promise<void> {
  const tabId = await getActiveTabId();
  await ensureContentScript(tabId);

  reportStatus("Extracting page and running local privacy checks...");
  const extracted = await sendToContent<ExtractPageResult>(tabId, { type: "EXTRACT_PAGE", task });
  if (!extracted.ok) {
    reportStage("detect", "fail", extracted.error);
    throw new Error(`Page extraction failed: ${extracted.error}`);
  }

  reportStage("detect", "pass", describeDetections(extracted.summary));
  reportStatus(describePrivacy(extracted.summary), "success");

  const { firewall } = extracted;
  const checks = firewall.checks.map((c) => `${c.name}:${c.passed ? "pass" : "fail"}`).join(" ");
  if (firewall.verdict === "blocked") {
    reportStage("leakage", "fail", checks);
    reportStage("firewall", "fail", "REQUEST BLOCKED");
    reportStage("reason", "skipped");
    reportStage("validate", "skipped");
    reportStage("execute", "skipped");
    throw new Error(firewall.reason);
  }
  reportStage("leakage", "pass", checks);
  reportStage("firewall", "pass", "REQUEST ALLOWED");
  reportPayload(firewall.body);

  reportStatus("Sending sanitized request to backend...");
  reportStage("reason", "pending");
  let raw: unknown;
  try {
    raw = await postReason(firewall.body);
  } catch (error) {
    reportStage("reason", "fail", error instanceof Error ? error.message : String(error));
    reportStage("validate", "skipped");
    reportStage("execute", "skipped");
    throw error;
  }
  reportStage("reason", "pass", "structured action received");
  reportStatus(`Action received: ${describeRaw(raw)}`);

  reportStage("validate", "pending");
  const result = await sendToContent<ExecuteActionResult>(tabId, { type: "EXECUTE_ACTION", action: raw });
  if (result.validation === "blocked") {
    reportStage("validate", "fail", result.message);
    reportStage("execute", "skipped");
    throw new Error(`Action blocked by local validator: ${result.message}`);
  }
  reportStage("validate", "pass", "action verified against the live page");

  if (!result.ok) {
    reportStage("execute", "fail", result.message);
    throw new Error(`Action failed: ${result.message}`);
  }
  reportStage("execute", "pass", result.message);
  reportStatus(`Action executed: ${result.message}`, "success");
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}

/**
 * Tabs opened before the extension was loaded will not have the content
 * script yet. Ping it and inject on demand if there is no listener.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" } satisfies ContentMessage);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: contentScriptFiles() });
  }
}

function contentScriptFiles(): string[] {
  return chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
}

function sendToContent<T>(tabId: number, message: ContentMessage): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}

function reportStatus(text: string, level: StatusMessage["level"] = "info"): void {
  const status: StatusMessage = { type: "STATUS", text, level };
  // The popup may have been closed; ignore "no receiver" errors.
  chrome.runtime.sendMessage(status).catch(() => undefined);
}

function reportStage(stage: PipelineStage, state: StageState, detail?: string): void {
  const message: StageMessage = { type: "STAGE", stage, state, detail };
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

/** The body already passed the firewall, so showing it in the popup is safe. */
function reportPayload(body: string): void {
  let pretty = body;
  try {
    pretty = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // keep the raw string
  }
  const message: SanitizedPayloadMessage = { type: "SANITIZED_PAYLOAD", json: pretty };
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

/** Names placeholders and types only. Never the values behind them. */
function describePrivacy(summary: PrivacySummary): string {
  if (summary.placeholders.length === 0) return "Local PII detection: nothing sensitive found";
  const items = summary.placeholders.map((p) => `${summary.types[p]} -> ${p}`);
  return `Local PII detection: ${items.join(", ")}`;
}

function describeDetections(summary: PrivacySummary): string {
  const count = summary.placeholders.length;
  if (count === 0) return "no sensitive values";
  const fields = summary.detections.map((d) => `${d.elementId} (${d.signals.join(", ")})`).join("; ");
  return `${count} redacted${fields ? `; fields: ${fields}` : ""}`;
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
