/**
 * Phase 6 real-Chrome tests: the product flow through the real popup UI.
 *
 *   - the task is typed into the popup field and started with the Run Task
 *     button (not by injecting a message), on the ShirtStore demo
 *   - the same typed task selects a different target when the prices change,
 *     with no code change (the target is chosen from page context)
 *   - a scroll task runs through validator and executor
 *   - the remembered task is prefilled but never auto-run
 *   - the icon set is served by the loaded extension
 *   - harmless real-website tasks on public pages without login: no purchase,
 *     no form, no typing; only sanitized text reaches the backend
 *
 * Needs the backend on :8000 (real key) and `npm run build`. Real-website
 * cases need internet access and are recorded exactly as observed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_INTERACTIVE_ELEMENTS } from "../src/content/element-ids";

const ROOT = resolve(__dirname, "..");
const DIST = resolve(ROOT, "dist");
const DEMO_DIR = resolve(ROOT, "../demo-site");
const DEMO_INDEX = resolve(DEMO_DIR, "index.html");
const DEMO_BASE = "http://localhost:8080";
const BACKEND = "http://localhost:8000";
const RAW_VALUES = ["demo@example.com", "9999999999", "DemoPassword123", "4111 1111 1111 1111", "4111111111111111", "123456"];

interface SeenRequest { url: string; method: string; postData: string | null; headers: Record<string, string>; at: number }
interface PopupState {
  stateWord: string;
  stateHint: string;
  badge: string;
  pageInfo: string;
  stages: Record<string, { state: string; detail: string }>;
  status: string[];
  payload: string;
  previewNote: string;
  previewShown: boolean;
  taskValue: string;
  runDisabled: boolean;
}

let context: BrowserContext;
let serviceWorker: Worker;
let extensionId: string;
let staticServer: ChildProcess | null = null;
const requests: SeenRequest[] = [];
const recorded: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const health = await fetch(`${BACKEND}/health`).catch(() => null);
  if (!health?.ok) throw new Error("backend is not reachable on :8000; start it with --env-file .env");
  if (!existsSync(resolve(DIST, "manifest.json"))) throw new Error("extension is not built; run npm run build");
  if (!(await fetch(`${DEMO_BASE}/index.html`).then((r) => r.ok).catch(() => false))) {
    staticServer = spawn("python", ["-m", "http.server", "8080"], { cwd: DEMO_DIR, stdio: "ignore" });
    await waitFor(() => fetch(`${DEMO_BASE}/index.html`).then((r) => r.ok).catch(() => false), 15_000);
  }
  // Automation cannot click the toolbar icon, so activeTab is never granted: test-only host permission.
  const testDist = mkdtempSync(resolve(tmpdir(), "privsight-p6-"));
  cpSync(DIST, testDist, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(testDist, "manifest.json"), "utf-8")) as { host_permissions: string[] };
  manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
  writeFileSync(resolve(testDist, "manifest.json"), JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), "privsight-p6-profile-")), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${testDist}`, `--load-extension=${testDist}`, "--window-size=1300,1000"],
  });
  context.on("request", (request) => {
    requests.push({ url: request.url(), method: request.method(), postData: request.postData(), headers: request.headers(), at: Date.now() });
  });
  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  extensionId = new URL(serviceWorker.url()).host;
}, 120_000);

afterAll(async () => {
  await context?.close();
  staticServer?.kill();
  writeFileSync(resolve(__dirname, "phase6-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), browser: "Playwright Chromium (headless) with the built extension", scenarios: recorded }, null, 2));
});

async function openPopup(): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  return popup;
}

async function activate(page: Page, url: string): Promise<number> {
  await page.bringToFront();
  const tabId = (await serviceWorker.evaluate(async (u: string) => (await chrome.tabs.query({ url: u }))[0]?.id, url)) as number | undefined;
  expect(tabId).toBeTypeOf("number");
  await serviceWorker.evaluate(async (id: number) => { await chrome.tabs.update(id, { active: true }); }, tabId as number);
  return tabId as number;
}

async function readPopup(popup: Page): Promise<PopupState> {
  return (await popup.evaluate(() => ({
    stateWord: document.getElementById("state-word")?.textContent ?? "",
    stateHint: document.getElementById("state-hint")?.textContent ?? "",
    badge: document.getElementById("privacy-badge")?.textContent ?? "",
    pageInfo: document.getElementById("page-info")?.textContent ?? "",
    stages: Object.fromEntries(Array.from(document.querySelectorAll<HTMLLIElement>("#pipeline li[data-stage]")).map((li) => [li.dataset.stage ?? "", { state: li.dataset.state ?? "", detail: li.title }])),
    status: Array.from(document.querySelectorAll("#status li")).map((li) => li.textContent ?? ""),
    payload: document.getElementById("payload")?.textContent ?? "",
    previewNote: document.getElementById("preview-note")?.textContent ?? "",
    previewShown: !(document.getElementById("preview-masked") as HTMLImageElement).hidden,
    taskValue: (document.getElementById("task") as HTMLTextAreaElement).value,
    runDisabled: (document.getElementById("run") as HTMLButtonElement).disabled,
  }))) as PopupState;
}

async function waitForTerminal(popup: Page, timeoutMs: number): Promise<PopupState> {
  const deadline = Date.now() + timeoutMs;
  let last: PopupState | null = null;
  while (Date.now() < deadline) {
    last = await readPopup(popup);
    if (["Complete", "Blocked", "Failed"].includes(last.stateWord) && !last.runDisabled) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`popup did not reach a terminal state. last: ${JSON.stringify(last)}`);
}

/** Runs a task exactly as a user would: type it into the field, press Run Task. */
async function runThroughUi(url: string, task: string, opts: { pageReady?: (page: Page) => Promise<void> } = {}) {
  const started = Date.now();
  const page = await context.newPage();
  const fullUrl = url.startsWith("http://localhost") ? `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}` : url;
  await page.goto(fullUrl, { waitUntil: "load", timeout: 60_000 });
  if (opts.pageReady) await opts.pageReady(page);
  const popup = await openPopup();
  await activate(page, fullUrl);
  await popup.fill("#task", task);
  await popup.click("#run");
  const state = await waitForTerminal(popup, 240_000);
  const scenarioRequests = requests.filter((r) => r.at >= started);
  const reasonBodies = scenarioRequests.filter((r) => r.url.endsWith("/reason") && r.method === "POST").map((r) => r.postData ?? "");
  const scrollY = (await page.evaluate(() => window.scrollY).catch(() => -1)) as number;
  const clicked = (await page.evaluate(() => document.querySelector(".buy-button.clicked")?.id ?? "(none)").catch(() => "(n/a)")) as string;
  const pageStatus = (await page.textContent("#purchase-status").catch(() => "")) ?? "";
  const finalUrl = page.url();
  await popup.close();
  await page.close();
  return { state, reasonBodies, scenarioRequests, scrollY, clicked, pageStatus, elapsedMs: Date.now() - started, url: fullUrl, finalUrl };
}

