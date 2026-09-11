/**
 * Builds the presentation-ready SIH summary from the evaluation artifacts.
 * Every number is read from the result files; nothing is typed in by hand.
 *
 *   node evaluation/scripts/summarize.mjs
 *
 * Reads:  evaluation/results/{latest,phase5-before-improvements,latency,network-results}.json
 *         evaluation/results/baseline-phase4/baseline-metrics.json
 * Writes: evaluation/results/metrics.json, evaluation/reports/sih-summary.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(here, "../results");
const REPORTS = resolve(here, "../reports");
const read = (name) => (existsSync(resolve(RESULTS, name)) ? JSON.parse(readFileSync(resolve(RESULTS, name), "utf-8")) : null);

const after = read("latest.json");
const before = read("phase5-before-improvements.json");
const latencyBefore = read("latency-before-improvements.json");
const latency = read("latency.json");
const network = read("network-results.json");
const phase4 = read("baseline-phase4/baseline-metrics.json");

const of = (m) => (m && m.of !== undefined ? m.of : m);
const pct = (m) => (m && m.value !== null && m.value !== undefined ? `${(m.value * 100).toFixed(1)}%` : "n/a");
const ms = (d, key = "median") => (d && d[key] !== undefined && d[key] !== null ? `${Math.round(d[key])} ms` : "n/a");

const A = after.summary, B = before?.summary;
const metrics = {
  generatedAt: new Date().toISOString(),
  sources: { evaluation: after.generatedAt, evaluation_before: before?.generatedAt ?? null, latency: latency?.generatedAt ?? null, latency_before: latencyBefore?.generatedAt ?? null, network: network?.generatedAt ?? null },
  engine: { vision: after.engine, ocrPasses: after.ocrPasses, host: after.host, onnx: "NOT USED", webgpu: "available on the test machine, NOT USED by the OCR engine", wasm: "USED (SIMD LSTM core)" },
  visual_context: {
    ocr_line_precision: { before: of(B?.visual.ocr_line_precision), after: of(A.visual.ocr_line_precision), after_pct: pct(A.visual.ocr_line_precision) },
    ocr_text_recall: { before: of(B?.visual.ocr_text_recall), after: of(A.visual.ocr_text_recall), after_pct: pct(A.visual.ocr_text_recall) },
    task_relevant_recall_strict: { before: of(B?.visual.task_relevant_recall_strict), after: of(A.visual.task_relevant_recall_strict), after_pct: pct(A.visual.task_relevant_recall_strict) },
    task_relevant_recall_recoverable: { before: of(B?.visual.task_relevant_recall_recoverable), after: of(A.visual.task_relevant_recall_recoverable), after_pct: pct(A.visual.task_relevant_recall_recoverable) },
    price_exact: { before: of(B?.visual.price_exact), after: of(A.visual.price_exact), after_pct: pct(A.visual.price_exact), by_format: A.visual.price_by_format },
    price_recoverable: { before: of(B?.visual.price_recoverable), after: of(A.visual.price_recoverable), after_pct: pct(A.visual.price_recoverable) },
    button_recall: { before: of(B?.visual.button_recall), after: of(A.visual.button_recall), after_pct: pct(A.visual.button_recall), by_style: A.visual.button_by_style },
  },
  boxes: { metric: A.boxes.metric, expected: A.boxes.expected, matched_iou: { before: B?.boxes.matched_iou, after: A.boxes.matched_iou }, matched_iou_or_covered: { before: B?.boxes.matched_iou_or_covered, after: A.boxes.matched_iou_or_covered }, missed: A.boxes.missed, false_lines: { before: B?.boxes.false_lines, after: A.boxes.false_lines }, recall_iou_pct: pct(A.boxes.recall_iou), recall_covered_pct: pct(A.boxes.recall_covered) },
  pii: {
    visual_channel: { before: B?.pii.visual_channel, after: A.pii.visual_channel },
    dom_channel: { before: B?.pii.dom_channel, after: A.pii.dom_channel },
    combined: { before: B?.pii.combined, after: A.pii.combined },
  },
  redaction: { before: B?.redaction, after: A.redaction },
  timing_node: { before: B?.timing, after: A.timing },
  latency_browser: latency ? { before: latencyBefore?.normal_one_round ?? null, after: latency.normal_one_round, price_swap: latency.price_swap, dynamic: latency.dynamic, stale: latency.stale } : null,
  network: network ? { reason_requests: network.requests.length, max_bytes: Math.max(...network.requests.map((r) => r.bytes)), raw_pii_present_any: network.requests.some((r) => r.raw_pii_present), image_data_present_any: network.requests.some((r) => r.image_data_present), base64_run_any: network.requests.some((r) => r.base64_run_present), fields: [...new Set(network.requests.flatMap((r) => r.fields))] } : null,
  visual_context_accuracy_interpretation: {
    single_accuracy_percentage: null,
    reason: "The OCR evaluation is an open-set detection problem: there is no defined set of true negatives, and precision is counted over OCR lines while recall is counted over ground-truth items, so the two counts cannot be combined into one accuracy or F1 figure without inventing a denominator.",
    sih_requirement: "Accuracy of visual context from the screen",
    measured_by: {
      false_detections: { metric: "OCR line precision", value: of(A.visual.ocr_line_precision), pct: pct(A.visual.ocr_line_precision) },
      missed_visual_information: { metric: "OCR text recall", value: of(A.visual.ocr_text_recall), pct: pct(A.visual.ocr_text_recall) },
      task_information_recovered_strict: { metric: "task-relevant recall (strict)", value: of(A.visual.task_relevant_recall_strict), pct: pct(A.visual.task_relevant_recall_strict) },
      task_information_recovered_recoverable: { metric: "task-relevant recall (amount-recoverable)", value: of(A.visual.task_relevant_recall_recoverable), pct: pct(A.visual.task_relevant_recall_recoverable) },
      task_critical_prices_exact: { metric: "exact price recognition", value: of(A.visual.price_exact), pct: pct(A.visual.price_exact) },
      task_critical_prices_numeric: { metric: "numeric price recovery", value: of(A.visual.price_recoverable), pct: pct(A.visual.price_recoverable) },
      task_critical_buttons: { metric: "button recognition", value: of(A.visual.button_recall), pct: pct(A.visual.button_recall) },
      localisation: { metric: "box recall (IoU >= 0.5)", value: `${A.boxes.matched_iou}/${A.boxes.expected}`, pct: pct(A.boxes.recall_iou) },
    },
  },
  phase4_baseline: phase4,
};
mkdirSync(REPORTS, { recursive: true });
writeFileSync(resolve(RESULTS, "metrics.json"), JSON.stringify(metrics, null, 2));

const L = latency?.normal_one_round;
const LB = latencyBefore?.normal_one_round;
const lines = [
  "# PrivSight SIH metrics (generated from evaluation artifacts)",
  "",
  `Generated ${metrics.generatedAt}. Evaluation run ${after.generatedAt}; browser benchmark ${latency?.generatedAt ?? "n/a"}.`,
  "",
  "Visual-only numbers describe the local OCR channel on its own. Combined numbers describe the DOM + vision pipeline as shipped.",
  "",
  "## Local visual perception (Tesseract.js 7 LSTM, WebAssembly, on-device)",
  "",
  "| Metric | Phase 5 before | Phase 5 after | After (%) |",
  "| --- | --- | --- | --- |",
  ...Object.entries(metrics.visual_context).map(([k, v]) => `| ${k.replace(/_/g, " ")} | ${v.before ?? "n/a"} | ${v.after} | ${v.after_pct} |`),
  `| box recall (IoU >= 0.5) | ${B ? `${B.boxes.matched_iou}/${B.boxes.expected}` : "n/a"} | ${A.boxes.matched_iou}/${A.boxes.expected} | ${metrics.boxes.recall_iou_pct} |`,
  `| box recall (IoU or covered >= 0.9) | ${B ? `${B.boxes.matched_iou_or_covered}/${B.boxes.expected}` : "n/a"} | ${A.boxes.matched_iou_or_covered}/${A.boxes.expected} | ${metrics.boxes.recall_covered_pct} |`,
  "",
  `Price by format (after): ${Object.entries(A.visual.price_by_format).map(([f, v]) => `${f} exact ${v.exact}, recoverable ${v.recoverable}`).join("; ")}.`,
  "",
  "## Visual context accuracy: how the SIH requirement is measured",
  "",
  "Visual-context performance is evaluated using precision and recall rather than a single accuracy percentage because the OCR evaluation is an open-set detection problem where true-negative space is not well-defined. Precision is counted over OCR lines and recall over ground-truth items, so the two cannot be combined into one accuracy figure without inventing a denominator. No single accuracy number is reported.",
  "",
  "| Question a judge may ask | Metric | Value |",
  "| --- | --- | --- |",
  `| Does the engine hallucinate text that is not on screen? | OCR line precision | ${of(A.visual.ocr_line_precision)} (${pct(A.visual.ocr_line_precision)}) |`,
  `| Does it miss visible text? | OCR text recall | ${of(A.visual.ocr_text_recall)} (${pct(A.visual.ocr_text_recall)}) |`,
  `| Was the information the task needs recovered exactly? | Task-relevant recall (strict) | ${of(A.visual.task_relevant_recall_strict)} (${pct(A.visual.task_relevant_recall_strict)}) |`,
  `| Was it recovered well enough to act on? | Task-relevant recall (amount-recoverable) | ${of(A.visual.task_relevant_recall_recoverable)} (${pct(A.visual.task_relevant_recall_recoverable)}) |`,
  `| Are prices read exactly? | Exact price recognition | ${of(A.visual.price_exact)} (${pct(A.visual.price_exact)}) |`,
  `| Is the numeric amount recovered? | Numeric price recovery | ${of(A.visual.price_recoverable)} (${pct(A.visual.price_recoverable)}) |`,
  `| Are clickable labels read? | Button recognition | ${of(A.visual.button_recall)} (${pct(A.visual.button_recall)}) |`,
  `| Is text located where it is on screen? | Box recall (IoU >= 0.5) | ${A.boxes.matched_iou}/${A.boxes.expected} (${pct(A.boxes.recall_iou)}) |`,
  "",
  "These are visual-only figures for the local OCR channel. The shipped agent fuses them with the DOM, so a rupee-sign price misread by OCR is still acted on correctly whenever the DOM carries the price.",
  "",
  "## SIH requirement mapping",
  "",
  "| SIH requirement | Measured by | Where |",
  "| --- | --- | --- |",
  "| Accuracy of visual context from the screen | OCR line precision, OCR text recall, task-relevant recall (strict and recoverable), exact price recognition, numeric price recovery, button recognition, box recall | table above; results/visual-results.json, results/boxes-results.json |",
  `| PII detection precision and recall | per channel: visual only ${of(A.pii.visual_channel.precision)} / ${of(A.pii.visual_channel.recall)}, DOM only ${of(A.pii.dom_channel.precision)} / ${of(A.pii.dom_channel.recall)}, combined ${of(A.pii.combined.precision)} / ${of(A.pii.combined.recall)} | PII detection section; results/pii-results.json |`,
  `| Redaction precision | sensitive removed ${of(A.redaction.sensitive_removed)}, precision ${of(A.redaction.precision)}, task-relevant preserved ${of(A.redaction.task_relevant_preserved)} | Redaction section; results/redaction-results.json |`,
  L ? `| Client-side resource utilisation | cold engine load ${ms(L.cold_only.ocr_load_ms)}, warm OCR ${ms(L.ocr_recognize_ms)}, local perception ${ms(L.local_perception_ms)}, JS heap per run | Client-side resources section; results/latency.json |` : "| Client-side resource utilisation | browser benchmark not available | |",
  L ? `| End-to-end latency | n = ${L.runs}: median ${ms(L.total_ms, "median")}, p95 ${ms(L.total_ms, "p95")}, with per-stage breakdown | End-to-end latency section; results/latency.json |` : "| End-to-end latency | browser benchmark not available | |",
  metrics.network ? `| Privacy of network traffic | ${metrics.network.reason_requests} real requests: raw PII ${metrics.network.raw_pii_present_any ? "YES" : "NO"}, image data ${metrics.network.image_data_present_any || metrics.network.base64_run_any ? "YES" : "NO"} | Privacy and network section; results/network-results.json |` : "",
  "",
  "## PII detection",
  "",
  "| Channel | Precision before | Recall before | Precision after | Recall after |",
  "| --- | --- | --- | --- | --- |",
  `| Visual only (OCR) | ${of(B?.pii.visual_channel.precision) ?? "n/a"} | ${of(B?.pii.visual_channel.recall) ?? "n/a"} | ${of(A.pii.visual_channel.precision)} (${pct(A.pii.visual_channel.precision)}) | ${of(A.pii.visual_channel.recall)} (${pct(A.pii.visual_channel.recall)}) |`,
  `| DOM only | ${of(B?.pii.dom_channel.precision) ?? "n/a"} | ${of(B?.pii.dom_channel.recall) ?? "n/a"} | ${of(A.pii.dom_channel.precision)} (${pct(A.pii.dom_channel.precision)}) | ${of(A.pii.dom_channel.recall)} (${pct(A.pii.dom_channel.recall)}) |`,
  `| Combined DOM + vision | ${of(B?.pii.combined.precision) ?? "n/a"} | ${of(B?.pii.combined.recall) ?? "n/a"} | ${of(A.pii.combined.precision)} (${pct(A.pii.combined.precision)}) | ${of(A.pii.combined.recall)} (${pct(A.pii.combined.recall)}) |`,
  "",
  `Combined TP ${A.pii.combined.tp}, FP ${A.pii.combined.fp}, FN ${A.pii.combined.fn}. Cases blocked fail-closed by the firewall: ${A.pii.combined.cases_blocked_by_firewall} (non-PII withheld: ${A.pii.combined.non_pii_withheld_by_block}).`,
  "",
  "## Redaction",
  "",
  `Sensitive values removed ${of(A.redaction.sensitive_removed)} (${pct(A.redaction.sensitive_removed)}); non-sensitive values removed ${A.redaction.non_sensitive_removed}; precision ${of(A.redaction.precision)} (${pct(A.redaction.precision)}); task-relevant items preserved ${of(A.redaction.task_relevant_preserved)}; PII boxes masked at >= 0.9 coverage ${of(A.redaction.pii_boxes_masked)} (${pct(A.redaction.pii_boxes_masked)}).`,
  "",
  "## Client-side resources (browser, offscreen document)",
  "",
  L ? `Normal one-round runs: ${L.runs} (cold ${L.cold_runs}). Capture ${ms(L.capture_ms)}, OCR recognize ${ms(L.ocr_recognize_ms)}, local perception ${ms(L.local_perception_ms)} (cold ${ms(L.cold_only.local_perception_ms)} incl. engine load ${ms(L.cold_only.ocr_load_ms)}), privacy ${ms(L.privacy_ms)}, validate + execute ${ms(L.validate_execute_ms)}.` : "Browser benchmark not available.",
  `Node evaluation OCR (2x fixtures): ${ms(A.timing.ocr_recognize_ms, "mean")} mean per screen with ${after.ocrPasses} pass(es); second pass ${ms(A.timing.ocr_second_pass_ms, "mean")} mean. JS heap in the vision document during browser runs: see latency.json per run.`,
  "CPU and GPU utilisation: not reported (no reliable in-browser measurement).",
  "",
  "## End-to-end latency (browser, live Gemini)",
  "",
  L ? `n = ${L.runs}: min ${ms(L.total_ms, "min")}, median ${ms(L.total_ms, "median")}, mean ${ms(L.total_ms, "mean")}, p95 ${ms(L.total_ms, "p95")}, max ${ms(L.total_ms, "max")}. Cloud reasoning median ${ms(L.cloud_ms, "median")} = ${L.breakdown_share_of_total_mean?.cloud_pct ?? "?"}% of the mean total; local perception ${L.breakdown_share_of_total_mean?.local_perception_pct ?? "?"}%; privacy ${L.breakdown_share_of_total_mean?.privacy_pct ?? "?"}%.` : "n/a",
  LB ? `Before improvements (single OCR pass): n = ${LB.runs}: median ${ms(LB.total_ms, "median")}, mean ${ms(LB.total_ms, "mean")}, p95 ${ms(LB.total_ms, "p95")}; local perception median ${ms(LB.local_perception_ms, "median")}.` : "",
  latency ? `Stale-target safety case (separate): ${latency.stale.map((s) => `${s.totalMs} ms, ${s.rounds} rounds, clicked ${s.clicked}`).join("; ")}. Price swaps: ${latency.price_swap.map((s) => `${s.expected}->${s.clicked}`).join(", ")}.` : "",
  "",
  "## Privacy and network",
  "",
  metrics.network ? `${metrics.network.reason_requests} real /reason requests captured. Raw PII uploaded: ${metrics.network.raw_pii_present_any ? "YES" : "NO"}. Screenshot or base64 image uploaded: ${metrics.network.image_data_present_any || metrics.network.base64_run_any ? "YES" : "NO"}. Largest body ${metrics.network.max_bytes} bytes. Fields: ${metrics.network.fields.join(", ")}. Cloud OCR: NO. Cloud screenshot processing: NO.` : "n/a",
  "",
  "## Engine facts",
  "",
  `Vision: ${metrics.engine.vision}, ${metrics.engine.ocrPasses} pass(es). ONNX: ${metrics.engine.onnx}. WebGPU: ${metrics.engine.webgpu}. WASM: ${metrics.engine.wasm}. Local controller: deterministic orchestration, not an AI model. Cloud LLM: reasoning only.`,
];
writeFileSync(resolve(REPORTS, "sih-summary.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
