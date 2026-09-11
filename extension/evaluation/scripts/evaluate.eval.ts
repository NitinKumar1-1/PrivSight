// @vitest-environment jsdom
/**
 * PrivSight SIH evaluation harness (Phase 5).
 *
 * For every case in evaluation/cases.json:
 *   1. runs the REAL bundled OCR engine on the rendered fixture (visual channel)
 *   2. loads the page HTML into jsdom and runs the REAL DOM privacy pipeline
 *      without vision (DOM channel) and with the OCR result (combined channel)
 *   3. scores everything against hand-written ground truth and page-geometry
 *      boxes that were recorded independently of OCR
 *
 * Metric definitions are fixed here, before any result is seen:
 *   OCR line precision   correct lines / lines above the confidence threshold; a line is
 *                        correct when every word of 3+ letters occurs in the ground-truth corpus
 *   OCR text recall      ground-truth text items found in the OCR output / expected items
 *   task-relevant recall names + prices + button labels found / expected (space-insensitive)
 *   price exact          a price line whose parsed amount equals the expected amount
 *   price recoverable    a price line whose parsed amount ends with the expected digits
 *   button recall        expected labels matched by the observation matcher / expected
 *   box match            IoU >= 0.5 between a ground-truth box and any OCR line box (primary),
 *                        or the ground-truth box covered >= 0.9 by one OCR line box (secondary)
 *   mask coverage        a PII box counts as masked when mask regions cover >= 0.9 of it
 *   PII precision/recall TP / (TP+FP), TP / (TP+FN) per channel; a value matches by digits
 *                        (numeric) or case-insensitively (other); a detection whose value is
 *                        not an expected PII value is a false positive
 *
 * Output: evaluation/results/latest.json and per-area files. No raw values,
 * no OCR dumps, no images are written: misses are reported by type and layout.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareRequest } from "../../src/content/perception";
import { detectVisualPii } from "../../src/privacy/visual-pii";
import { polarizeRgba } from "../../src/vision/preprocess";
import { PNG } from "pngjs";
import { createTesseractEngine, type OcrEngine } from "../../src/vision/ocr";
import { buildObservations, isPrice, matchButton, normalize, priceAmount } from "../../src/vision/observations";
import type { OcrResult } from "../../src/vision/types";
import type { ReasonRequest } from "../../src/shared/contract";

const EVAL = resolve(__dirname, "..");
const DEMO = resolve(EVAL, "../../demo-site");
const RESULTS = resolve(EVAL, "results");
const MIN_CONFIDENCE = 0.55;
const IOU_THRESHOLD = 0.5;
const COVERAGE_THRESHOLD = 0.9;
const TASK = "Find the cheapest black shirt and click Buy Now";
/** Mirrors the extension's offscreen document: a second OCR pass on a polarity-normalised copy. */
const DUAL_PASS = process.env.PRIVSIGHT_SINGLE_PASS !== "1";

interface Box { x: number; y: number; width: number; height: number }
interface GtBox extends Box { kind: string; text: string; amount?: number }
interface GtPrice { amount: number; text: string; format?: string; size?: number; bg?: string; canvas?: boolean }
interface GtPii { type: string; value: string; where?: string; layout?: string; visible?: boolean }
interface GroundTruth {
  case: string; task?: string; expected_target?: string;
  expected_text: string[]; canvas_only_text?: string[]; expected_prices: GtPrice[]; expected_buttons: string[];
  button_styles?: Record<string, string>; expected_pii: GtPii[]; non_pii: string[]; extra_text: string[];
}
interface Case { id: string; page: string; role: string }

