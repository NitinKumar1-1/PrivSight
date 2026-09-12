/**
 * Phase 5 browser benchmark: repeated end-to-end runs of the BUILT extension
 * in Playwright Chromium against the live backend, with every network
 * request recorded. Writes:
 *   evaluation/results/latency.json         per-run stage timings + distribution
 *   evaluation/results/network-results.json sanitized evidence per /reason request
 *
 * Needs the backend on :8000 (real key) and `npm run build`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const DIST = resolve(ROOT, "dist");
const DEMO_DIR = resolve(ROOT, "../demo-site");
const DEMO_INDEX = resolve(DEMO_DIR, "index.html");
const RESULTS = resolve(ROOT, "evaluation/results");
const DEMO_BASE = "http://localhost:8080";
const BACKEND = "http://localhost:8000";
const TASK = "Find the cheapest black shirt and click Buy Now";
const RAW_VALUES = ["demo@example.com", "9999999999", "DemoPassword123", "4111 1111 1111 1111", "4111111111111111", "123456"];
const NORMAL_RUNS = 10;
const SWAP_RUNS_PER_CASE = 2;

interface SeenRequest { url: string; method: string; postData: string | null; headers: Record<string, string>; at: number }
interface Run {
  scenario: string; kind: "normal" | "price-swap" | "dynamic" | "stale"; expectedTarget?: string; clicked: string; pageStatus: string;
  success: boolean; rounds: number; elapsedMs: number; metrics: Record<string, number>; stages: Record<string, string>; reasonRequests: number; cold: boolean;
}

let context: BrowserContext;
let serviceWorker: Worker;
let extensionId: string;
let staticServer: ChildProcess | null = null;
const requests: SeenRequest[] = [];
const runs: Run[] = [];
const network: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const health = await fetch(`${BACKEND}/health`).catch(() => null);
  if (!health?.ok) throw new Error("backend is not reachable on :8000");
  if (!existsSync(resolve(DIST, "manifest.json"))) throw new Error("extension is not built; run npm run build");
  if (!(await fetch(`${DEMO_BASE}/index.html`).then((r) => r.ok).catch(() => false))) {
    staticServer = spawn("python", ["-m", "http.server", "8080"], { cwd: DEMO_DIR, stdio: "ignore" });
    await waitFor(() => fetch(`${DEMO_BASE}/index.html`).then((r) => r.ok).catch(() => false), 15_000);
  }
  const testDist = mkdtempSync(resolve(tmpdir(), "privsight-bench-"));
  cpSync(DIST, testDist, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(testDist, "manifest.json"), "utf-8")) as { host_permissions: string[] };
  // captureVisibleTab requires <all_urls> or activeTab; a host match alone is refused.
  // Test-only: a real toolbar click grants activeTab. dist/ is not modified.
  manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
  writeFileSync(resolve(testDist, "manifest.json"), JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), "privsight-bench-profile-")), {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${testDist}`, `--load-extension=${testDist}`, "--window-size=1300,1000"],
  });
  context.on("request", (r) => requests.push({ url: r.url(), method: r.method(), postData: r.postData(), headers: r.headers(), at: Date.now() }));
  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  extensionId = new URL(serviceWorker.url()).host;
}, 120_000);

afterAll(async () => {
  await context?.close();
  staticServer?.kill();
  mkdirSync(RESULTS, { recursive: true });
  const normal = runs.filter((r) => r.kind === "normal" && r.success && r.rounds === 1);
  const dist = (key: string, set: Run[]) => stats(set.map((r) => r.metrics[key]).filter((v) => Number.isFinite(v)));
  const latency = {
    generatedAt: new Date().toISOString(),
    browser: "Playwright Chromium (headless) with the built extension; backend on localhost:8000; Gemini cloud reasoning",
    definitions: {
      total: "popup Run to execution result (controller total)",
      local_perception: "capture + OCR (+ engine load on the cold run)",
      privacy: "content script: DOM settle wait + extraction + fusion + redaction + firewall",
      cloud: "POST /reason round trip incl. backend and Gemini",
      validate_execute: "validator + executor in the content script",
    },
    normal_one_round: {
      runs: normal.length,
      cold_runs: normal.filter((r) => r.cold).length,
      total_ms: dist("Total", normal), local_perception_ms: dist("Local perception", normal), ocr_recognize_ms: dist("OCR recognize", normal),
      capture_ms: dist("Capture", normal), privacy_ms: dist("Privacy processing", normal), cloud_ms: dist("Cloud reasoning", normal), validate_execute_ms: dist("Validate + execute", normal),
      breakdown_share_of_total_mean: shareOfTotal(normal),
      warm_only: { runs: normal.filter((r) => !r.cold).length, total_ms: dist("Total", normal.filter((r) => !r.cold)), local_perception_ms: dist("Local perception", normal.filter((r) => !r.cold)) },
      cold_only: { runs: normal.filter((r) => r.cold).length, total_ms: dist("Total", normal.filter((r) => r.cold)), local_perception_ms: dist("Local perception", normal.filter((r) => r.cold)), ocr_load_ms: dist("OCR load", normal.filter((r) => r.cold)) },
    },
    price_swap: runs.filter((r) => r.kind === "price-swap").map((r) => ({ scenario: r.scenario, expected: r.expectedTarget, clicked: r.clicked, success: r.success, totalMs: r.metrics.Total, cloudMs: r.metrics["Cloud reasoning"], rounds: r.rounds })),
    dynamic: runs.filter((r) => r.kind === "dynamic").map((r) => ({ scenario: r.scenario, clicked: r.clicked, success: r.success, totalMs: r.metrics.Total, rounds: r.rounds })),
    stale: runs.filter((r) => r.kind === "stale").map((r) => ({ scenario: r.scenario, clicked: r.clicked, rounds: r.rounds, totalMs: r.metrics.Total, reasonRequests: r.reasonRequests, safe: r.clicked === "(none)" })),
    all_runs: runs,
  };
  writeFileSync(resolve(RESULTS, "latency.json"), JSON.stringify(latency, null, 2));
  writeFileSync(resolve(RESULTS, "network-results.json"), JSON.stringify({ generatedAt: latency.generatedAt, note: "Evidence per /reason request from real browser traffic. Bodies were verified sanitized; only field presence, sizes and placeholder names are stored.", requests: network }, null, 2));
  console.log("\nLATENCY SUMMARY\n" + JSON.stringify({ normal: latency.normal_one_round, price_swap: latency.price_swap, stale: latency.stale }, null, 2));
});

async function runScenario(path: string, kind: Run["kind"], expectedTarget?: string): Promise<Run> {
  const started = Date.now();
  const page = await context.newPage();
  const url = `${DEMO_BASE}/${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`;
  await page.goto(url, { waitUntil: "load" });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.bringToFront();
  // Make the demo tab the active tab of its window through the extension API as well:
  // captureVisibleTab only captures the active tab, and bringToFront alone is not always enough in headless mode.
  const tabId = await serviceWorker.evaluate(async (u: string) => (await chrome.tabs.query({ url: u }))[0]?.id, url);
  await serviceWorker.evaluate(async (id: number) => { await chrome.tabs.update(id, { active: true }); }, tabId as number);
  await popup.evaluate(({ task, tabId }) => chrome.runtime.sendMessage({ type: "RUN_TASK", task, tabId }), { task: TASK, tabId });
  const state = await waitForPopup(popup, 240_000);
  const pageStatus = (await page.textContent("#purchase-status").catch(() => "")) ?? "";
  const clicked = (await page.evaluate(() => document.querySelector(".buy-button.clicked")?.id ?? "(none)")) as string;
  const mine = requests.filter((r) => r.at >= started);
  const reasonBodies = mine.filter((r) => r.url.endsWith("/reason") && r.method === "POST").map((r) => r.postData ?? "");
  for (const body of reasonBodies) recordNetwork(path, body);
  assertTraffic(mine);
  await popup.close();
  await page.close();

  const metrics = Object.fromEntries(Object.entries(state.metrics).map(([k, v]) => [k, Number(String(v).replace(/[^\d.]/g, ""))]));
  const run: Run = {
    scenario: path, kind, expectedTarget, clicked, pageStatus,
    success: state.stages.execute === "pass" && (expectedTarget ? clicked === expectedTarget.replace("el_", "") : true),
    rounds: metrics.Round || 1, elapsedMs: Date.now() - started, metrics, stages: state.stages, reasonRequests: reasonBodies.length, cold: (metrics["OCR load"] ?? 0) > 0,
  };
  if (state.stages.vision !== "pass") console.log(`  vision ${state.stages.vision}: ${state.details.vision}`);
  runs.push(run);
  console.log(`[${kind}] ${path} -> ${clicked} in ${metrics.Total} ms (cloud ${metrics["Cloud reasoning"]} ms, ocr ${metrics["OCR recognize"]} ms, rounds ${run.rounds}${run.cold ? ", cold" : ""})`);
  return run;
}

function recordNetwork(scenario: string, body: string): void {
  const parsed = JSON.parse(body) as { task: string; page: { text: string; elements: unknown[] }; placeholders: string[]; visual?: { observations: unknown[]; conflicts: string[] } };
  network.push({
    scenario, bytes: body.length, fields: Object.keys(parsed), placeholders: parsed.placeholders, elements: parsed.page.elements.length,
    page_text_chars: parsed.page.text.length, visual_observations: parsed.visual?.observations.length ?? 0, visual_conflicts: parsed.visual?.conflicts.length ?? 0,
    raw_pii_present: RAW_VALUES.some((v) => body.includes(v)), image_data_present: /data:image|base64,|image\/(png|jpe?g)/i.test(body), base64_run_present: /[A-Za-z0-9+/]{400,}/.test(body),
  });
}

function assertTraffic(mine: SeenRequest[]): void {
  for (const r of mine) {
    const u = new URL(r.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    expect(["localhost:8080", "localhost:8000"], `unexpected host ${u.host}`).toContain(u.host);
    if (r.postData) {
      for (const v of RAW_VALUES) expect(r.postData).not.toContain(v);
      expect(r.postData).not.toMatch(/data:\s*image|image\/(png|jpe?g|webp)|base64,|[A-Za-z0-9+/]{400,}/);
    }
    expect(r.headers["content-type"] ?? "").not.toMatch(/image\/|multipart\//);
  }
}

async function waitForPopup(popup: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: { stages: Record<string, string>; details: Record<string, string>; metrics: Record<string, string>; status: string[] } | null = null;
  while (Date.now() < deadline) {
    last = (await popup.evaluate(() => ({
      stages: Object.fromEntries(Array.from(document.querySelectorAll<HTMLLIElement>("#pipeline li[data-stage]")).map((li) => [li.dataset.stage ?? "", li.dataset.state ?? ""])),
      details: Object.fromEntries(Array.from(document.querySelectorAll<HTMLLIElement>("#pipeline li[data-stage]")).map((li) => [li.dataset.stage ?? "", li.title])),
      metrics: Object.fromEntries(Array.from(document.querySelectorAll("#metrics dt")).map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""])),
      status: Array.from(document.querySelectorAll("#status li")).map((li) => li.textContent ?? ""),
      terminal: ["Complete", "Blocked", "Failed"].includes(document.getElementById("state-word")?.textContent ?? "") && !(document.getElementById("run") as HTMLButtonElement).disabled,
    }))) as typeof last & { terminal: boolean };
    if ((last as { terminal?: boolean }).terminal) return last!;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("popup did not finish");
}

function withPrices(prices: { A: number; B: number; C: number }, run: () => Promise<void>): Promise<void> {
  const backup = readFileSync(DEMO_INDEX, "utf-8");
  let html = backup;
  for (const [letter, price] of Object.entries(prices)) html = html.replace(new RegExp(`(<h2>Black Shirt ${letter}</h2>\\s*<p class="price">Price: ₹)\\d+(</p>)`), `$1${price}$2`);
  writeFileSync(DEMO_INDEX, html, "utf-8");
  return run().finally(() => writeFileSync(DEMO_INDEX, backup, "utf-8"));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 300)); }
  throw new Error("timed out waiting");
}

function stats(values: number[]) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return { n: s.length, min: s[0], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length), median: s[Math.floor(s.length / 2)], p95: s.length >= 5 ? p(0.95) : null, max: s[s.length - 1] };
}
function shareOfTotal(set: Run[]) {
  if (set.length === 0) return null;
  const mean = (k: string) => set.reduce((a, r) => a + (r.metrics[k] ?? 0), 0) / set.length;
  const total = mean("Total") || 1;
  const pct = (k: string) => Math.round((mean(k) / total) * 1000) / 10;
  return { local_perception_pct: pct("Local perception"), privacy_pct: pct("Privacy processing"), cloud_pct: pct("Cloud reasoning"), validate_execute_pct: pct("Validate + execute"), capture_pct: pct("Capture") };
}

describe("Phase 5 browser benchmark", () => {
  it(`${NORMAL_RUNS} normal end-to-end runs on the current page`, async () => {
    for (let i = 0; i < NORMAL_RUNS; i++) {
      const r = await runScenario("index.html", "normal", "el_buy_c");
      expect(r.success, `run ${i + 1} failed: ${r.pageStatus}`).toBe(true);
      expect(r.stages.vision, `run ${i + 1}: local vision did not run`).toBe("pass");
    }
  }, 600_000);

  it("price swaps: A cheapest and B cheapest, repeated", async () => {
    await withPrices({ A: 499, B: 899, C: 699 }, async () => { for (let i = 0; i < SWAP_RUNS_PER_CASE; i++) expect((await runScenario("index.html", "price-swap", "el_buy_a")).success).toBe(true); });
    await withPrices({ A: 999, B: 399, C: 699 }, async () => { for (let i = 0; i < SWAP_RUNS_PER_CASE; i++) expect((await runScenario("index.html", "price-swap", "el_buy_b")).success).toBe(true); });
    for (let i = 0; i < SWAP_RUNS_PER_CASE; i++) expect((await runScenario("index.html", "price-swap", "el_buy_c")).success).toBe(true);
  }, 900_000);

  it("dynamic DOM and stale target", async () => {
    expect((await runScenario("dynamic.html?delay=1500", "dynamic", "el_buy_c")).success).toBe(true);
    const stale = await runScenario("dynamic.html?delay=300&vanish=4000", "stale");
    expect(stale.clicked).toBe("(none)");
    expect(stale.reasonRequests).toBeGreaterThanOrEqual(2);
  }, 600_000);
});