type Run = Awaited<ReturnType<typeof runThroughUi>>;

function assertExtensionTrafficIsSanitized(run: Run, allowedPageHosts: string[]): void {
  expect(run.reasonBodies.length).toBeGreaterThanOrEqual(1);
  for (const body of run.reasonBodies) {
    for (const value of RAW_VALUES) expect(body).not.toContain(value);
    expect(body).not.toMatch(/data:image|base64,|image\/(png|jpe?g)/i);
    expect(body).not.toMatch(/[A-Za-z0-9+/]{400,}/);
    const parsed = JSON.parse(body) as { task: string; page: { url: string }; visual?: unknown };
    expect(Object.keys(parsed).sort()).toEqual(["page", "placeholders", "task", "visual"].filter((k) => k !== "visual" || parsed.visual !== undefined).sort());
  }
  // The extension's only network call is POST /reason to the local backend. Everything else the
  // browser did must be the page's own traffic to its own hosts (a real site may post its own
  // analytics beacons), and none of it may carry what the extension holds: the task or the
  // sanitized body.
  const task = (JSON.parse(run.reasonBodies[0]) as { task: string }).task;
  for (const request of run.scenarioRequests) {
    const url = new URL(request.url);
    if (url.protocol === "chrome-extension:" || url.protocol === "data:" || url.protocol === "blob:") continue;
    if (request.url.endsWith("/reason")) {
      expect(url.host).toBe("localhost:8000");
      continue;
    }
    expect(allowedPageHosts.some((h) => url.host === h || url.host.endsWith(`.${h}`)), `unexpected host ${url.host}`).toBe(true);
    if (request.postData) {
      expect(request.postData, `page-origin request carried the task: ${request.method} ${request.url}`).not.toContain(task);
      expect(request.postData).not.toContain('"placeholders"');
      for (const value of RAW_VALUES) expect(request.postData).not.toContain(value);
    }
  }
}