const cases = (JSON.parse(readFileSync(resolve(EVAL, "cases.json"), "utf-8")) as { cases: Case[] }).cases;
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  engine: "",
  host: "vitest jsdom + Node worker (WebAssembly); fixtures rendered by Playwright Chromium at device scale 2, OCR at scale 1",
  ocrPasses: process.env.PRIVSIGHT_SINGLE_PASS === "1" ? 1 : 2,
  thresholds: { minConfidence: MIN_CONFIDENCE, iou: IOU_THRESHOLD, maskCoverage: COVERAGE_THRESHOLD },
  cases: {} as Record<string, unknown>,
};
const totals = {
  lines: { correct: 0, total: 0 },
  text: { found: 0, expected: 0 },
  taskRelevant: { found: 0, expected: 0, recoverable: 0 },
  prices: { exact: 0, recoverable: 0, expected: 0, byFormat: {} as Record<string, { exact: number; recoverable: number; expected: number }> },
  buttons: { found: 0, expected: 0, byStyle: {} as Record<string, { found: number; expected: number }> },
  boxes: { expected: 0, iou: 0, covered: 0, false: 0 },
  pii: {
    visual: { tp: 0, fp: 0, fn: 0 },
    dom: { tp: 0, fp: 0, fn: 0, blocked: 0, overBlocked: 0 },
    combined: { tp: 0, fp: 0, fn: 0, blocked: 0, overBlocked: 0 },
  },
  redaction: { removed: 0, missed: 0, nonSensitiveRemoved: 0, preserved: 0, toPreserve: 0, piiBoxes: 0, piiBoxesMasked: 0 },
  timing: { engineLoadMs: 0, recognizeMs: [] as number[], secondPassMs: [] as number[], domPipelineMs: [] as number[], combinedPipelineMs: [] as number[] },
};
let engine: OcrEngine;

beforeAll(async () => {
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.scrollIntoView = () => undefined;
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
  const t = performance.now();
  engine = await createTesseractEngine({ langPath: resolve(EVAL, "../public/vendor/tessdata"), scale: 1 });
  totals.timing.engineLoadMs = Math.round(performance.now() - t);
}, 120_000);

afterAll(async () => {
  await engine?.terminate();
  results.summary = summarize();
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, "latest.json"), JSON.stringify(results, null, 2));
  const s = results.summary as Record<string, unknown>;
  for (const area of ["visual", "pii", "redaction", "boxes", "timing"]) {
    writeFileSync(resolve(RESULTS, `${area}-results.json`), JSON.stringify({ generatedAt: results.generatedAt, [area]: s[area] }, null, 2));
  }
  console.log("\nSIH EVALUATION SUMMARY\n" + JSON.stringify(results.summary, null, 2));
});

describe("PrivSight SIH evaluation", () => {
  for (const c of cases) {
    it(c.id, async () => {
      const gt = JSON.parse(readFileSync(resolve(EVAL, "ground-truth", `${c.id}.json`), "utf-8")) as GroundTruth;
      const gtBoxes = (JSON.parse(readFileSync(resolve(EVAL, "ground-truth", `${c.id}.boxes.json`), "utf-8")) as { boxes: GtBox[] }).boxes;

      const fixture = resolve(EVAL, "fixtures", `${c.id}.png`);
      const ocr = await engine.recognize(fixture, { width: 0, height: 0 }, DUAL_PASS ? { secondPass: polarizedPng(fixture) } : {});
      results.engine = ocr.engine;
      totals.timing.recognizeMs.push(Math.round(ocr.timings.recognizeMs));
      if (ocr.timings.secondPassMs !== undefined) totals.timing.secondPassMs.push(Math.round(ocr.timings.secondPassMs));

      const report = scoreCase(c, gt, gtBoxes, ocr);
      (results.cases as Record<string, unknown>)[c.id] = report;
      console.log(`${c.id}: ${JSON.stringify(report.counts)}`);
      expect(ocr.lines.length).toBeGreaterThan(0);
    }, 120_000);
  }
});

// ---------------------------------------------------------------------------

