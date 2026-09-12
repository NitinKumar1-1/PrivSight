/**
 * Page change detection around one executed action.
 *
 * A snapshot is taken before the action; after it, the page is watched for
 * a bounded time and the difference is reported as one effect:
 *
 *   url_changed   the location changed (navigation, SPA route change)
 *   dom_changed   the location is the same but the DOM mutated (results
 *                 rendered, a dialog opened or closed, a button re-rendered)
 *   no_change     nothing observable happened within the bound
 *
 * Detection uses a MutationObserver plus short polling with a quiet period,
 * never an unbounded wait. Only structural facts are computed (counts, a
 * signature of control ids/labels); no page text leaves this module.
 */

import { cartCount, CART_CONFIRMATION, GO_TO_CART } from "../agent/completion";
import type { ActionEffect } from "../shared/contract";
import { INTERACTIVE_SELECTOR } from "./element-ids";

export interface PageSnapshot {
  url: string;
  title: string;
  /** Signature of the interactive controls (count plus a hash of their ids and labels). */
  controls: string;
  /** Visible dialogs and modal overlays. */
  dialogs: number;
}

export interface PostActionEffect {
  effect: ActionEffect;
  mutations: number;
  urlChanged: boolean;
  titleChanged: boolean;
  controlsChanged: boolean;
  modalAppeared: boolean;
  modalClosed: boolean;
  waitedMs: number;
  /** Set by the executor when it had to fall back to a synthetic pointer sequence. */
  fallbackUsed?: boolean;
}

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
const MAX_SIGNATURE_CONTROLS = 300;
export const DEFAULT_WATCH_MS = 1500;
export const DEFAULT_QUIET_MS = 250;

export function snapshotPage(): PageSnapshot {
  return {
    url: location.href,
    title: document.title,
    controls: controlSignature(),
    dialogs: visibleDialogs(),
  };
}

export interface PageWatch {
  /** The snapshot taken when the watch began (before the action). */
  before: PageSnapshot;
  /** Resolves as soon as the URL changes, once mutations have been quiet for `quietMs`, or at `timeoutMs`. */
  finish(options?: { timeoutMs?: number; quietMs?: number }): Promise<PostActionEffect>;
}

/**
 * Begins watching the page BEFORE an action is performed. Handlers that
 * mutate the DOM synchronously inside a click or an input event would
 * otherwise finish before an observer attached afterwards could see them,
 * and the action would be recorded as having no effect.
 */
export function beginWatch(): PageWatch {
  const before = snapshotPage();
  const start = Date.now();
  let mutations = 0;
  let lastMutation = 0;
  const observer = typeof MutationObserver === "function" && document.body
    ? new MutationObserver((records) => {
        mutations += records.length;
        lastMutation = Date.now();
      })
    : null;
  observer?.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  return {
    before,
    finish(options = {}) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_MS;
      const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
      return new Promise((resolve) => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          observer?.disconnect();
          clearInterval(timer);
          resolve(diff(before, mutations, Date.now() - start));
        };
        const timer = setInterval(() => {
          const now = Date.now();
          if (location.href !== before.url) return done();
          if (mutations > 0 && now - lastMutation >= quietMs) return done();
          if (now - start >= timeoutMs) return done();
        }, 100);
      });
    },
  };
}

/** Watches the page after an action that has already happened (kept for callers with their own snapshot). */
export function watchForChange(before: PageSnapshot, options: { timeoutMs?: number; quietMs?: number } = {}): Promise<PostActionEffect> {
  const watch = beginWatch();
  watch.before = before;
  return watch.finish(options);
}

function diff(before: PageSnapshot, mutations: number, waitedMs: number): PostActionEffect {
  const after = snapshotPage();
  const urlChanged = after.url !== before.url;
  const titleChanged = after.title !== before.title;
  const controlsChanged = after.controls !== before.controls;
  const modalAppeared = after.dialogs > before.dialogs;
  const modalClosed = after.dialogs < before.dialogs;
  const effect: ActionEffect = urlChanged ? "url_changed" : mutations > 0 || controlsChanged || titleChanged || modalAppeared || modalClosed ? "dom_changed" : "no_change";
  return { effect, mutations, urlChanged, titleChanged, controlsChanged, modalAppeared, modalClosed, waitedMs };
}

/** Cheap signature of the controls on the page: count plus a hash of ids and labels. Never stored or sent. */
export function controlSignature(): string {
  const nodes = document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR);
  let hash = 0;
  let counted = 0;
  for (const node of nodes) {
    if (counted++ >= MAX_SIGNATURE_CONTROLS) break;
    const key = `${node.tagName}|${node.getAttribute("data-ps-id") ?? ""}|${(node.textContent ?? "").trim().slice(0, 40)}`;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return `${nodes.length}:${hash}`;
}

// --- cart evidence --------------------------------------------------------------

/** Cart signals visible on the page. Numbers and booleans only; computed locally, never sent. */
export interface CartSnapshot {
  count: number | null;
  goToCart: boolean;
  confirmation: boolean;
  dialogs: number;
}

export interface CartEvidence {
  countBefore: number | null;
  countAfter: number | null;
  confirmationAppeared: boolean;
  goToCartAppeared: boolean;
  dialogAppeared: boolean;
  /** Objective evidence that the item went into the cart. */
  added: boolean;
}

const MAX_CART_TEXT = 40_000;

export function cartSnapshot(): CartSnapshot {
  const labels: string[] = [];
  for (const node of document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)) {
    const text = (node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (text && text.length <= 60) labels.push(text);
  }
  const text = bodyText().toLowerCase().slice(0, MAX_CART_TEXT);
  return {
    count: cartCount({ url: "", title: "", labels, text }),
    goToCart: labels.some((l) => GO_TO_CART.test(l)),
    confirmation: CART_CONFIRMATION.test(text),
    dialogs: visibleDialogs(),
  };
}

/**
 * Visible page text with element boundaries preserved. innerText (real
 * browsers) separates blocks; where it is unavailable, text nodes are joined
 * with spaces so "Cart" followed by "Added to cart" never fuses into one word.
 */
function bodyText(): string {
  const body = document.body;
  if (!body) return "";
  if (typeof body.innerText === "string" && body.innerText.length > 0) return body.innerText;
  const parts: string[] = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const value = walker.currentNode.textContent?.trim();
    if (value) parts.push(value);
    if (parts.length > 5000) break;
  }
  return parts.join(" ");
}

export function cartEvidenceBetween(before: CartSnapshot, after: CartSnapshot): CartEvidence {
  const countUp = before.count !== null && after.count !== null && after.count > before.count;
  const confirmationAppeared = !before.confirmation && after.confirmation;
  const goToCartAppeared = !before.goToCart && after.goToCart;
  return {
    countBefore: before.count,
    countAfter: after.count,
    confirmationAppeared,
    goToCartAppeared,
    dialogAppeared: after.dialogs > before.dialogs,
    added: countUp || confirmationAppeared || goToCartAppeared,
  };
}

export function visibleDialogs(): number {
  let count = 0;
  for (const node of document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR)) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) count++;
  }
  return count;
}