function withPrices(prices: { A: number; B: number; C: number }, run: () => Promise<void>): Promise<void> {
  const backup = readFileSync(DEMO_INDEX, "utf-8");
  let html = backup;
  for (const [letter, price] of Object.entries(prices)) {
    html = html.replace(new RegExp(`(<h2>Black Shirt ${letter}</h2>\\s*<p class="price">Price: ₹)\\d+(</p>)`), `$1${price}$2`);
  }
  writeFileSync(DEMO_INDEX, html, "utf-8");
  return run().finally(() => writeFileSync(DEMO_INDEX, backup, "utf-8"));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("timed out waiting");
}

function record(name: string, run: Run, extra: Record<string, unknown> = {}): void {
  const action = run.state.status.find((s) => s.startsWith("Action received:")) ?? "";
  recorded.push({
    name, url: run.url.replace(/[?&]_=\d+$/, ""), elapsedMs: run.elapsedMs, state: run.state.stateWord, badge: run.state.badge, pageInfo: run.state.pageInfo,
    stages: run.state.stages, status: run.state.status, actionLine: action, clicked: run.clicked, pageStatus: run.pageStatus, scrollY: run.scrollY,
    reasonRequests: run.reasonBodies.length, reasonBodyBytes: run.reasonBodies.map((b) => b.length),
    requests: run.scenarioRequests.map((q) => ({ method: q.method, host: new URL(q.url).host, postBytes: q.postData?.length ?? 0 })),
    ...extra,
  });
  console.log(`\n[${name}] ${run.elapsedMs} ms | state=${run.state.stateWord} | badge=${run.state.badge} | clicked=${run.clicked} | scrollY=${run.scrollY}`);
  console.log(`  page: ${run.state.pageInfo}`);
  console.log(`  ${action}`);
  console.log(`  stages: ${Object.entries(run.state.stages).map(([s, v]) => `${s}=${v.state}`).join(" ")}`);
}

describe("Phase 6: product flow through the real popup", () => {
  it("icon set is served by the loaded extension and declared in the manifest", async () => {
    const manifest = (await serviceWorker.evaluate(() => chrome.runtime.getManifest())) as { icons?: Record<string, string>; action?: { default_icon?: Record<string, string> } };
    expect(manifest.icons).toEqual({ "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" });
    expect(manifest.action?.default_icon?.["32"]).toBe("icons/icon-32.png");
    const page = await context.newPage();
    for (const size of [16, 32, 48, 128]) {
      const response = await page.goto(`chrome-extension://${extensionId}/icons/icon-${size}.png`);
      expect(response?.ok(), `icon-${size}.png not served`).toBe(true);
      const bytes = await response!.body();
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    }
    await page.close();
  });

  it("controlled demo: typed task, Run Task button, target chosen from page context (C cheapest)", async () => {
    const run = await runThroughUi(`${DEMO_BASE}/index.html`, "Find the cheapest black shirt and buy it");
    record("demo-typed-task", run);
    expect(run.state.stateWord).toBe("Complete");
    expect(run.state.badge).toBe("PROTECTED");
    expect(run.state.stages.vision.state).toBe("pass");
    expect(run.state.stages.firewall.state).toBe("pass");
    expect(run.state.stages.validate.state).toBe("pass");
    expect(run.state.stages.execute.state).toBe("pass");
    expect(run.state.pageInfo).toMatch(/interactive element/);
    expect(run.state.previewShown).toBe(true);
    expect(run.clicked).toBe("buy_c");
    expect(run.pageStatus).toContain("Black Shirt C Purchased");
    assertExtensionTrafficIsSanitized(run, ["localhost:8080"]);
    const body = JSON.parse(run.reasonBodies[0]) as { task: string };
    expect(body.task).toBe("Find the cheapest black shirt and buy it");
  });

  it("same typed task, prices reordered (A cheapest): a different target, no code change", async () => {
    await withPrices({ A: 499, B: 899, C: 699 }, async () => {
      const run = await runThroughUi(`${DEMO_BASE}/index.html`, "Find the cheapest black shirt and buy it");
      record("demo-prices-reordered", run);
      expect(run.state.stateWord).toBe("Complete");
      expect(run.clicked).toBe("buy_a");
      expect(run.pageStatus).toContain("Black Shirt A Purchased");
      assertExtensionTrafficIsSanitized(run, ["localhost:8080"]);
    });
  });

  it("scroll task: the action passes the validator and the executor scrolls the page", async () => {
    const run = await runThroughUi(`${DEMO_BASE}/index.html`, "Scroll down the page to see the delivery details section");
    record("demo-scroll", run);
    assertExtensionTrafficIsSanitized(run, ["localhost:8080"]);
    expect(run.state.stages.validate.state).toBe("pass");
    expect(run.state.stages.execute.state).toBe("pass");
    expect(run.state.status.some((s) => /^Action received: scroll/.test(s))).toBe(true);
    expect(run.scrollY).toBeGreaterThan(0);
    expect(run.clicked).toBe("(none)");
  });

  it("remembered task is prefilled on the next popup open and is never auto-run", async () => {
    const before = requests.length;
    const popup = await openPopup();
    await new Promise((r) => setTimeout(r, 2000));
    const state = await readPopup(popup);
    expect(state.taskValue).toBe("Scroll down the page to see the delivery details section");
    expect(state.stateWord).toBe("Idle");
    expect(requests.slice(before).filter((r) => r.url.endsWith("/reason"))).toHaveLength(0);
    await popup.close();
  });

  it("empty task is refused locally without any request", async () => {
    const before = requests.length;
    const popup = await openPopup();
    await popup.fill("#task", "   ");
    await popup.click("#run");
    await new Promise((r) => setTimeout(r, 800));
    const state = await readPopup(popup);
    expect(state.status).toContain("Enter a task first");
    expect(state.stateWord).toBe("Idle");
    expect(requests.slice(before).filter((r) => r.url.endsWith("/reason"))).toHaveLength(0);
    await popup.close();
  });

  it("a task containing an email address is redacted before it reaches the cloud", async () => {
    const run = await runThroughUi(`${DEMO_BASE}/index.html`, "Find the cheapest black shirt for demo@example.com and buy it");
    record("demo-task-with-pii", run);
    assertExtensionTrafficIsSanitized(run, ["localhost:8080"]);
    const body = JSON.parse(run.reasonBodies[0]) as { task: string; placeholders: string[] };
    expect(body.task).not.toContain("demo@example.com");
    expect(body.task).toMatch(/\[EMAIL_\d+\]/);
  });
});