/** Non-PII ground-truth text is written as-is unless it is a long digit run, which is written by shape only. */
function safeText(t: string): string {
  if (/^\d{6,}$/.test(t)) return `<nonpii:${t.length}-digit>`;
  return t.length > 24 ? t.slice(0, 24) + "…" : t;
}

function scoreCase(c: Case, gt: GroundTruth, gtBoxes: GtBox[], ocr: OcrResult) {
  const lines = ocr.lines.filter((l) => l.confidence >= MIN_CONFIDENCE);
  const corpus = normalize([
    ...gt.expected_text, ...(gt.canvas_only_text ?? []), ...gt.expected_prices.map((p) => p.text), ...gt.expected_buttons,
    ...gt.expected_pii.map((p) => p.value), ...gt.non_pii, ...gt.extra_text,
  ].join(" "));
  const ocrJoined = normalize(lines.map((l) => l.text).join(" "));
  const compact = (t: string) => normalize(t).replace(/ /g, "");
  const found = (t: string) => compact(ocrJoined).includes(compact(t));

  // --- visual -------------------------------------------------------------
  const correctLines = lines.filter((l) => lineMatches(l.text, corpus));
  const textItems = [...gt.expected_text, ...(gt.canvas_only_text ?? [])];
  const textFound = textItems.filter(found);
  const taskItems = [...gt.expected_text.filter((t) => /shirt/i.test(t)), ...(gt.canvas_only_text ?? []).filter((t) => /shirt|price/i.test(t)), ...gt.expected_prices.map((p) => p.text), ...gt.expected_buttons];
  const taskFound = taskItems.filter(found);

  const observations = buildObservations(ocr, gt.expected_buttons.map((b, i) => ({ id: `el_gt_${i}`, text: b })), MIN_CONFIDENCE);
  const priceLines = lines.filter((l) => isPrice(l.text));
  const amounts = priceLines.map((l) => priceAmount(l.text)).filter((a): a is number => a !== null);
  const priceRows = gt.expected_prices.map((p) => {
    const exact = amounts.includes(p.amount);
    const recoverable = exact || amounts.some((a) => String(a).endsWith(String(p.amount)) && String(a).length <= String(p.amount).length + 1);
    return { text: p.text, format: p.format ?? (/rs|inr/i.test(p.text) ? "Rs/INR" : "rupee-sign"), size: p.size, bg: p.bg, canvas: p.canvas ?? false, exact, recoverable };
  });
  for (const row of priceRows) {
    const f = (totals.prices.byFormat[row.format] ??= { exact: 0, recoverable: 0, expected: 0 });
    f.expected++; if (row.exact) f.exact++; if (row.recoverable) f.recoverable++;
  }

  // Recoverable variant: a price counts when its amount is recoverable even if the currency glyph was misread.
  const taskRecoverable = taskItems.filter((t) => found(t) || priceRows.some((r) => r.text === t && r.recoverable));

  const buttonRows = gt.expected_buttons.map((label) => {
    const hit = lines.some((l) => matchButton(l.text, [{ id: "x", text: label }]) !== null);
    const style = gt.button_styles?.[label] ?? "demo";
    const s = (totals.buttons.byStyle[style] ??= { found: 0, expected: 0 });
    s.expected++; if (hit) s.found++;
    return { label, style, found: hit };
  });

  // --- boxes --------------------------------------------------------------
  const lineBoxes = lines.map((l) => l.bbox);
  const boxRows = gtBoxes.map((g) => {
    const best = Math.max(0, ...lineBoxes.map((b) => iou(g, b)));
    const cover = Math.max(0, ...lineBoxes.map((b) => coverage(g, b)));
    // Never write a PII value into an artifact, even a fake one: label such boxes by type only.
    const label = g.kind.startsWith("pii:") ? `<${g.kind}>` : safeText(g.text);
    return { kind: g.kind, text: label, iou: round(best), coverage: round(cover), matched: best >= IOU_THRESHOLD, covered: cover >= COVERAGE_THRESHOLD };
  });
  const falseBoxes = lines.filter((l) => !lineMatches(l.text, corpus)).length;

  // --- PII: visual channel (OCR lines through the text detectors only) -----
  const visiblePii = gt.expected_pii.filter((p) => p.visible !== false);
  const visualDetections = detectVisualPii(lines);
  const visualTp = visiblePii.filter((p) => visualDetections.some((d) => sameValue(d.value, p.value)));
  const visualFn = visiblePii.filter((p) => !visualTp.includes(p));
  const visualFp = visualDetections.filter((d) => !visiblePii.some((p) => sameValue(d.value, p.value)));

  // --- PII: DOM channel and combined channel (real content-script pipeline) -
  loadPage(c.page);
  const domStart = performance.now();
  const dom = prepareRequest(gt.task ?? TASK, null);
  const domMs = performance.now() - domStart;
  const combinedStart = performance.now();
  const combined = prepareRequest(gt.task ?? TASK, ocr);
  const combinedMs = performance.now() - combinedStart;
  totals.timing.domPipelineMs.push(round(domMs)); totals.timing.combinedPipelineMs.push(round(combinedMs));

  const domInput = [document.body.textContent ?? "", ...Array.from(document.querySelectorAll("input")).map((i) => i.value)].join(" # ");
  const domPii = gt.expected_pii.filter((p) => containsValue(domInput, p.value)); // present in the DOM (text or field)
  const domScore = scoreChannel(dom.firewall.verdict === "allowed" ? dom.firewall.body : null, dom.summary.placeholders.length, domPii, gt.non_pii, dom.firewall.verdict === "blocked" ? dom.firewall.reason : null, domInput);
  const ocrInput = lines.map((l) => l.text).join(" # ");
  const allPii = gt.expected_pii.filter((p) => containsValue(domInput, p.value) || visualDetections.some((d) => sameValue(d.value, p.value)) || containsValue(ocrInput, p.value));
  const combinedBody = combined.firewall.verdict === "allowed" ? combined.firewall.body : null;
  const combinedScore = scoreChannel(combinedBody, combined.summary.placeholders.length, allPii, gt.non_pii, combined.firewall.verdict === "blocked" ? combined.firewall.reason : null, domInput + " # " + ocrInput);

  // --- redaction (combined) and mask coverage ---------------------------------
  const maskRegions = combined.visualPrivacy?.maskRegions.map((r) => r.bbox) ?? [];
  const piiBoxes = gtBoxes.filter((g) => g.kind.startsWith("pii:"));
  const maskRows = piiBoxes.map((g) => {
    const cover = Math.max(0, ...maskRegions.map((m) => coverage(g, m)));
    const best = Math.max(0, ...maskRegions.map((m) => iou(g, m)));
    return { kind: g.kind, coverage: round(cover), iou: round(best), masked: cover >= COVERAGE_THRESHOLD };
  });
  const preservedItems = [...gt.expected_text.filter(found), ...gt.expected_buttons.filter((b) => buttonRows.find((r) => r.label === b)?.found), ...priceRows.filter((r) => r.recoverable).map((r) => r.text)];
  const bodyText = combinedBody ? combinedBodyText(combinedBody) : "";
  const preserved = combinedBody ? preservedItems.filter((t) => compact(bodyText).includes(compact(t)) || compact(ocrJoined).includes(compact(t))) : [];

  // --- totals ---------------------------------------------------------------
  totals.lines.correct += correctLines.length; totals.lines.total += lines.length;
  totals.text.found += textFound.length; totals.text.expected += textItems.length;
  totals.taskRelevant.found += taskFound.length; totals.taskRelevant.expected += taskItems.length; totals.taskRelevant.recoverable += taskRecoverable.length;
  totals.prices.exact += priceRows.filter((r) => r.exact).length; totals.prices.recoverable += priceRows.filter((r) => r.recoverable).length; totals.prices.expected += priceRows.length;
  totals.buttons.found += buttonRows.filter((r) => r.found).length; totals.buttons.expected += buttonRows.length;
  totals.boxes.expected += boxRows.length; totals.boxes.iou += boxRows.filter((r) => r.matched).length; totals.boxes.covered += boxRows.filter((r) => r.matched || r.covered).length; totals.boxes.false += falseBoxes;
  totals.pii.visual.tp += visualTp.length; totals.pii.visual.fp += visualFp.length; totals.pii.visual.fn += visualFn.length;
  totals.pii.dom.tp += domScore.tp; totals.pii.dom.fp += domScore.fp; totals.pii.dom.fn += domScore.fn;
  totals.pii.combined.tp += combinedScore.tp; totals.pii.combined.fp += combinedScore.fp; totals.pii.combined.fn += combinedScore.fn; if (combinedScore.blocked) { totals.pii.combined.blocked++; totals.pii.combined.overBlocked += combinedScore.overBlocked; }
  if (domScore.blocked) { totals.pii.dom.blocked++; totals.pii.dom.overBlocked += domScore.overBlocked; }
  totals.redaction.removed += combinedScore.tp; totals.redaction.missed += combinedScore.fn; totals.redaction.nonSensitiveRemoved += combinedScore.fp;
  totals.redaction.preserved += preserved.length; totals.redaction.toPreserve += combinedBody ? preservedItems.length : 0;
  totals.redaction.piiBoxes += maskRows.length; totals.redaction.piiBoxesMasked += maskRows.filter((r) => r.masked).length;

  return {
    role: c.role,
    counts: {
      ocr_lines: ocr.lines.length, lines_scored: lines.length, lines_correct: correctLines.length,
      text_found: textFound.length, text_expected: textItems.length,
      task_relevant_found: taskFound.length, task_relevant_recoverable: taskRecoverable.length, task_relevant_expected: taskItems.length,
      price_exact: priceRows.filter((r) => r.exact).length, price_recoverable: priceRows.filter((r) => r.recoverable).length, price_expected: priceRows.length,
      buttons_found: buttonRows.filter((r) => r.found).length, buttons_expected: buttonRows.length,
      boxes_expected: boxRows.length, boxes_iou_matched: boxRows.filter((r) => r.matched).length, boxes_covered: boxRows.filter((r) => r.matched || r.covered).length, false_lines: falseBoxes,
      pii_visual: { tp: visualTp.length, fp: visualFp.length, fn: visualFn.length },
      pii_dom: { tp: domScore.tp, fp: domScore.fp, fn: domScore.fn, blocked: domScore.blocked, withheld: domScore.overBlocked },
      pii_combined: { tp: combinedScore.tp, fp: combinedScore.fp, fn: combinedScore.fn, blocked: combinedScore.blocked, withheld: combinedScore.overBlocked },
      mask_boxes: maskRows.length, mask_boxes_covered: maskRows.filter((r) => r.masked).length,
      preserved: preserved.length, to_preserve: combinedBody ? preservedItems.length : 0,
      ocr_recognize_ms: Math.round(ocr.timings.recognizeMs), dom_pipeline_ms: round(domMs), combined_pipeline_ms: round(combinedMs),
      observations_sent: combined.visualPrivacy?.observationsSent ?? 0, conflicts: combined.visualPrivacy?.conflicts.length ?? 0,
    },
    detail: {
      text_missed: textItems.filter((t) => !found(t)),
      task_relevant_missed: taskItems.filter((t) => !found(t)),
      prices: priceRows,
      buttons: buttonRows,
      boxes: boxRows,
      pii_visual_missed: visualFn.map((p) => `${p.type} (${p.layout ?? p.where ?? "text"})`),
      pii_visual_false_positive_types: visualFp.map((d) => d.type),
      pii_dom_missed: domScore.missedLabels, pii_dom_false: domScore.falseItems.map(safeText),
      pii_combined_missed: combinedScore.missedLabels, pii_combined_false: combinedScore.falseItems.map(safeText),
      combined_verdict: combined.firewall.verdict, combined_block_reason: combined.firewall.verdict === "blocked" ? combined.firewall.reason : undefined,
      masks: maskRows,
      not_preserved: combinedBody ? preservedItems.filter((t) => !preserved.includes(t)) : [],
    },
  };
}

