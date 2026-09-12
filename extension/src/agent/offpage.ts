/**
 * Off-page observation (Phase 7).
 *
 * A browser start page, a new tab or any chrome:// page has no content script
 * and nothing to capture, so the agent cannot observe it. Instead of failing,
 * the service worker builds a minimal sanitized observation that says so and
 * lets the reasoner open the website the task names. Only `navigate` (to a
 * site the task authorises) and `done` can be executed from here; the same
 * validator runs, with no live elements to target.
 *
 * Pure: no chrome.* calls. The service worker wires the tab URL and the
 * navigation itself.
 */

import { validateAction, type ValidationContext } from "../content/action-validator";
import { navigationBlockReason } from "../content/navigation";
import { prepareOutgoingRequest } from "../privacy/sanitize";
import type { ActionRecord, ActionType } from "../shared/contract";
import type { ExecuteActionResult, ExtractPageResult } from "../shared/messages";

export const OFF_PAGE_TEXT =
  "No web page is open in this tab (a browser start page or internal page). Nothing can be read or clicked here. " +
  "If the task names a website, open it with the navigate action using that site's https home page or a direct search URL on it. " +
  "If the task does not name a website, return done and say which website is needed.";

export const OFF_PAGE_ACTIONS: ReadonlySet<ActionType> = new Set(["navigate", "done"]);

/** True for tabs where no content script can run. */
export function isOffPageUrl(url: string | undefined | null): boolean {
  return !url || !/^https?:\/\//i.test(url);
}

/** A sanitized, firewall-checked observation of "no page open". */
/**
 * @param locale the browser UI language (for example "en-IN"): the only extra fact sent, so a site named
 *   without a country ("amazon") can be opened on the storefront for the user's region.
 */
export function observeOffPage(task: string, currentUrl: string, history: ActionRecord[], locale = "", guidance?: string): ExtractPageResult {
  const text = locale ? `${OFF_PAGE_TEXT}\nBrowser language: ${locale.slice(0, 16)}` : OFF_PAGE_TEXT;
  const page = { url: currentUrl || "about:blank", title: "", elements: [], text };
  const { summary, firewall } = prepareOutgoingRequest(task, page, [], null, history, guidance);
  return { ok: true, summary, firewall, visualPrivacy: null, imageRegions: [] };
}

/** Validates an action against the off-page rules; a navigate is approved, never performed here. */
export function executeOffPage(input: unknown, task: string, currentUrl: string): ExecuteActionResult {
  const ctx: ValidationContext = {
    findElement: () => null,
    sensitiveTypeOf: () => undefined,
    placeholderType: () => undefined,
    supportedActions: OFF_PAGE_ACTIONS,
    isConsequential: () => null,
    isNavigationAllowed: (url) => navigationBlockReason(url, task, currentUrl),
    typesSensitiveValues: false,
  };
  const result = validateAction(input, ctx);
  if (!result.ok) return { ok: false, message: result.reason, validation: "blocked", code: result.code };
  if (result.action.action === "navigate" && result.action.value) {
    return { ok: true, message: `Navigation to ${new URL(result.action.value).host} approved`, validation: "pass", navigateTo: result.action.value };
  }
  return { ok: true, message: "Task reported as done", validation: "pass" };
}