describe("Phase 6: harmless real-website preparation (public pages, no login, no consequential action)", () => {
  const online = async () => fetch("https://example.com/", { method: "HEAD" }).then((r) => r.ok).catch(() => false);

  it("example.com: 'Find the page heading' produces a validated, harmless action", async () => {
    if (!(await online())) {
      recorded.push({ name: "real-example-com", skipped: "no internet access" });
      console.log("\n[real-example-com] SKIPPED: no internet access");
      return;
    }
    const run = await runThroughUi("https://example.com/", "Find the main page heading and report it. Do not click anything.");
    record("real-example-com", run, { website: "https://example.com/" });
    assertExtensionTrafficIsSanitized(run, ["example.com"]);
    expect(run.state.stages.dom.state).toBe("pass");
    expect(["pass", "fallback"]).toContain(run.state.stages.vision.state);
    expect(run.state.stages.firewall.state).toBe("pass");
    expect(run.state.stages.reason.state).toBe("pass");
    expect(["Complete", "Blocked"]).toContain(run.state.stateWord);
    const action = run.state.status.find((s) => s.startsWith("Action received:")) ?? "";
    expect(action).toMatch(/^Action received: (done|scroll|click)/);
    if (run.state.stateWord === "Complete") expect(run.state.stages.validate.state).toBe("pass");
  });

  it("wikipedia.org main page: 'Find the search box' on a large real DOM", async () => {
    if (!(await online())) {
      recorded.push({ name: "real-wikipedia", skipped: "no internet access" });
      return;
    }
    const run = await runThroughUi("https://en.wikipedia.org/wiki/Main_Page", "Find the search box on this page. Do not type anything and do not submit anything.");
    record("real-wikipedia", run, { website: "https://en.wikipedia.org/wiki/Main_Page" });
    assertExtensionTrafficIsSanitized(run, ["wikipedia.org", "wikimedia.org"]);
    const body = JSON.parse(run.reasonBodies[0]) as { page: { elements: Array<{ id: string; tag: string; role: string }> } };
    expect(body.page.elements.length).toBeLessThanOrEqual(MAX_INTERACTIVE_ELEMENTS);
    expect(body.page.elements.length).toBeGreaterThan(20);
    expect(run.state.stages.firewall.state).toBe("pass");
    expect(run.state.stages.reason.state).toBe("pass");
    const action = run.state.status.find((s) => s.startsWith("Action received:")) ?? "";
    expect(action).toMatch(/^Action received: (done|scroll|click)/);
    // Whatever was chosen, nothing was typed or submitted: the page is still the main page.
    expect(run.finalUrl).toContain("Main_Page");
    recorded[recorded.length - 1] = { ...recorded[recorded.length - 1], elementsSent: body.page.elements.length, searchBoxOffered: body.page.elements.some((e) => e.role === "textbox" || e.tag === "input") };
  });
});