/** Scores a channel from the sanitized body: a PII value counts as detected when it is absent from the body. */
function scoreChannel(body: string | null, placeholderCount: number, expected: GtPii[], nonPii: string[], blockReason: string | null, inputText: string) {
  // Only non-PII items that were actually present in this channel's input can be lost by it.
  const seenNonPii = nonPii.filter((n) => containsValue(inputText, n));
  if (!body) {
    // Fail-closed block: nothing was sent, so nothing leaked; every visible non-PII item was withheld.
    return { tp: expected.length, fp: 0, fn: 0, blocked: blockReason ?? "blocked", overBlocked: seenNonPii.length, missedLabels: [] as string[], falseItems: [] as string[] };
  }
  const text = combinedBodyText(body);
  const tpItems = expected.filter((p) => !containsValue(text, p.value));
  const fnItems = expected.filter((p) => containsValue(text, p.value));
  const falseItems = seenNonPii.filter((n) => !containsValue(text, n) && !/^\d{1,2}$/.test(n)); // non-PII that vanished
  // Placeholders beyond the true positives also count as false detections (something else was redacted).
  const extra = Math.max(0, placeholderCount - tpItems.length - falseItems.length);
  return { tp: tpItems.length, fp: falseItems.length + extra, fn: fnItems.length, blocked: null as string | null, overBlocked: 0, missedLabels: fnItems.map((p) => `${p.type} (${p.layout ?? p.where ?? "text"})`), falseItems };
}

