/**
 * Real-Chrome end-to-end tests.
 *
 * Loads the BUILT extension into Playwright's Chromium (same Blink/V8 and
 * extension platform as Chrome; branded Chrome 137+ ignores --load-extension)
 * in headless mode, opens the demo pages served from demo-site/, runs the
 * local agent through the real popup page, and records every network request
 * the browser makes. Assertions are made on the real traffic, the real popup
 * state, and the real page state.
 *
 * Needs the backend on :8000 (real key) and `npm run build`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Request, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const DIST = resolve(ROOT, "dist");
const DEMO_DIR = resolve(ROOT, "../demo-site");
const DEMO_INDEX = resolve(DEMO_DIR, "index.html");
const DEMO_BASE = "http://localhost:8080";
const BACKEND = "http://localhost:8000";
const TASK = "Find the cheapest black shirt and click Buy Now";
const RAW_VALUES = ["demo@example.com", "9999999999", "DemoPassword123", "4111 1111 1111 1111", "4111111111111111", "123456"];
const EXTERNAL_HOSTS_ALLOWED = new Set(["localhost:8080", "localhost:8000", "127.0.0.1:8080", "127.0.0.1:8000"]);

interface SeenRequest {
  url: string;
  method: string;
  postData: string | null;
  headers: Record<string, string>;
  at: number;
}

interface PopupState {
  terminal: boolean;
  stages: Array<[string, string, string]>;
  status: string[];
  badge: string;
  payload: string;
  previewNote: string;
  metrics: Record<string, string>;
}

let context: BrowserContext;
let serviceWorker: Worker;
let extensionId: string;
let staticServer: ChildProcess | null = null;
const requests: SeenRequest[] = [];
/** Everything observed per scenario; written to e2e/chrome-results.json (bodies are the sanitized wire bytes). */
const recorded: Array<Record<string, unknown>> = [];
/** Console errors and uncaught exceptions from every extension page (popup, offscreen document). */
const consoleErrors: string[] = [];

beforeAll(async () => {
  const health = await fetch(`${BACKEND}/health`).catch(() => null);
  if (!health?.ok) throw new Error("backend is not reachable on :8000; start it with --env-file .env");
  if (!existsSync(resolve(DIST, "manifest.json"))) throw new Error("extension is not built; run npm run build");

  if (!(await fetch(`${DEMO_BASE}/index.html`).then((r) => r.ok).catch(() => false))) {
    staticServer = spawn("python", ["-m", "http.server", "8080"], { cwd: DEMO_DIR, stdio: "ignore" });
    await waitFor(() => fetch(`${DEMO_BASE}/index.html`).then((r) => r.ok).catch(() => false), 15_000);
  }

  // Automation cannot click the toolbar icon, so activeTab is never granted.
  // Load a throwaway copy of the build whose manifest adds a host permission
  // for the demo server only. dist/ itself is not modified.
  const testDist = mkdtempSync(resolve(tmpdir(), "privsight-ext-"));
  cpSync(DIST, testDist, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(testDist, "manifest.json"), "utf-8")) as { host_permissions: string[] };
  manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"]; // test-only; a real toolbar click grants activeTab instead
  writeFileSync(resolve(testDist, "manifest.json"), JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), "privsight-e2e-")), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${testDist}`, `--load-extension=${testDist}`, "--window-size=1300,1000"],
  });
  context.on("page", (p) => {
    p.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") consoleErrors.push(`[${m.type()}] ${p.url()} :: ${m.text()}`);
    });
    p.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${p.url()} :: ${e.message}`));
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
  writeFileSync(
    resolve(__dirname, "chrome-results.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), browser: "Playwright Chromium (headless) with the built extension", scenarios: recorded }, null, 2),
  );
});

interface ScenarioResult {
  popup: PopupState;
  pageStatus: string;
  clicked: string;
  reasonBodies: string[];
  allRequests: SeenRequest[];
  elapsedMs: number;
}

interface ScenarioHooks {
  /** Runs once, the moment the first sanitized /reason request leaves the browser: after the DOM was read, before any action can arrive. */
  onFirstReason?: (page: Page) => Promise<void>;
}

