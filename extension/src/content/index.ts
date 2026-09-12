/**
 * Content script entry point. Listens for messages from the service worker
 * and dispatches to the handlers.
 */

import type { ContentMessage, ExecuteActionResult, ExtractPageResult, PingResult } from "../shared/messages";
import { handleExecuteAction, handleExtractPage } from "./handlers";

declare global {
  interface Window {
    __privsightContentScript?: boolean;
  }
}

// A manual injection after navigation must never add a second listener: two
// listeners would answer one EXECUTE_ACTION twice and click twice.
if (!window.__privsightContentScript) {
  window.__privsightContentScript = true;
  registerListener();
}

function registerListener(): void {
chrome.runtime.onMessage.addListener(
  (
    message: ContentMessage,
    _sender,
    sendResponse: (r: ExtractPageResult | ExecuteActionResult | PingResult) => void,
  ): true | undefined => {
    switch (message.type) {
      case "PING":
        sendResponse({ ok: true });
        return;
      case "EXTRACT_PAGE":
        handleExtractPage(message.task, message.ocr, message.history ?? [], message.guidance).then(sendResponse);
        return true; // async response
      case "EXECUTE_ACTION":
        handleExecuteAction(message.action, message.history ?? []).then(sendResponse);
        return true; // async response: the executor watches the page after acting
    }
    return undefined;
  },
);
}
