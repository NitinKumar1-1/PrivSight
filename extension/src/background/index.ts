/**
 * Service worker entry. Receives the user's task from the popup and hands it
 * to the Local Browser Agent / Controller, wiring the controller's ports to
 * the Chrome host layer, the content script, the backend client and the
 * popup. The service worker never holds a raw PII value: the content script
 * only ever returns firewall-approved bytes or a block. The screenshot it
 * holds goes only to the offscreen document and the popup preview.
 */

import { DEFAULT_MAX_STEPS, runAgent, type AgentEvent, type AgentPorts } from "../agent/controller";
import { executeOffPage, observeOffPage } from "../agent/offpage";
import { adoptOpenedTab } from "../agent/tabs";
import {
  captureVisibleTab,
  ensureContentScript,
  getActiveTabId,
  navigateTab,
  ocrCapture,
  pullOpenedTabBack,
  renderMaskedPreview,
  sendToContent,
  tabUrl,
  visionInfo,
  waitForTabReady,
} from "../host/chrome";
import {
  RUN_LOG_KEY,
  type ExecuteActionResult,
  type ExtractPageResult,
  type MetricsMessage,
  type OutcomeMessage,
  type PageMessage,
  type PhaseMessage,
  type PreviewMessage,
  type RunLog,
  type RuntimeMessage,
  type StateMessage,
  type SanitizedPayloadMessage,
  type StageMessage,
  type StatusMessage,
} from "../shared/messages";
import { classifyError, describeOutcome } from "../shared/outcomes";
import { postReason } from "./api";

// Test seam (not a bypass): the real network gate, reachable from the worker's global scope so an
// end-to-end test can prove that a body carrying a raw value is refused before any fetch happens.
(globalThis as unknown as { __privsightPostReason?: typeof postReason }).__privsightPostReason = postReason;

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (!("type" in message)) return;
  if (message.type === "GET_RUN_LOG") {
    sendResponse({ log: runLog });
    return;
  }
  if (message.type !== "RUN_TASK") return;

  // One task at a time. Starting a task cancels the one still running: two loops on one
  // tab would observe each other's pages and write into the same log (stale task context).
  if (activeRun) {
    activeRun.cancelled = true;
    console.info(`[PrivSight] cancelling run ${activeRun.id} because a new task was started`);
  }
  const run = { id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, cancelled: false };
  activeRun = run;
  startRunLog(message.task, run.id);
  toPopup({ type: "RUN_STARTED", runId: run.id, task: message.task, maxSteps: DEFAULT_MAX_STEPS });
  runTask(message.task, message.tabId, run)
    .finally(() => {
      if (activeRun === run) activeRun = null;
    })
    .then((outcome) => sendResponse({ ok: outcome.status === "completed", error: outcome.status === "completed" ? undefined : outcome.message }))
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      const code = classifyError(text);
      const words = describeOutcome(code);
      console.warn("[PrivSight] run failed:", text);
      toPopup({ type: "OUTCOME", code, title: words.title, message: words.message, cloudContacted: false, browserActed: false, detail: text });
      sendResponse({ ok: false, error: words.title });
    });

  return true; // keep the message channel open for the async response
});

interface ActiveRun {
  id: string;
  cancelled: boolean;
}
let activeRun: ActiveRun | null = null;

