/**
 * Evaluator demo D7: backend unavailable. Run this file with the FastAPI
 * backend STOPPED. It loads the built extension into Chromium, runs a normal
 * task through the real popup, and checks that the popup shows the friendly
 * "AI service unavailable" state with no technical detail and no browser
 * action. Skips itself when the backend is reachable.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const DIST = resolve(ROOT, "dist");
const DEMO_DIR = resolve(ROOT, "../demo-site");
const DEMO_BASE = "http://localhost:8080";
const BACKEND = "http://localhost:8000";
const TECHNICAL = /ECONNREFUSED|HTTPConnectionPool|Traceback|Exception|JSON|stack|localhost:8000|TypeError|fetch/i;

let context: BrowserContext | null = null;
let serviceWorker: Worker;
let extensionId = "";
let staticServer: ChildProcess | null = null;
let backendUp = true;

beforeAll(async () => {
  backendUp = await fetch(`${BACKEND}/health`).then((r) => r.ok).catch(() => false);
  if (backendUp) return;
  if (!existsSync(resolve(DIST, "manifest.json"))) throw new Error("extension is not built; run npm run build");
  if (!(await fetch(`${DEMO_BASE}/shop.html`).then((r) => r.ok).catch(() => false))) {
    staticServer = spawn("python", ["-m", "http.server", "8080"], { cwd: DEMO_DIR, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 2000));
  }
  const testDist = mkdtempSync(resolve(tmpdir(), "privsight-p8d-"));
  cpSync(DIST, testDist, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(testDist, "manifest.json"), "utf-8")) as { host_permissions: string[] };
  manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
  writeFileSync(resolve(testDist, "manifest.json"), JSON.stringify(manifest, null, 2));
  context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), "privsight-p8d-profile-")), {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${testDist}`, `--load-extension=${testDist}`],
  });
  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  extensionId = new URL(serviceWorker.url()).host;
}, 120_000);

afterAll(async () => {
  await context?.close();
  staticServer?.kill();
});

describe("D7 backend failure", () => {
  it("shows a friendly 'AI service unavailable' state, no technical detail, no browser action", async () => {
    if (backendUp) {
      console.log("[D7] backend is reachable: stop it and rerun this file to exercise the scenario");
      return;
    }
    const ctx = context as BrowserContext;
    const url = `${DEMO_BASE}/shop.html?_=${Date.now()}`;
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load" });
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await page.bringToFront();
    const tabId = (await serviceWorker.evaluate(async (u: string) => (await chrome.tabs.query({ url: u }))[0]?.id, url)) as number;
    await serviceWorker.evaluate(async (id: number) => { await chrome.tabs.update(id, { active: true }); }, tabId);
    await popup.fill("#task", "Search for a black shirt and add the cheapest one to the cart.");
    await popup.click("#run");
    let state = { stateWord: "", stateHint: "", stateFacts: "", status: [] as string[], runDisabled: true };
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      state = await popup.evaluate(() => ({
        stateWord: document.getElementById("state-word")?.textContent ?? "",
        stateHint: document.getElementById("state-hint")?.textContent ?? "",
        stateFacts: document.getElementById("state-facts")?.textContent ?? "",
        status: Array.from(document.querySelectorAll("#status li")).map((li) => li.textContent ?? ""),
        runDisabled: (document.getElementById("run") as HTMLButtonElement).disabled,
      }));
      if (["Complete", "Unverified", "Blocked", "Failed"].includes(state.stateWord) && !state.runDisabled) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const flow = await page.evaluate(() => document.getElementById("flow-log")?.textContent ?? "");
    console.log(`\n[D7-backend-down] state=${state.stateWord} | ${state.stateHint} | ${state.stateFacts}`);
    expect(state.stateWord).toBe("Failed");
    expect(state.stateFacts).toMatch(/AI service unavailable/);
    expect(state.stateHint).toMatch(/Please try again\. No browser action was performed\./);
    expect(state.stateHint + state.stateFacts).not.toMatch(TECHNICAL);
    expect(state.stateFacts).toMatch(/Browser action: None/);
    expect(flow).toBe("");
    await popup.close();
    await page.close();
  }, 180_000);
});
