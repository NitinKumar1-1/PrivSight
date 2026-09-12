/**
 * Real-site regression runner: drives the REAL controller (dist-agent-node/controller.js,
 * built from src/agent/controller.ts) with ports backed by Playwright and the local
 * backend. The content script is the real dist/content.js bundle injected into the page
 * with chrome.runtime stubbed. The loop, the task guard, the validator, the executor,
 * the completion verifier and every outcome code are therefore exactly the extension's.
 *
 *   node scripts/run-agent.mjs <url> "<task>"
 *
 * Prints, per attempted action, the trace fields the evaluation asks for (TASK, TARGET,
 * RESOLUTION, VALIDATION, ACTION, POST-ACTION, RE-OBSERVATION, FINAL) and the final
 * outcome. Redacted labels only; no page text, no values, no screenshots.
 *
 * Requires: `npm run build` and `npx vite build --config vite.agent-node.config.ts`, the
 * backend on localhost:8000. Env: PW_CHANNEL=chrome to use installed Chrome, HEADLESS=1.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { runAgent } from "../dist-agent-node/controller.js";

const [url, task] = process.argv.slice(2);
if (!url || !task) {
  console.error('usage: node scripts/run-agent.mjs <url> "<task>"');
  process.exit(2);
}
const CONTENT = `(function () {\n${readFileSync(new URL("../dist/content.js", import.meta.url), "utf8")}\n})();`;
const BACKEND = process.env.PRIVSIGHT_BACKEND ?? "http://localhost:8000";

// PW_PROFILE=<dir>: launch with a persistent profile (some sites treat a fresh, empty profile as a bot).
const launchOptions = { headless: process.env.HEADLESS === "1", channel: process.env.PW_CHANNEL || undefined, args: ["--disable-blink-features=AutomationControlled"] };
const ctx = process.env.PW_PROFILE
  ? await chromium.launchPersistentContext(process.env.PW_PROFILE, { ...launchOptions, viewport: { width: 1400, height: 900 }, locale: "en-IN", bypassCSP: true })
  : await (await chromium.launch(launchOptions)).newContext({ viewport: { width: 1400, height: 900 }, locale: "en-IN", bypassCSP: true });
const browser = ctx.browser() ?? ctx;
const page = ctx.pages()[0] ?? (await ctx.newPage());
// Like the service worker's pullOpenedTabBack: a page the site opens in a new tab is brought
// back into the working tab, so the run stays in one tab and its state is untouched.
let pendingPull = Promise.resolve();
ctx.on("page", (opened) => {
  if (opened === page) return;
  pendingPull = pendingPull.then(async () => {
    await opened.waitForLoadState("commit", { timeout: 8000 }).catch(() => {});
    const target = opened.url();
    await opened.close().catch(() => {});
    if (/^https?:\/\//.test(target)) {
      console.log(`  [info] The page opened a new tab; opening it in this tab instead: ${new URL(target).host}`);
      await page.goto(target, { waitUntil: "commit", timeout: 45000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    }
  });
});
await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(2000);

async function ensureContentScript() {
  // Sites with bot checks reload or redirect once or twice before settling; wait for the network first.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  for (let attempt = 1; attempt <= 6; attempt++) {
    const ready = await page.evaluate(() => {
      if (typeof window.__listener === "function") return true;
      window.chrome = { runtime: { onMessage: { addListener(fn) { window.__listener = fn; } } } };
      return false;
    }).catch(() => false);
    if (ready) return;
    await page.addScriptTag({ content: CONTENT }).catch(() => {});
    const now = await page.evaluate(() => typeof window.__listener === "function").catch(() => false);
    if (now) return;
    await page.waitForLoadState("load").catch(() => {});
    await page.waitForTimeout(1200);
  }
}

function send(message) {
  return page.evaluate((m) => new Promise((resolve) => { window.__listener(m, null, resolve); }), message);
}

const traces = [];
const ports = {
  ensureContentScript,
  capture: async () => null, // no screenshot channel in this harness: DOM-only observation
  perceive: async () => null,
  visionInfo: async () => null,
  extract: (t, ocr, history, guidance) => {
    if (guidance) console.log(`  GUIDANCE -> reasoner: ${guidance}`);
    return send({ type: "EXTRACT_PAGE", task: t, ocr, history, guidance });
  },
  reason: async (body) => {
    const res = await fetch(`${BACKEND}/reason`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (!res.ok) throw new Error(`Backend returned ${res.status}: ${await res.text()}`);
    return res.json();
  },
  execute: (action, history) => send({ type: "EXECUTE_ACTION", action, history }),
  renderMask: async () => null,
  settle: async () => {
    await page.waitForTimeout(900);
    await pendingPull; // a tab opened by the last click may still be on its way back into this tab
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(400);
  },
  pageUrl: async () => page.url(),
  navigate: async (u) => {
    // Like the service worker's tab navigation: wait for the document to commit, then a bounded settle;
    // a slow site must not fail the whole run while the page is in fact opening.
    await page.goto(u, { waitUntil: "commit", timeout: 45000 }).catch(async (error) => {
      if (!page.url().startsWith(u.split("?")[0].replace(/\/$/, ""))) throw error;
    });
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
  },
  report: (event) => {
    if (event.kind === "status") console.log(`  [${event.level}] ${event.text}`);
    if (event.kind === "step") console.log(`  STEP ${event.step}/${event.maxSteps}: ${event.action}`);
    if (event.kind === "trace") {
      traces.push(event.trace);
      const t = event.trace;
      console.log(`  TRACE action=${t.action} target="${t.target}" resolution=${t.resolution} match="${t.match}" validation=${t.validation} execution=${t.execution} post-action=${t.postAction} reobserve=${t.reobserve} final=${t.final}${t.context ? ` context="${t.context}"` : ""}`);
    }
    if (event.kind === "page") console.log(`  PAGE ${event.host} "${event.title}" elements=${event.elements} placeholders=${event.placeholders}`);
  },
  now: () => performance.now(),
};

console.log(`TASK: ${task}\nURL: ${url}`);
const outcome = await runAgent(task, ports);
console.log(`\nFINAL STATE: ${outcome.status.toUpperCase()} (${outcome.code}) after ${outcome.steps} step(s), ${outcome.rounds} round(s); cloud contacted: ${outcome.cloudContacted}; browser acted: ${outcome.browserActed}`);
console.log(`MESSAGE: ${outcome.message}`);
console.log(`URL AT END: ${page.url()}`);
await browser.close();
