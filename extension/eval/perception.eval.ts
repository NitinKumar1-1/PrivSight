/**
 * SIH evaluation harness. Runs the REAL bundled OCR engine (Node, WASM) over
 * real Chrome screenshots of the demo pages and scores the results against
 * eval/ground-truth.json. Every number in eval/results.json is computed here
 * from actual engine output; nothing is hand-entered.
 *
 * Metrics:
 *   visual context   per fixture: text found/missed, prices, buttons; plus
 *                    OCR line precision (lines that match ground truth)
 *   PII              line-level TP/FP/FN over the redactor's decisions
 *   redaction        raw values removed; task-relevant strings preserved
 *   timing           OCR load and recognize time (Node/WASM, this machine)
 *
 * Run: npm run eval   (about 30 s)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findTextMatches } from "../src/privacy/detectors";
import { Redactor } from "../src/privacy/redactor";
import { buildObservations, matchButton, normalize, priceAmount } from "../src/vision/observations";
import { createTesseractEngine, type OcrEngine } from "../src/vision/ocr";
import type { OcrResult } from "../src/vision/types";

interface Fixture {
  file: string;
  page: string;
  expected_text: string[];
  canvas_only_text?: string[];
  expected_prices: number[];
  expected_buttons: string[];
  expected_pii: Array<{ type: string; value: string }>;
  negatives: string[];
  extra_text: string[];
}

const ROOT = resolve(__dirname, "..");
const GROUND_TRUTH = JSON.parse(readFileSync(resolve(__dirname, "ground-truth.json"), "utf-8")) as { fixtures: Fixture[] };
const MIN_CONFIDENCE = 0.55;

let engine: OcrEngine;
const results: Record<string, unknown> = { generatedAt: new Date().toISOString(), engine: "", host: "node (WebAssembly, no upscaling; fixtures rendered at device scale 2)", fixtures: {} };
const totals = { text: { found: 0, expected: 0 }, canvas: { found: 0, expected: 0 }, prices: { strict: 0, recoverable: 0, expected: 0 }, buttons: { found: 0, expected: 0 }, lines: { correct: 0, incorrect: 0 }, pii: { tp: 0, fp: 0, fn: 0 }, redaction: { removed: 0, toRemove: 0, preserved: 0, toPreserve: 0 }, timing: [] as number[] };

beforeAll(async () => {
  engine = await createTesseractEngine({ langPath: resolve(ROOT, "public/vendor/tessdata") });
}, 60_000);

afterAll(async () => {
  await engine.terminate();
  const summary = {
    visual_context: {
      expected_text_recall: ratio(totals.text.found, totals.text.expected),
      canvas_only_text_recall: ratio(totals.canvas.found, totals.canvas.expected),
      price_recall_strict: ratio(totals.prices.strict, totals.prices.expected),
      price_recall_amount_recoverable: ratio(totals.prices.recoverable, totals.prices.expected),
      button_recall: ratio(totals.buttons.found, totals.buttons.expected),
      ocr_line_precision: ratio(totals.lines.correct, totals.lines.correct + totals.lines.incorrect),
    },
    pii: {
      tp: totals.pii.tp, fp: totals.pii.fp, fn: totals.pii.fn,
      precision: ratio(totals.pii.tp, totals.pii.tp + totals.pii.fp),
      recall: ratio(totals.pii.tp, totals.pii.tp + totals.pii.fn),
    },
    redaction: {
      sensitive_removed: ratio(totals.redaction.removed, totals.redaction.toRemove),
      task_relevant_preserved: ratio(totals.redaction.preserved, totals.redaction.toPreserve),
    },
    timing_ms: { ocr_recognize_mean: mean(totals.timing), ocr_recognize_each: totals.timing },
  };
  results.summary = summary;
  writeFileSync(resolve(__dirname, "results.json"), JSON.stringify(results, null, 2));
  console.log("\nSIH EVALUATION SUMMARY\n" + JSON.stringify(summary, null, 2));
});

describe("local OCR perception against real Chrome screenshots", () => {
  for (const fixture of GROUND_TRUTH.fixtures) {
    it(fixture.file, async () => {
      const path = resolve(__dirname, "fixtures", fixture.file);
      const ocr = await engine.recognize(path, { width: 2560, height: 2000 });
      results.engine = ocr.engine;
      const report = score(fixture, ocr);
      (results.fixtures as Record<string, unknown>)[fixture.file] = report;
      console.log(`\n${fixture.file}: ${JSON.stringify(report.counts)}`);
      // The harness must produce something; correctness numbers are reported, not asserted.
      expect(ocr.lines.length).toBeGreaterThan(0);
    }, 120_000);
  }
});

function score(fixture: Fixture, ocr: OcrResult) {
  const lines = ocr.lines.filter((l) => l.confidence >= MIN_CONFIDENCE);
  const lineTexts = lines.map((l) => normalize(l.text));
  const corpus = normalize([...fixture.expected_text, ...(fixture.canvas_only_text ?? []), ...fixture.extra_text].join(" "));

  // --- visual context ------------------------------------------------------
  const found = (expected: string) => lineTexts.some((t) => t.includes(normalize(expected)));
  const textFound = fixture.expected_text.filter(found);
  const textMissed = fixture.expected_text.filter((t) => !found(t));
  const canvasFound = (fixture.canvas_only_text ?? []).filter(found);
  const canvasMissed = (fixture.canvas_only_text ?? []).filter((t) => !found(t));

  const observations = buildObservations(ocr, fixture.expected_buttons.map((b, i) => ({ id: `el_btn_${i}`, text: b })), MIN_CONFIDENCE);
  const priceTexts = observations.filter((o) => o.type === "price").map((o) => o.text);
  const priceAmounts = priceTexts.map(priceAmount).filter((n): n is number => n !== null);
  const pricesStrict = fixture.expected_prices.filter((p) => priceAmounts.includes(p));
  // The rupee glyph is often read as a digit ("₹799" -> "7799"); count amounts whose trailing digits match separately and honestly.
  const pricesRecoverable = fixture.expected_prices.filter((p) => priceAmounts.some((a) => String(a).endsWith(String(p))));

  const buttonsFound = fixture.expected_buttons.filter((b) => lines.some((l) => matchButton(l.text, [{ id: "x", text: b }])));
  const buttonsMissed = fixture.expected_buttons.filter((b) => !buttonsFound.includes(b));

  const incorrectLines = lines.filter((l) => !corpus.includes(normalize(l.text)) && !lineMatchesAnyPart(l.text, corpus)).map((l) => l.text);
  const correctLines = lines.length - incorrectLines.length;

  // --- PII precision / recall (line level) ---------------------------------
  const piiKey = (value: string) => value.replace(/\D/g, "").length >= 6 ? value.replace(/\D/g, "") : value.toLowerCase();
  const expectedKeys = new Map(fixture.expected_pii.map((p) => [piiKey(p.value), p.type]));
  let tp = 0, fp = 0;
  const detectedKeys = new Set<string>();
  const fpLines: string[] = [];
  for (const line of lines) {
    const matches = findTextMatches(line.text);
    if (matches.length === 0) continue;
    const digits = line.text.replace(/\D/g, "");
    const lower = line.text.toLowerCase();
    let lineHasExpected = false;
    for (const [key, type] of expectedKeys) {
      if ((key.length >= 6 && /^\d+$/.test(key) ? digits.includes(key) : lower.includes(key)) && matches.some((m) => m.type === type)) {
        lineHasExpected = true;
        detectedKeys.add(key);
      }
    }
    if (lineHasExpected) tp++;
    else {
      fp++;
      fpLines.push(`${line.text} -> ${matches.map((m) => m.type).join(",")}`);
    }
  }
  const fnValues = [...expectedKeys.keys()].filter((k) => !detectedKeys.has(k));
  const fn = fnValues.length;

  // --- redaction precision ---------------------------------------------------
  const redactor = new Redactor();
  const sanitized = lines.map((l) => redactor.redactText(l.text));
  const sanitizedJoined = sanitized.join("\n");
  const sanitizedDigits = sanitizedJoined.replace(/\D/g, "");
  const removed = fixture.expected_pii.filter((p) => {
    const key = piiKey(p.value);
    return key.length >= 6 && /^\d+$/.test(key) ? !sanitizedDigits.includes(key) : !sanitizedJoined.toLowerCase().includes(key);
  });
  const toRemove = fixture.expected_pii.filter((p) => detectedKeys.has(piiKey(p.value)) || lines.some((l) => l.text.toLowerCase().includes(p.value.toLowerCase())));
  const relevant = [...fixture.expected_text.filter(found), ...buttonsFound, ...priceTexts];
  // Space-insensitive: OCR sometimes drops a space ("Buy NowA"); the text is still there, unredacted.
  const compact = (t: string) => normalize(t).replace(/ /g, "");
  const preserved = relevant.filter((r) => compact(sanitizedJoined).includes(compact(r)));

  totals.text.found += textFound.length; totals.text.expected += fixture.expected_text.length;
  totals.canvas.found += canvasFound.length; totals.canvas.expected += (fixture.canvas_only_text ?? []).length;
  totals.prices.strict += pricesStrict.length; totals.prices.recoverable += pricesRecoverable.length; totals.prices.expected += fixture.expected_prices.length;
  totals.buttons.found += buttonsFound.length; totals.buttons.expected += fixture.expected_buttons.length;
  totals.lines.correct += correctLines; totals.lines.incorrect += incorrectLines.length;
  totals.pii.tp += tp; totals.pii.fp += fp; totals.pii.fn += fn;
  totals.redaction.removed += removed.length; totals.redaction.toRemove += toRemove.length;
  totals.redaction.preserved += preserved.length; totals.redaction.toPreserve += relevant.length;
  totals.timing.push(Math.round(ocr.timings.recognizeMs));

  return {
    counts: {
      ocr_lines: ocr.lines.length, lines_above_threshold: lines.length,
      text_found: textFound.length, text_expected: fixture.expected_text.length,
      canvas_text_found: canvasFound.length, canvas_text_expected: (fixture.canvas_only_text ?? []).length,
      prices_strict: pricesStrict.length, prices_recoverable: pricesRecoverable.length, prices_expected: fixture.expected_prices.length,
      buttons_found: buttonsFound.length, buttons_expected: fixture.expected_buttons.length,
      lines_correct: correctLines, lines_incorrect: incorrectLines.length,
      pii_tp: tp, pii_fp: fp, pii_fn: fn,
      redaction_removed: removed.length, redaction_to_remove: toRemove.length,
      preserved: preserved.length, to_preserve: relevant.length,
      ocr_recognize_ms: Math.round(ocr.timings.recognizeMs), ocr_load_ms: Math.round(ocr.timings.loadMs),
    },
    detail: { textMissed, canvasMissed, priceTexts, buttonsMissed, incorrectLines, fpLines, fnValues, notPreserved: relevant.filter((r) => !preserved.includes(r)) },
  };
}

/** A line is "correct" if every word of 3+ letters it contains appears somewhere in the ground-truth corpus. */
function lineMatchesAnyPart(text: string, corpus: string): boolean {
  const words = normalize(text).split(" ").filter((w) => w.length >= 3);
  return words.length > 0 && words.every((w) => corpus.includes(w));
}

function ratio(a: number, b: number): { value: number | null; of: string } {
  return { value: b === 0 ? null : Math.round((a / b) * 1000) / 1000, of: `${a}/${b}` };
}

function mean(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}