/** Text a reasoner would see: task, page text, element texts, visual observation texts. */
function combinedBodyText(body: string): string {
  const parsed = JSON.parse(body) as ReasonRequest;
  return [parsed.task, parsed.page.text, ...parsed.page.elements.map((e) => e.text), ...(parsed.visual?.observations.map((o) => o.text) ?? [])].join(" # ");
}

function containsValue(text: string, value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (/^[\d\s+()-]+$/.test(value) && digits.length >= 4) {
    return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(text.replace(/[\s+()-]/g, ""));
  }
  return text.toLowerCase().includes(value.toLowerCase());
}

function sameValue(a: string, b: string): boolean {
  const da = a.replace(/\D/g, ""), db = b.replace(/\D/g, "");
  if (da.length >= 4 && db.length >= 4 && /^[\d\s+()-]+$/.test(b)) return da === db;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Loads a demo page into jsdom and runs its inline script (canvas drawing fails harmlessly without a 2D context). */
function loadPage(page: string): void {
  const html = readFileSync(resolve(DEMO, page), "utf-8");
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
  document.title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/g, "");
  const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (script) {
    try { new Function(script)(); } catch { /* no canvas 2D in jsdom; DOM structure is what matters */ }
  }
}

/** Polarity-normalised copy of a PNG as an encoded buffer the OCR worker accepts. */
function polarizedPng(path: string): Buffer {
  const png = PNG.sync.read(readFileSync(path));
  polarizeRgba(png.data);
  return PNG.sync.write(png);
}