async function runScenario(path: string, task = TASK, hooks: ScenarioHooks = {}): Promise<ScenarioResult> {
  const started = Date.now();
  const page = await context.newPage();
  const url = `${DEMO_BASE}/${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`;
  await page.goto(url, { waitUntil: "load" });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.bringToFront(); // the demo tab must be the visible tab for capture
  // Make the demo tab the active tab of its window through the extension API as well:
  // captureVisibleTab only captures the active tab, and bringToFront alone is not always enough in headless mode.

  const tabId = await serviceWorker.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0]?.id;
  }, url);
  expect(tabId).toBeTypeOf("number");
  await serviceWorker.evaluate(async (id: number) => { await chrome.tabs.update(id, { active: true }); }, tabId as number);

  if (hooks.onFirstReason) {
    let fired = false;
    const onRequest = (request: Request) => {
      if (fired || !request.url().endsWith("/reason") || request.method() !== "POST") return;
      fired = true;
      context.off("request", onRequest);
      void hooks.onFirstReason?.(page);
    };
    context.on("request", onRequest);
  }

  await popup.evaluate(
    ({ task, tabId }) => {
      (document.getElementById("task") as HTMLTextAreaElement).value = task;
      // Same message the Run button sends, with the tab made explicit for automation.
      return chrome.runtime.sendMessage({ type: "RUN_TASK", task, tabId });
    },
    { task, tabId },
  );

  const popupState = await waitForPopup(popup, 240_000);
  const pageStatus = (await page.textContent("#purchase-status").catch(() => "")) ?? "";
  const clicked = (await page.evaluate(() => document.querySelector(".buy-button.clicked")?.id ?? "(none)")) as string;
  const scenarioRequests = requests.filter((r) => r.at >= started);
  const reasonBodies = scenarioRequests.filter((r) => r.url.endsWith("/reason") && r.method === "POST").map((r) => r.postData ?? "");

  await popup.close();
  await page.close();
  return { popup: popupState, pageStatus, clicked, reasonBodies, allRequests: scenarioRequests, elapsedMs: Date.now() - started };
}

async function waitForPopup(popup: Page, timeoutMs: number): Promise<PopupState> {
  const deadline = Date.now() + timeoutMs;
  let last: PopupState | null = null;
  while (Date.now() < deadline) {
    last = (await popup.evaluate(() => ({
      stages: Array.from(document.querySelectorAll<HTMLLIElement>("#pipeline li[data-stage]")).map((li) => [li.dataset.stage ?? "", li.dataset.state ?? "", li.title]),
      status: Array.from(document.querySelectorAll("#status li")).map((li) => li.textContent ?? ""),
      badge: document.getElementById("privacy-badge")?.textContent ?? "",
      payload: document.getElementById("payload")?.textContent ?? "",
      previewNote: document.getElementById("preview-note")?.textContent ?? "",
      terminal: ["Complete", "Blocked", "Failed"].includes(document.getElementById("state-word")?.textContent ?? "") && !(document.getElementById("run") as HTMLButtonElement).disabled,
      metrics: Object.fromEntries(
        Array.from(document.querySelectorAll("#metrics dt")).map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]),
      ),
    }))) as PopupState;
    // Phase 7: a run may take several steps; wait for the terminal state so the next scenario never overlaps a live run.
    if (last.terminal) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`popup did not finish in time. last state: ${JSON.stringify(last)}`);
}

function stage(state: PopupState, name: string): [string, string] {
  const row = state.stages.find(([s]) => s === name);
  return row ? [row[1], row[2]] : ["missing", ""];
}