async function runTask(task: string, explicitTabId: number | undefined, run: ActiveRun) {
  // The tab the agent works in. When the page opens a new tab (a product link
  // with target="_blank") the opened page is pulled back into this tab, so the
  // run stays in one tab and the popup stays open. Only when that is not
  // possible does the agent move to the new tab.
  let tabId = explicitTabId ?? (await getActiveTabId());
  let pendingFollow: Promise<void> = Promise.resolve();
  const follow = (created: chrome.tabs.Tab) => {
    const next = adoptOpenedTab(tabId, created);
    if (next === tabId) return;
    const from = tabId;
    pendingFollow = pendingFollow.then(async () => {
      const pulled = await pullOpenedTabBack(from, next).catch(() => null);
      if (pulled) {
        toPopup({ type: "STATUS", text: `The page opened a new tab; opening ${hostOf(pulled)} in this tab instead.`, level: "info" });
        return;
      }
      tabId = next;
      toPopup({ type: "STATUS", text: "The page opened a new tab; continuing there.", level: "info" });
      await chrome.tabs.update(next, { active: true }).catch(() => undefined);
    });
  };
  chrome.tabs.onCreated.addListener(follow);

  const ports: AgentPorts = {
    // A start page or chrome:// tab has no content script; the loop handles that as an off-page round.
    ensureContentScript: async () => {
      if (/^https?:\/\//i.test(await tabUrl(tabId))) await ensureContentScript(tabId);
    },
    pageUrl: () => tabUrl(tabId),
    observeOffPage: async (t, history, guidance) => observeOffPage(t, await tabUrl(tabId), history, navigator.language, guidance),
    executeOffPage: async (action) => executeOffPage(action, task, await tabUrl(tabId)),
    navigate: (url) => navigateTab(tabId, url),
    capture: () => captureVisibleTab(tabId),
    perceive: (capture) => ocrCapture(capture),
    visionInfo,
    extract: (t, ocr, history, guidance) => sendToContent<ExtractPageResult>(tabId, { type: "EXTRACT_PAGE", task: t, ocr, history, guidance }),
    reason: postReason,
    execute: (action, history) => sendToContent<ExecuteActionResult>(tabId, { type: "EXECUTE_ACTION", action, history }),
    renderMask: renderMaskedPreview,
    settle: async () => {
      // A tab opened by the last click may still be on its way back into this tab.
      await pendingFollow;
      await waitForTabReady(() => tabId);
    },
    isCancelled: () => run.cancelled,
    report: (event) => relay(event, run.id),
    now: () => performance.now(),
  };

  toPopup({ type: "STATUS", text: "Local agent: observing the page...", level: "info" });
  try {
    const outcome = await runAgent(task, ports, { maxSteps: await configuredMaxSteps() });
    const words = describeOutcome(outcome.code);
    // The technical message stays in the developer console; the popup gets the mapped wording.
    console.info(`[PrivSight] outcome ${outcome.code}: ${outcome.message}`);
    toPopup({
      type: "OUTCOME",
      code: outcome.code,
      title: words.title,
      message: outcome.code === "COMPLETED" ? words.message : words.message,
      cloudContacted: outcome.cloudContacted,
      browserActed: outcome.browserActed,
      detail: outcome.message,
    });
    return outcome;
  } finally {
    chrome.tabs.onCreated.removeListener(follow);
  }
}

/** The execution budget, configurable in chrome.storage.local ("maxSteps"); a limit, not a plan. */
async function configuredMaxSteps(): Promise<number> {
  try {
    const items = await chrome.storage?.local?.get("maxSteps");
    const value = Number(items?.maxSteps);
    return Number.isFinite(value) && value >= 1 && value <= 100 ? Math.round(value) : DEFAULT_MAX_STEPS;
  } catch {
    return DEFAULT_MAX_STEPS;
  }
}

function relay(event: AgentEvent, runId: string): void {
  if (activeRun && activeRun.id !== runId) return; // a cancelled run never writes into the current run's log
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
      // The raw capture never leaves the service worker/offscreen pair; the popup gets the masked render only.
      toPopup({ type: "PREVIEW", rawDataUrl: null, maskedDataUrl: event.maskedDataUrl, maskCount: event.maskCount, imageCount: event.imageCount } satisfies PreviewMessage);
      return;
    case "step":
      toPopup({ type: "STATUS", text: `Step ${event.step} of ${event.maxSteps} executed: ${event.action}`, level: "success" } satisfies StatusMessage);
      return;
    case "page":
      toPopup({ type: "PAGE", title: event.title, host: event.host, elements: event.elements, placeholders: event.placeholders, visualObservations: event.visualObservations } satisfies PageMessage);
      return;
    case "metrics":
      toPopup({ type: "METRICS", metrics: event.metrics } satisfies MetricsMessage);
      return;
    case "phase":
      toPopup({ type: "PHASE", phase: event.phase } satisfies PhaseMessage);
      return;
    case "trace":
      // Development trace: redacted labels, never values, never page text.
      console.debug("[PrivSight trace]", JSON.stringify(event.trace));
      return;
    case "state":
      toPopup({ type: "STATE", state: event.state } satisfies StateMessage);
      return;
  }
}

type PopupMessage = StatusMessage | StageMessage | SanitizedPayloadMessage | PreviewMessage | PageMessage | MetricsMessage | OutcomeMessage | PhaseMessage | StateMessage | { type: "RUN_STARTED"; runId: string; task: string; maxSteps: number };

/**
 * Everything sent to the popup during the current run, so a popup opened
 * (or reopened) mid-run can show the run so far. Kept in the service worker
 * and mirrored to session storage, which Chrome clears when the browser
 * closes. Bulky messages (preview, payload) are kept only in their latest
 * version.
 */
let runLog: RunLog = { task: "", messages: [] };
const MAX_LOG_MESSAGES = 400;

function startRunLog(task: string, runId: string): void {
  runLog = { task, runId, messages: [] };
  persistRunLog();
}

function recordForPopup(message: PopupMessage): void {
  if (message.type === "RUN_STARTED") return;
  if (message.type === "PREVIEW" || message.type === "SANITIZED_PAYLOAD") {
    runLog.messages = runLog.messages.filter((m) => m.type !== message.type);
  }
  runLog.messages.push(message);
  if (runLog.messages.length > MAX_LOG_MESSAGES) runLog.messages.splice(0, runLog.messages.length - MAX_LOG_MESSAGES);
  persistRunLog();
}

function persistRunLog(): void {
  try {
    chrome.storage?.session?.set({ [RUN_LOG_KEY]: runLog }).catch(() => undefined);
  } catch {
    // session storage unavailable: the in-memory log still answers GET_RUN_LOG
  }
}

function toPopup(message: PopupMessage): void {
  recordForPopup(message);
  // The popup may have been closed; ignore "no receiver" errors.
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the page";
  }
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