function lineMatches(text: string, corpus: string): boolean {
  const words = normalize(text).split(" ").filter((w) => w.length >= 3 && /[a-z]/.test(w));
  return words.length === 0 || words.every((w) => corpus.includes(w));
}

function iou(a: Box, b: Box): number {
  const inter = intersection(a, b);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}
function coverage(gt: Box, b: Box): number {
  const area = gt.width * gt.height;
  return area > 0 ? intersection(gt, b) / area : 0;
}
function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
function round(v: number): number { return Math.round(v * 1000) / 1000; }
function ratio(a: number, b: number) { return { value: b === 0 ? null : round(a / b), of: `${a}/${b}` }; }
function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return { n: values.length, min: sorted[0], mean: round(values.reduce((s, v) => s + v, 0) / values.length), median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
}

function summarize() {
  const pr = (c: { tp: number; fp: number; fn: number }) => ({ tp: c.tp, fp: c.fp, fn: c.fn, precision: ratio(c.tp, c.tp + c.fp), recall: ratio(c.tp, c.tp + c.fn) });
  return {
    visual: {
      ocr_line_precision: ratio(totals.lines.correct, totals.lines.total),
      ocr_text_recall: ratio(totals.text.found, totals.text.expected),
      task_relevant_recall_strict: ratio(totals.taskRelevant.found, totals.taskRelevant.expected),
      task_relevant_recall_recoverable: ratio(totals.taskRelevant.recoverable, totals.taskRelevant.expected),
      price_exact: ratio(totals.prices.exact, totals.prices.expected),
      price_recoverable: ratio(totals.prices.recoverable, totals.prices.expected),
      price_by_format: Object.fromEntries(Object.entries(totals.prices.byFormat).map(([k, v]) => [k, { exact: `${v.exact}/${v.expected}`, recoverable: `${v.recoverable}/${v.expected}` }])),
      button_recall: ratio(totals.buttons.found, totals.buttons.expected),
      button_by_style: Object.fromEntries(Object.entries(totals.buttons.byStyle).map(([k, v]) => [k, `${v.found}/${v.expected}`])),
    },
    boxes: {
      metric: `IoU >= ${IOU_THRESHOLD} between ground-truth box and any OCR line box (primary); ground-truth box covered >= ${COVERAGE_THRESHOLD} by one line box (secondary)`,
      expected: totals.boxes.expected, matched_iou: totals.boxes.iou, matched_iou_or_covered: totals.boxes.covered, missed: totals.boxes.expected - totals.boxes.covered,
      false_lines: totals.boxes.false, recall_iou: ratio(totals.boxes.iou, totals.boxes.expected), recall_covered: ratio(totals.boxes.covered, totals.boxes.expected),
    },
    pii: {
      visual_channel: pr(totals.pii.visual),
      dom_channel: { ...pr(totals.pii.dom), cases_blocked_by_firewall: totals.pii.dom.blocked, non_pii_withheld_by_block: totals.pii.dom.overBlocked },
      combined: { ...pr(totals.pii.combined), cases_blocked_by_firewall: totals.pii.combined.blocked, non_pii_withheld_by_block: totals.pii.combined.overBlocked },
      note: "A firewall block sends nothing: it counts as protected (TP) and the withheld non-PII is reported separately as over-blocking, not as a false positive.",
    },
    redaction: {
      sensitive_removed: ratio(totals.redaction.removed, totals.redaction.removed + totals.redaction.missed),
      non_sensitive_removed: totals.redaction.nonSensitiveRemoved,
      precision: ratio(totals.redaction.removed, totals.redaction.removed + totals.redaction.nonSensitiveRemoved),
      task_relevant_preserved: ratio(totals.redaction.preserved, totals.redaction.toPreserve),
      pii_boxes_masked: ratio(totals.redaction.piiBoxesMasked, totals.redaction.piiBoxes),
    },
    timing: {
      engine_load_ms_cold: totals.timing.engineLoadMs,
      ocr_recognize_ms: stats(totals.timing.recognizeMs),
      ocr_second_pass_ms: stats(totals.timing.secondPassMs),
      dom_pipeline_ms: stats(totals.timing.domPipelineMs),
      combined_pipeline_ms: stats(totals.timing.combinedPipelineMs),
    },
  };
}
