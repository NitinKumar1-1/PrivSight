/**
 * Following tabs the page opens (Phase 7).
 *
 * Many sites open a product page in a new tab (links with target="_blank" or
 * window.open). The agent must then observe and act in that tab, not in the
 * one it came from. This pure rule decides whether a newly created tab was
 * opened by the tab the agent is working in; the service worker applies it
 * to chrome.tabs.onCreated events and switches the run to the new tab.
 */

export interface CreatedTab {
  id?: number;
  openerTabId?: number;
}

/** The tab id to continue in: the new tab when the current tab opened it, else the current one. */
export function adoptOpenedTab(currentTabId: number, created: CreatedTab): number {
  if (created.id !== undefined && created.openerTabId === currentTabId) return created.id;
  return currentTabId;
}

/** What a tab is showing or about to show. A tab that is still loading has an empty url and a pendingUrl. */
export function tabAddress(tab: { url?: string; pendingUrl?: string } | null | undefined): string {
  return tab?.url || tab?.pendingUrl || "";
}

/** True when the address is a web page the agent can work in (not blank, not a browser page). */
export function isWebAddress(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
