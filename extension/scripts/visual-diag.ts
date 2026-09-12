/**
 * Visual-privacy diagnostic: runs the REAL pipeline on a live page and explains
 * every mask region.
 *
 *   screenshot (Playwright, device scale 2)  ->  real OCR engine (tesseract.js, Node)
 *   ->  real content script (dist/content.js injected, chrome stubbed)
 *   ->  EXTRACT_PAGE with that OCR  ->  summary, visualPrivacy.maskRegions, imageRegions, firewall
 *
 * For each mask region it prints the OCR line(s) under it, so the detector that
 * produced it can be identified. Development tool for a developer's own test
 * page; it prints OCR text of that page to the terminal.
 *
 *   npx vite-node scripts/visual-diag.ts <url> "<task>" [--cart]
 *
 * --cart: on a shop search page, click the first "Add to cart" (guest cart) and
 * open the cart page before diagnosing.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTesseractEngine } from "../src/vision/ocr";
import type { OcrResult } from "../src/vision/types";

const [url, task, flag] = process.argv.slice(2);
if (!url || !task) {
  console.error('usage: npx vite-node scripts/visual-diag.ts <url> "<task>" [--cart]');
  process.exit(2);
}
const ROOT = resolve(__dirname, "..");
const CONTENT = `(function () {\n${readFileSync(resolve(ROOT, "dist/content.js"), "utf8")}\n})();`;
const DPR = 2;

const browser = await chromium.launch({ headless: false, channel: process.env.PW_CHANNEL || undefined, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: DPR, locale: "en-IN", bypassCSP: true });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

if (flag === "--cart") {
  try {
    await page.getByRole("button", { name: /add to cart/i }).first().click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    const dialogAdd = page.locator('[role="dialog"] button:has-text("Add to cart"), [role="dialog"] input[type="submit"]').first();
    if (await dialogAdd.count()) await dialogAdd.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const origin = new URL(page.url()).origin;
    await page.goto(`${origin}/gp/cart/view.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
  } catch (error) {
    console.log("[cart setup] could not build a guest cart:", String(error).slice(0, 160));
  }
}
console.log("PAGE:", page.url());

// 1. screenshot of the visible viewport, like chrome.tabs.captureVisibleTab
const shot = resolve(ROOT, "dist-agent-node/visual-diag.png");
const buffer = await page.screenshot({ type: "png" });
writeFileSync(shot, buffer);
const sizeOf = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });
const size = sizeOf(buffer);
console.log(`SCREENSHOT: ${size.width}x${size.height} capture px (DPR ${DPR})`);

// 2. real OCR (single pass; the extension adds a polarity pass, which only adds lines)
const engine = await createTesseractEngine({ langPath: resolve(ROOT, "public/vendor/tessdata"), scale: 1 });
const ocr: OcrResult = await engine.recognize(shot, size);
await engine.terminate();
console.log(`OCR: ${ocr.lines.length} lines in ${Math.round(ocr.timings.recognizeMs)} ms`);

// 3. real content script, real extraction with this OCR
await page.evaluate(() => {
  (window as unknown as { chrome: unknown }).chrome = { runtime: { onMessage: { addListener(fn: unknown) { (window as unknown as { __listener: unknown }).__listener = fn; } } } };
});
await page.addScriptTag({ content: CONTENT });
const extracted = await page.evaluate(
  ([t, o]) => new Promise<unknown>((resolveResult) => (window as unknown as { __listener: (m: unknown, s: null, cb: (r: unknown) => void) => void }).__listener({ type: "EXTRACT_PAGE", task: t, ocr: o, history: [] }, null, resolveResult)),
  [task, ocr] as const,
) as {
  ok: boolean;
  error?: string;
  summary?: { placeholders: string[]; types: Record<string, string>; detections: Array<{ type: string; elementId: string; placeholder: string; signals: string[] }> };
  visualPrivacy?: { ocrLines: number; observationsSent: number; redactedObservations: number; maskRegions: Array<{ bbox: { x: number; y: number; width: number; height: number }; type: string }>; fusion: Record<string, number> };
  imageRegions?: Array<{ x: number; y: number; width: number; height: number }>;
  firewall?: { verdict: string; reason?: string; checks: Array<{ name: string; passed: boolean }> };
};
await browser.close();

if (!extracted.ok) {
  console.log("EXTRACT FAILED:", extracted.error);
  process.exit(1);
}
const { summary, visualPrivacy, imageRegions, firewall } = extracted;
console.log("\nDOM/TEXT PLACEHOLDERS:", summary!.placeholders.map((p) => `${p} (${summary!.types[p]})`).join(", ") || "none");
for (const d of summary!.detections) console.log(`  detection ${d.placeholder} type=${d.type} element=${d.elementId || "(text/ocr)"} signals=${d.signals.join(",")}`);
console.log(`\nVISUAL: ocrLines=${visualPrivacy!.ocrLines} observationsSent=${visualPrivacy!.observationsSent} redactedObservations=${visualPrivacy!.redactedObservations} fusion=${JSON.stringify(visualPrivacy!.fusion)}`);
console.log(`IMAGE REGIONS (pictures on screen; listed for the count, never masked): ${imageRegions!.length}`);
for (const r of imageRegions!) console.log(`  picture css-px box x=${r.x} y=${r.y} w=${r.width} h=${r.height}`);
console.log(`\nMASK REGIONS: ${visualPrivacy!.maskRegions.length}`);
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
visualPrivacy!.maskRegions.forEach((region, i) => {
  const lines = ocr.lines.filter((l) => overlaps(l.bbox, region.bbox));
  console.log(`  #${i + 1} type=${region.type} box x=${region.bbox.x} y=${region.bbox.y} w=${region.bbox.width} h=${region.bbox.height}`);
  for (const l of lines) console.log(`      ocr line (conf ${l.confidence.toFixed(2)}): "${l.text}"  words=[${l.words.map((w) => w.text).join(" | ")}]`);
});
console.log(`\nFIREWALL: ${firewall!.verdict} ${firewall!.reason ?? ""} checks=${firewall!.checks.map((c) => `${c.name}:${c.passed ? "pass" : "FAIL"}`).join(" ")}`);