function assertTrafficIsSanitized(result: ScenarioResult, expectVisual: boolean): void {
  expect(result.reasonBodies.length).toBeGreaterThanOrEqual(1);
  for (const body of result.reasonBodies) {
    for (const value of RAW_VALUES) expect(body).not.toContain(value);
    expect(body.replace(/[\s-]/g, "")).not.toContain("4111111111111111");
    expect(body).not.toMatch(/data:image|base64,|image\/(png|jpe?g)/i);
    expect(body).not.toMatch(/[A-Za-z0-9+/]{400,}/);
    const parsed = JSON.parse(body) as { placeholders: string[]; visual?: { engine: string; observations: unknown[] } };
    if (expectVisual) {
      expect(parsed.visual, "visual block missing from /reason body").toBeDefined();
      expect(parsed.visual?.engine).toContain("tesseract");
      expect(Array.isArray(parsed.visual?.observations)).toBe(true);
    }
  }
  for (const request of result.allRequests) {
    const url = new URL(request.url);
    if (url.protocol === "chrome-extension:" || url.protocol === "data:" || url.protocol === "blob:") continue;
    expect(EXTERNAL_HOSTS_ALLOWED.has(url.host), `unexpected host ${url.host}`).toBe(true);
    expect(request.method === "GET" || request.url.endsWith("/reason"), `unexpected ${request.method} ${request.url}`).toBe(true);
    if (request.postData) {
      // No screenshot in any form: data URLs, MIME markers, PNG/JPEG signatures, base64 runs, multipart.
      expect(request.postData).not.toMatch(/data:\s*image|image\/(png|jpe?g|webp)|\u0089PNG|\bIHDR\b|\xff\xd8\xff|--WebKitFormBoundary/);
      expect(request.postData).not.toMatch(/[A-Za-z0-9+/]{400,}={0,2}/);
      expect(request.postData.length, "request body far larger than a text payload").toBeLessThan(60_000);
      for (const value of RAW_VALUES) expect(request.postData).not.toContain(value);
    }
    const contentType = request.headers["content-type"] ?? "";
    expect(contentType).not.toMatch(/image\/|multipart\/|octet-stream/);
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

function log(name: string, r: ScenarioResult): void {
  recorded.push({
    name,
    elapsedMs: r.elapsedMs,
    badge: r.popup.badge,
    pageStatus: r.pageStatus,
    clicked: r.clicked,
    stages: Object.fromEntries(r.popup.stages.map(([st, state, detail]) => [st, { state, detail }])),
    metrics: r.popup.metrics,
    status: r.popup.status,
    requests: r.allRequests.map((q) => ({ method: q.method, url: q.url, postBytes: q.postData?.length ?? 0, contentType: q.headers["content-type"] ?? "" })),
    reasonBodies: r.reasonBodies,
  });
  console.log(`\n[${name}] ${r.elapsedMs} ms | badge=${r.popup.badge} | page="${r.pageStatus}" | clicked=${r.clicked}`);
  console.log(`  stages: ${r.popup.stages.map(([s, st]) => `${s}=${st}`).join(" ")}`);
  if (consoleErrors.length) console.log(`  console errors:` + consoleErrors.splice(0).map((e) => `\n    ${e}`).join(""));
  for (const [s, st, detail] of r.popup.stages) if (detail && (st === "fallback" || st === "fail" || s === "vision" || s === "visual-redaction")) console.log(`    ${s}: ${detail}`);
  console.log(`  metrics: ${JSON.stringify(r.popup.metrics)}`);
  console.log(`  status: ${r.popup.status.join(" | ")}`);
  console.log(`  requests: ${r.allRequests.map((q) => `${q.method} ${q.url}`).join(", ")}`);
}

describe("real Chrome: local agent through the built extension", () => {
  it("DOM + vision on index.html: C is cheapest, traffic is sanitized, no image leaves", async () => {
    const r = await runScenario("index.html");
    log("index", r);
    expect(stage(r.popup, "vision")[0]).toBe("pass");
    expect(stage(r.popup, "firewall")[0]).toBe("pass");
    expect(stage(r.popup, "validate")[0]).toBe("pass");
    expect(stage(r.popup, "execute")[0]).toBe("pass");
    expect(r.popup.badge).toBe("PROTECTED");
    expect(r.pageStatus).toContain("Black Shirt C Purchased");
    expect(r.clicked).toBe("buy_c");
    assertTrafficIsSanitized(r, true);
  });

  it("visual fallback on visual.html: canvas-only price reaches the cloud as sanitized text and C is chosen", async () => {
    const r = await runScenario("visual.html");
    log("visual", r);
    expect(stage(r.popup, "vision")[0]).toBe("pass");
    expect(stage(r.popup, "execute")[0]).toBe("pass");
    expect(r.pageStatus).toContain("Black Shirt C Purchased");
    assertTrafficIsSanitized(r, true);
    const body = JSON.parse(r.reasonBodies[0]) as { page: { text: string }; visual: { observations: Array<{ text: string; type: string; target: string | null }> } };
    expect(body.page.text).not.toContain("699"); // DOM lacks the canvas price
    const texts = body.visual.observations.map((o) => o.text.toLowerCase());
    expect(texts.some((t) => t.includes("black shirt c"))).toBe(true);
    expect(texts.some((t) => /699/.test(t))).toBe(true);
    for (const o of body.visual.observations) if (o.target) expect(o.target).toMatch(/^el_/);
  });

  it("visual PII on visual-privacy.html: canvas-only PII is masked locally and only placeholders cross", async () => {
    const r = await runScenario("visual-privacy.html");
    log("visual-privacy", r);
    expect(stage(r.popup, "vision")[0]).toBe("pass");
    expect(stage(r.popup, "visual-redaction")[0]).toBe("pass");
    expect(stage(r.popup, "firewall")[0]).toBe("pass");
    expect(r.popup.previewNote).toMatch(/[4-9]\d* region\(s\) masked locally|[1-9]\d+ region\(s\) masked locally/);
    assertTrafficIsSanitized(r, true);
    const body = r.reasonBodies[0];
    for (const placeholder of ["[EMAIL_1]", "[PHONE_1]", "[CARD_1]", "[OTP_1]"]) expect(body).toContain(placeholder);
    expect(body).toContain("8845120033"); // order id is not PII and must survive
    expect(stage(r.popup, "execute")[0]).toBe("pass");
    expect(r.pageStatus).toContain("Black Shirt C Purchased");
  });

  it("dynamic DOM: Buy Now C inserted after a delay is observed and clicked", async () => {
    const r = await runScenario("dynamic.html?delay=1500");
    log("dynamic-delay", r);
    expect(stage(r.popup, "execute")[0]).toBe("pass");
    expect(r.pageStatus).toContain("Black Shirt C Purchased");
    assertTrafficIsSanitized(r, true);
  });

  it("stale target: Buy Now C vanishes before execution, validator blocks, agent re-observes, never clicks stale", async () => {
    // Deterministic stale target: Buy Now C is removed the moment the sanitized request leaves,
    // so it was observed (it is in the request) and is gone before the click can be validated.
    const r = await runScenario("dynamic.html?delay=300", TASK, {
      onFirstReason: async (page) => {
        await page.evaluate(() => document.getElementById("buy_c")?.remove());
      },
    });
    log("dynamic-stale", r);
    expect(r.popup.status.some((s) => /re-observing/i.test(s))).toBe(true);
    expect(r.pageStatus).not.toContain("Black Shirt C Purchased");
    expect(r.clicked).not.toBe("buy_c");
    expect(r.reasonBodies.length).toBeGreaterThanOrEqual(2);
    expect(r.reasonBodies.length).toBeLessThanOrEqual(3);
    assertTrafficIsSanitized(r, true);
  });

  it("price swap A cheapest (real Chrome)", async () => {
    await withPrices({ A: 499, B: 899, C: 699 }, async () => {
      const r = await runScenario("index.html");
      log("swap-A", r);
      expect(r.pageStatus).toContain("Black Shirt A Purchased");
      expect(r.clicked).toBe("buy_a");
      assertTrafficIsSanitized(r, true);
    });
  });

  it("price swap B cheapest (real Chrome)", async () => {
    await withPrices({ A: 999, B: 399, C: 699 }, async () => {
      const r = await runScenario("index.html");
      log("swap-B", r);
      expect(r.pageStatus).toContain("Black Shirt B Purchased");
      expect(r.clicked).toBe("buy_b");
      assertTrafficIsSanitized(r, true);
    });
  });

  it("visual-only page: all prices exist only as canvas pixels, A (499) is chosen from local OCR, button labels map to DOM ids", async () => {
    const r = await runScenario("visual-only.html");
    log("visual-only", r);
    expect(stage(r.popup, "vision")[0]).toBe("pass");
    expect(stage(r.popup, "execute")[0]).toBe("pass");
    assertTrafficIsSanitized(r, true);

    const body = JSON.parse(r.reasonBodies[0]) as {
      page: { text: string; elements: Array<{ id: string; text: string }> };
      visual: { observations: Array<{ type: string; text: string; target: string | null; bbox: { width: number; height: number } }> };
    };
    // The DOM carries no price at all: the answer can only come from local vision.
    expect(body.page.text).not.toMatch(/499|899|699/);
    for (const el of body.page.elements) expect(el.text).not.toMatch(/499|899|699/);
    const prices = body.visual.observations.filter((o) => o.type === "price").map((o) => o.text);
    expect(prices.some((t) => /499/.test(t)), `no 499 among ${JSON.stringify(prices)}`).toBe(true);
    expect(prices.some((t) => /899/.test(t))).toBe(true);
    expect(prices.some((t) => /699/.test(t))).toBe(true);
    for (const o of body.visual.observations) {
      expect(o.bbox.width).toBeGreaterThan(0);
      if (o.target) expect(o.target).toMatch(/^el_/);
    }
    // Visual button labels mapped to live DOM ids (fusion), never coordinates. OCR does not read every
    // label on every run, so require at least one product button, and log exactly which were mapped.
    const mapped = body.visual.observations.filter((o) => o.type === "button" && o.target).map((o) => o.target);
    console.log(`  visual button labels mapped to DOM ids: ${mapped.join(", ")}`);
    expect(mapped.some((t) => /^el_buy_[abc]$/.test(t ?? "")), `no product button among ${mapped.join(", ")}`).toBe(true);

    expect(r.pageStatus).toContain("Black Shirt A Purchased");
    expect(r.clicked).toBe("buy_a");
  });

  it("malicious model output injected at the content script is blocked by the validator and nothing is clicked", async () => {
    const page = await context.newPage();
    await page.goto(`${DEMO_BASE}/index.html?_=${Date.now()}`, { waitUntil: "load" });
    const tabId = (await serviceWorker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]?.id)) as number;
    // Prime the content script exactly as a run would (extraction registers the sensitive fields).
    await serviceWorker.evaluate(async (id: number) => chrome.tabs.sendMessage(id, { type: "EXTRACT_PAGE", task: "t", ocr: null }), tabId);

    const attacks: unknown[] = [
      { action: "execute_code", target: "anything", confidence: 1, reason: "" },
      { action: "run_javascript", value: "alert(1)", confidence: 1, reason: "" },
      { action: "click", target: "el_does_not_exist", confidence: 1, reason: "" },
      { action: "click", confidence: 1, reason: "" },
      { action: "click", target: "#buy_c", confidence: 1, reason: "" },
      { action: "click", target: "el_buy_c", confidence: 1, reason: "<script>steal()</script>" },
      { action: "click", target: "el_buy_c", confidence: 1, reason: "", extra: "payload" },
      { action: "navigate", value: "javascript:alert(1)", confidence: 1, reason: "" },
      { action: "type", target: "el_password", value: "hunter2", confidence: 1, reason: "" },
      "click el_buy_c",
      null,
    ];
    const results = (await serviceWorker.evaluate(
      async ({ id, attacks }: { id: number; attacks: unknown[] }) => {
        const out: unknown[] = [];
        for (const action of attacks) out.push(await chrome.tabs.sendMessage(id, { type: "EXECUTE_ACTION", action }));
        return out;
      },
      { id: tabId, attacks },
    )) as Array<{ ok: boolean; validation: string; code?: string; message: string }>;

    for (const [i, result] of results.entries()) {
      expect(result.validation, `attack ${i} ${JSON.stringify(attacks[i])}`).toBe("blocked");
      expect(result.ok).toBe(false);
      for (const value of RAW_VALUES) expect(result.message).not.toContain(value);
      expect(result.message).not.toContain("hunter2");
    }
    console.log(`\n[malicious] ${results.length} injected actions, codes: ${results.map((r) => r.code).join(", ")}`);
    recorded.push({ name: "malicious", attacks: attacks.length, results: results.map((r) => ({ validation: r.validation, code: r.code, message: r.message })) });

    expect(await page.evaluate(() => document.querySelector(".buy-button.clicked")?.id ?? "(none)")).toBe("(none)");
    expect(await page.textContent("#purchase-status")).toBe("");
    expect(await page.evaluate(() => (document.getElementById("password") as HTMLInputElement).value)).toBe("DemoPassword123");
    await page.close();
  });

  it("3x complete E2E on the current page: C every time, metrics recorded", async () => {
    for (const n of [1, 2, 3]) {
      const r = await runScenario("index.html");
      log(`e2e-run-${n}`, r);
      expect(stage(r.popup, "vision")[0]).toBe("pass");
      expect(stage(r.popup, "visual-redaction")[0]).toBe("pass");
      expect(stage(r.popup, "firewall")[0]).toBe("pass");
      expect(stage(r.popup, "validate")[0]).toBe("pass");
      expect(stage(r.popup, "execute")[0]).toBe("pass");
      expect(r.pageStatus).toContain("Black Shirt C Purchased");
      expect(r.clicked).toBe("buy_c");
      assertTrafficIsSanitized(r, true);
    }
  });

  it("original prices restored: C again", async () => {
    expect(readFileSync(DEMO_INDEX, "utf-8")).toContain("Price: ₹799");
    const r = await runScenario("index.html");
    log("restored", r);
    expect(r.pageStatus).toContain("Black Shirt C Purchased");
  });
});
