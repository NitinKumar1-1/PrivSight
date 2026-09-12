/**
 * Development probe: runs the REAL content-script bundle (dist/content.js) inside a
 * live page under Playwright, with chrome.runtime stubbed, and drives the same
 * observe -> reason (local backend) -> validate/execute loop the extension runs.
 *
 * It is website-agnostic: pass any URL and task. It prints, per step, what the
 * reasoner is shown (element ids/labels only, never raw page text), the action
 * returned, the executor's verdict and the observed post-action effect, and the
 * execution trace. Use it to see why a real site does or does not progress.
 *
 *   node scripts/probe-site.mjs <url> "<task>" [maxSteps]
 *
 * Requires: `npm run build` (dist/content.js) and the backend on localhost:8000.
 * Nothing here is used by the extension itself.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const [url, task, stepsArg] = process.argv.slice(2);
if (!url || !task) {
  console.error('usage: node scripts/probe-site.mjs <url> "<task>" [maxSteps]');
  process.exit(2);
}
const STEPS = Number(stepsArg ?? 6);
// The bundle is injected into the page's own world here (the extension runs it in an isolated
// world), so it is wrapped in a function to keep its top-level names off the page's globals.
const CONTENT = `(function () {\n${readFileSync(new URL("../dist/content.js", import.meta.url), "utf8")}\n})();`;
const BACKEND = process.env.PRIVSIGHT_BACKEND ?? "http://localhost:8000";

// PW_CHANNEL=chrome uses the installed Chrome instead of Playwright's Chromium (some sites block the latter).
const browser = await chromium.launch({ headless: process.env.HEADLESS === "1", channel: process.env.PW_CHANNEL || undefined, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-IN", bypassCSP: true });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

async function inject() {
  const has = await page.evaluate(() => {
    if (window.__listener) return true;
    window.chrome = { runtime: { onMessage: { addListener(fn) { window.__listener = fn; } } } };
    return false;
  });
  if (!has) await page.addScriptTag({ content: CONTENT });
}

async function send(message) {
  // A page that is still redirecting (bot checks, region redirects) drops the injected script; inject again after it settles.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await inject();
    const ready = await page.evaluate(() => typeof window.__listener === "function");
    if (ready) break;
    await page.waitForLoadState("load").catch(() => {});
    await page.waitForTimeout(1500);
  }
  return page.evaluate((m) => new Promise((resolve) => { window.__listener(m, null, resolve); }), message);
}

const history = [];
let outcome = "STEP_LIMIT";
for (let step = 1; step <= STEPS; step++) {
  console.log(`\n===== STEP ${step} ===== ${page.url().slice(0, 110)}`);
  const ex = await send({ type: "EXTRACT_PAGE", task, ocr: null, history });
  if (!ex.ok) { console.log("extract failed:", ex.error); outcome = "PAGE_UNAVAILABLE"; break; }
  console.log(`firewall: ${ex.firewall.verdict} ${ex.firewall.reason ?? ""}`);
  if (ex.firewall.verdict !== "allowed") { outcome = "PRIVACY_BLOCK"; break; }
  const body = JSON.parse(ex.firewall.body);
  console.log(`elements: ${body.page.elements.length}; placeholders: ${body.placeholders.length}`);
  for (const e of body.page.elements.filter((e) => e.role === "button" || e.role === "textbox" || /cart|bag|buy|search|size|add/i.test(e.text)).slice(0, 25)) {
    console.log(`  ${e.id} | ${e.tag} | ${e.role} | ${e.text.slice(0, 40)} | ${e.context ?? ""}`);
  }
  // SHOW_TEXT=<regex>: print the sanitized page-text lines matching it (already redacted; dev use only).
  if (process.env.SHOW_TEXT) {
    const re = new RegExp(process.env.SHOW_TEXT, "i");
    const lines = body.page.text.split("\n");
    lines.forEach((line, i) => { if (re.test(line)) console.log(`  text[${i}]: ${lines.slice(Math.max(0, i - 2), i + 2).join(" ⏎ ").slice(0, 220)}`); });
  }

  const res = await fetch(`${BACKEND}/reason`, { method: "POST", headers: { "Content-Type": "application/json" }, body: ex.firewall.body });
  const action = await res.json();
  console.log("reasoner:", JSON.stringify(action));
  if (!res.ok) { outcome = "CLOUD_ERROR"; break; }

  const urlBefore = page.url();
  let result;
  try {
    result = await send({ type: "EXECUTE_ACTION", action, history });
  } catch (error) {
    // The page navigated while the executor was watching it: same rule as the service worker,
    // the action ran (it acts before it watches), the effect is a URL change.
    await page.waitForTimeout(1500);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    result = page.url() !== urlBefore
      ? { ok: true, message: "navigated during execution", validation: "pass", postAction: { effect: "url_changed" } }
      : { ok: false, message: String(error), validation: "pass" };
  }
  console.log("execute:", JSON.stringify({ ok: result.ok, validation: result.validation, code: result.code, message: result.message, effect: result.postAction?.effect }));
  if (result.trace) console.log("trace:", JSON.stringify(result.trace));
  if (result.validation === "blocked") { outcome = `BLOCKED:${result.code}`; break; }
  if (!result.ok) { outcome = "ACTION_FAILED"; break; }
  if (action.action === "done") { outcome = action.value ?? "COMPLETED"; break; }

  history.push({ action: action.action, target: action.target ?? null, value: action.value ?? null, effect: result.postAction?.effect ?? "unknown", ...(result.note ? { note: result.note } : {}), ...(result.trace?.target ? { label: result.trace.target } : {}) });
  if (result.navigateTo) await page.goto(result.navigateTo, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
}
console.log(`\nOUTCOME: ${outcome}\nfinal url: ${page.url()}`);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await browser.close();
