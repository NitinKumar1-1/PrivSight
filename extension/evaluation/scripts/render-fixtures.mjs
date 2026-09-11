/**
 * Renders the evaluation fixtures reproducibly.
 *
 * For every case in evaluation/cases.json it opens the page in Playwright's
 * Chromium at device scale 2 (matching what the extension captures on a
 * HiDPI screen), saves a full-page PNG to evaluation/fixtures/, and records
 * GROUND-TRUTH BOXES from page geometry: getBoundingClientRect() of every
 * element marked data-gt, plus window.__gtBoxes for canvas-drawn text.
 * These boxes come from the page, never from OCR output.
 *
 *   node evaluation/scripts/render-fixtures.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const EVAL = resolve(here, "..");
const DEMO = resolve(EVAL, "../../demo-site");
const SCALE = 2;

const cases = JSON.parse(readFileSync(resolve(EVAL, "cases.json"), "utf-8")).cases;
mkdirSync(resolve(EVAL, "fixtures"), { recursive: true });
mkdirSync(resolve(EVAL, "ground-truth"), { recursive: true });

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: SCALE });

for (const c of cases) {
  const page = await context.newPage();
  await page.goto(pathToFileURL(resolve(DEMO, c.page)).href, { waitUntil: "load" });
  await page.waitForTimeout(c.settleMs ?? 300);

  const boxes = await page.evaluate(({ scale, gt }) => {
    const out = [];
    // Tight box around the glyphs (not the element's layout box): a text Range for
    // rendered text, a measureText box inside the content box for input values.
    const glyphBox = (el) => {
      if (el instanceof HTMLInputElement) {
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        const c = document.createElement("canvas").getContext("2d"); c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const m = c.measureText(el.value); const ink = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
        const left = r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
        return { left, top: r.top + (r.height - ink) / 2, width: m.width, height: ink };
      }
      // Range rects are line boxes (line-height tall). Shrink vertically to the glyph ink height
      // from the font's metrics so boxes are comparable with OCR ink boxes.
      const range = document.createRange(); range.selectNodeContents(el);
      const r = range.getBoundingClientRect(); const cs = getComputedStyle(el);
      const c = document.createElement("canvas").getContext("2d"); c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = c.measureText((el.textContent ?? "").trim());
      const ink = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      const top = ink > 0 && ink < r.height ? r.top + (r.height - ink) / 2 : r.top;
      return { left: r.left, top, width: r.width, height: ink > 0 && ink < r.height ? ink : r.height };
    };
    const push = (el, kind) => {
      const r = glyphBox(el);
      const text = el instanceof HTMLInputElement ? el.value : (el.textContent ?? "");
      out.push({ kind, text: text.trim(), amount: el.dataset?.amount ? Number(el.dataset.amount) : undefined,
        x: r.left * scale, y: r.top * scale, width: r.width * scale, height: r.height * scale });
    };
    for (const el of document.querySelectorAll("[data-gt]")) push(el, el.dataset.gt);
    for (const { selector, kind } of gt) for (const el of document.querySelectorAll(selector)) push(el, kind);
    for (const b of window.__gtBoxes ?? []) out.push({ ...b, x: b.x * scale, y: b.y * scale, width: b.width * scale, height: b.height * scale });
    return out;
  }, { scale: SCALE, gt: c.gt ?? [] });

  await page.screenshot({ path: resolve(EVAL, "fixtures", `${c.id}.png`), fullPage: true });
  writeFileSync(resolve(EVAL, "ground-truth", `${c.id}.boxes.json`), JSON.stringify({ case: c.id, page: c.page, scale: SCALE, boxes }, null, 2));
  console.log(`${c.id}: ${boxes.length} ground-truth boxes, screenshot written`);
  await page.close();
}
await browser.close();
