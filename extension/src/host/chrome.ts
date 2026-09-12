/**
 * Chrome host layer. The only file in the extension that touches
 * chrome.tabs, chrome.scripting and chrome.offscreen.
 *
 * Firefox note: the vision, privacy, fusion, validator and controller modules
 * contain no chrome.* calls. Porting means replacing this file: Firefox has
 * browser.tabs.captureVisibleTab but no offscreen API, so the OCR host would
 * be a background page instead of an offscreen document. Not runtime-tested
 * on Firefox in this phase.
 */

import type { Capture, VisionInfo } from "../agent/controller";
import { isWebAddress, tabAddress } from "../agent/tabs";
import type { ContentMessage, OffscreenRequest, OffscreenResponse } from "../shared/messages";
import type { BBox, OcrResult } from "../vision/types";

const OFFSCREEN_URL = "offscreen/offscreen.html";
let offscreenReady: Promise<void> | null = null;

export async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}

/**
 * Tabs opened before the extension was loaded will not have the content
 * script yet. Ping it and inject on demand if there is no listener.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" } satisfies ContentMessage);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: contentScriptFiles() });
  }
}

/**
 * After an executed action the tab may navigate or re-render. Wait until the
 * tab reports "complete" (bounded), then make sure a content script answers.
 * A short initial delay lets a navigation actually start before it is checked.
 */
export async function waitForTabReady(tab: number | (() => number), timeoutMs = 15_000): Promise<void> {
  // The working tab can change while this waits (the page opened a new tab), so it is read on every check.
  const tabId = typeof tab === "function" ? tab : () => tab;
  await delay(900);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tabId()).catch(() => null);
    if (current && current.status === "complete") break;
    await delay(250);
  }
  await delay(400); // let document_idle content scripts register before pinging
  await ensureContentScript(tabId());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Current URL of the tab ("" when unknown). A tab that is still loading reports its pending URL. */
export async function tabUrl(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tabAddress(tab);
}

/**
 * A page the agent clicked opened a new tab (target="_blank" or window.open).
 * Instead of moving the run there (which switches tabs and closes the popup),
 * bring the page back: read the new tab's address, close it and open that
 * address in the working tab. Returns the address, or null when the new tab
 * never showed a web address in time (the caller then follows it instead).
 */
export async function pullOpenedTabBack(workingTabId: number, openedTabId: number, timeoutMs = 6_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let address = "";
  while (Date.now() < deadline) {
    const opened = await chrome.tabs.get(openedTabId).catch(() => null);
    if (!opened) return null; // already gone
    address = tabAddress(opened);
    if (isWebAddress(address)) break;
    await delay(150);
  }
  if (!isWebAddress(address)) return null;
  await chrome.tabs.remove(openedTabId).catch(() => undefined);
  await chrome.tabs.update(workingTabId, { url: address, active: true });
  return address;
}

/** Opens a validated URL in the tab and waits for it to load. */
export async function navigateTab(tabId: number, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url });
  await waitForTabReady(tabId, 30_000);
}

export function sendToContent<T>(tabId: number, message: ContentMessage): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}

/** Visible-viewport screenshot as a PNG data URL. Stays in extension memory. */
export async function captureVisibleTab(tabId: number): Promise<Capture | null> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId === undefined) return null;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  if (!dataUrl) return null;
  const dpr = await devicePixelRatioOf(tabId);
  return { dataUrl, devicePixelRatio: dpr };
}

async function devicePixelRatioOf(tabId: number): Promise<number> {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.devicePixelRatio });
    const value = Number(result?.result);
    return Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

export async function ocrCapture(capture: Capture): Promise<OcrResult | null> {
  const response = await offscreen({ target: "offscreen", type: "OCR_IMAGE", dataUrl: capture.dataUrl, devicePixelRatio: capture.devicePixelRatio });
  if (!response.ok) throw new Error(response.error);
  return "result" in response ? response.result : null;
}

export async function renderMaskedPreview(capture: Capture, regions: BBox[], images: BBox[] = []): Promise<string | null> {
  const response = await offscreen({ target: "offscreen", type: "MASK_IMAGE", dataUrl: capture.dataUrl, regions, images });
  if (!response.ok) throw new Error(response.error);
  return "dataUrl" in response ? response.dataUrl : null;
}

export async function visionInfo(): Promise<VisionInfo | null> {
  const response = await offscreen({ target: "offscreen", type: "VISION_INFO" });
  return response.ok && "info" in response ? response.info : null;
}

async function offscreen(request: OffscreenRequest): Promise<OffscreenResponse> {
  await ensureOffscreenDocument();
  const response = (await chrome.runtime.sendMessage(request)) as OffscreenResponse | undefined;
  if (!response) throw new Error("offscreen document did not respond");
  return response;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const contexts = (await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      })) as chrome.runtime.ExtensionContext[];
      if (contexts.length > 0) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Run the local OCR engine (WebAssembly worker) on screenshots that must not leave the device.",
      });
    })().catch((error) => {
      offscreenReady = null;
      throw error;
    });
  }
  return offscreenReady;
}

function contentScriptFiles(): string[] {
  return chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
}
