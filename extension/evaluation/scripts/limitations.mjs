/**
 * Records the Phase 4 limitation investigations with BEFORE / AFTER numbers
 * read from the result files. Writes evaluation/results/limitation-improvements.json.
 *
 *   node evaluation/scripts/limitations.mjs
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(here, "../results");
const read = (name) => (existsSync(resolve(RESULTS, name)) ? JSON.parse(readFileSync(resolve(RESULTS, name), "utf-8")) : null);

const before = read("phase5-before-improvements.json")?.summary;
const after = read("latest.json")?.summary;
const latB = read("latency-before-improvements.json")?.normal_one_round;
const latA = read("latency.json")?.normal_one_round;
const cloud = read("cloud-latency.json");
const of = (m) => (m && m.of !== undefined ? m.of : m);
const med = (d, k = "median") => (d && d[k] !== undefined ? d[k] : null);

const record = {
  generatedAt: new Date().toISOString(),
  decision_rule: "SOLVED = eliminated with repeated measurement; IMPROVED = reduced; UNCHANGED = best safe option kept; NOT PRACTICAL = attempted and unsuitable",
  limitations: {
    A_rupee_price_ocr: {
      status: "UNCHANGED (visual) / mitigated by DOM conflict resolution",
      baseline: { price_exact: of(before?.visual.price_exact), rupee_sign_exact: before?.visual.price_by_format?.["rupee-sign"]?.exact, rs_inr_exact: `${before?.visual.price_by_format?.Rs?.exact} + ${before?.visual.price_by_format?.INR?.exact}` },
      change_attempted: "grayscale, autocontrast, binarisation (160), inversion, polarity normalisation, page-segmentation modes 3/6/11; tessdata_best English model",
      result: "No preprocessing variant changed rupee-sign recognition (the fast English model has no usable glyph for U+20B9 and emits 7 or %). The larger tessdata_best model aborts in the bundled WebAssembly core (missing float dot-product export) and cannot be used without a different core build. Rs and INR formats are recognised exactly.",
      after: { price_exact: of(after?.visual.price_exact), rupee_sign_exact: after?.visual.price_by_format?.["rupee-sign"]?.exact, price_recoverable: of(after?.visual.price_recoverable) },
      latency_impact: "none (no change kept)",
      resource_impact: "none",
      security_impact: "none",
      final_decision: "Keep DOM-first conflict resolution (DOM price wins, conflict reported). Visual-only rupee prices remain a documented limitation.",
    },
    B_button_label_ocr: {
      status: "IMPROVED",
      baseline: { button_recall: of(before?.visual.button_recall), by_style: before?.visual.button_by_style },
      change_attempted: "second OCR pass on a polarity-normalised copy (|luma-128|*2) with automatic segmentation, merged where it adds lines; fused columns split at wide word gaps; only confident first-pass lines suppress second-pass lines",
      after: { button_recall: of(after?.visual.button_recall), by_style: after?.visual.button_by_style, ocr_line_precision: of(after?.visual.ocr_line_precision), false_lines: after?.boxes.false_lines },
      before_precision: { ocr_line_precision: of(before?.visual.ocr_line_precision), false_lines: before?.boxes.false_lines },
      latency_impact: { node_ocr_mean_ms: { before: before?.timing.ocr_recognize_ms?.mean, after: after?.timing.ocr_recognize_ms?.mean, second_pass_mean_ms: after?.timing.ocr_second_pass_ms?.mean }, browser_local_perception_median_ms: { before: med(latB?.local_perception_ms), after: med(latA?.local_perception_ms) }, browser_total_median_ms: { before: med(latB?.total_ms), after: med(latA?.total_ms) } },
      resource_impact: "one extra recognition per screen in the offscreen document; JS heap unchanged order (see latency.json)",
      security_impact: "none: the second pass runs on the same local canvas; nothing new leaves the device",
      final_decision: "KEEP. Remaining misses: dark-on-light labels inside light cells and some white-on-green/red/black/yellow styles.",
    },
    C_visual_pii_recall: {
      status: "IMPROVED",
      baseline: before?.pii.visual_channel,
      change_attempted: "layout-proximity labelling: a short PII label line types the value in the neighbouring OCR line (same row to the right, or directly below) only when the value has the shape the label demands; second OCR pass also recovers values",
      after: after?.pii.visual_channel,
      combined_before: before?.pii.combined,
      combined_after: after?.pii.combined,
      dom_channel: after?.pii.dom_channel,
      false_positives_after: after?.pii.visual_channel?.fp,
      latency_impact: "negligible (pure post-processing over OCR lines)",
      security_impact: "recall up, precision unchanged at 100%; bare numbers without a PII label are never classified",
      final_decision: "KEEP. Remaining visual miss: a card number inside an input box that OCR misreads (Luhn fails); the DOM channel covers it.",
    },
    D_bare_mobile_shaped_values: {
      status: "UNCHANGED (fail closed)",
      baseline: "a bare 6..9-leading 10-digit value in a non-sensitive field, or a non-PII value sharing digits with a known OTP, blocks the request",
      change_attempted: "field text is redacted with its label as context (Phase 4 remaining tests); no verifier relaxation attempted in Phase 5",
      dom_only: { cases_blocked: after?.pii.dom_channel?.cases_blocked_by_firewall, non_pii_withheld: after?.pii.dom_channel?.non_pii_withheld_by_block },
      combined_before: { cases_blocked: before?.pii.combined?.cases_blocked_by_firewall, non_pii_withheld: before?.pii.combined?.non_pii_withheld_by_block, non_pii_redacted: before?.pii.combined?.fp },
      combined_after: { cases_blocked: after?.pii.combined?.cases_blocked_by_firewall, non_pii_withheld: after?.pii.combined?.non_pii_withheld_by_block, non_pii_redacted: after?.pii.combined?.fp },
      privacy_impact: "none; a value that shares digits with a known secret is redacted everywhere (over-redaction) and, when the verifier still finds it, the request is blocked",
      final_decision: "Keep fail-closed. On pii-collision the DOM-only channel blocks the request (non-PII withheld); with vision the colliding quantity is redacted as the OTP and the request proceeds without the quantity. 0 leaks in either mode.",
    },
    E_onnx_webgpu: {
      status: "NOT PRACTICAL within Phase 5 (not attempted beyond feasibility)",
      tesseract_baseline: after?.timing.ocr_recognize_ms,
      onnx: "NOT USED",
      webgpu: "adapter available on the test machine; NOT USED by the OCR engine",
      reason: "No small pretrained browser-side text detector with simple post-processing was within the time box; the WebAssembly OCR path met the perception requirement and its cost is a minority of end-to-end latency, which the cloud round trip dominates.",
      final_decision: "Not adopted. Architecture keeps a model-agnostic OCR engine interface.",
    },
    F_local_controller: {
      status: "UNCHANGED",
      current: "deterministic Local Browser Agent / Controller (bounded observe-perceive-sanitise-reason-validate-execute loop, at most two re-observations)",
      local_model_for_vision: "Tesseract.js 7 LSTM (WebAssembly)",
      local_model_for_reasoning: "none",
      investigation: "no lightweight local reasoning model was practical within the Phase 5 budget; adding one for wording alone was rejected",
      final_decision: "Keep the deterministic controller; describe it as orchestration, not as an AI model.",
    },
    G_firefox: {
      status: "NOT RUNTIME-TESTED",
      chrome: "tested (Chromium via Playwright, and Chrome manually)",
      firefox: "not installed on the development machine; portability designed (chrome.* isolated in src/host/chrome.ts) but not validated",
      final_decision: "Document only.",
    },
    H_cloud_latency: {
      status: cloud ? (cloud.thinking_budget_0?.ms && cloud.default_thinking?.ms ? "MEASURED" : "MEASURED (one arm failed)") : "NOT MEASURED",
      baseline_cloud_ms: latB?.cloud_ms,
      request_bytes: cloud?.request_bytes,
      change_attempted: "GEMINI_THINKING_BUDGET=0 (skip the model's reasoning phase); prompt/context size unchanged, privacy unchanged",
      experiment: cloud ? { default_thinking: { ok: cloud.default_thinking?.ok, correct: cloud.default_thinking?.correct_target, ms: cloud.default_thinking?.ms }, thinking_budget_0: { ok: cloud.thinking_budget_0?.ok, correct: cloud.thinking_budget_0?.correct_target, ms: cloud.thinking_budget_0?.ms } } : null,
      final_decision: "see report",
    },
  },
};
writeFileSync(resolve(RESULTS, "limitation-improvements.json"), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record.limitations.B_button_label_ocr.latency_impact, null, 1));
console.log(JSON.stringify(record.limitations.H_cloud_latency, null, 1));
