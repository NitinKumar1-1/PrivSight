/**
 * Content script entry point. Listens for messages from the service worker
 * and dispatches to the handlers.
 */

import type { ContentMessage, ExecuteActionResult, ExtractPageResult, PingResult } from "../shared/messages";
import { handleExecuteAction, handleExtractPage } from "./handlers";

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
        handleExtractPage(message.task, message.ocr).then(sendResponse);
        return true; // async response
      case "EXECUTE_ACTION":
        sendResponse(handleExecuteAction(message.action));
        return;
    }
    return undefined;
  },
);
