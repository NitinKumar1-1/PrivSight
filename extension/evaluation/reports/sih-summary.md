# PrivSight SIH metrics (generated from evaluation artifacts)

Generated 2026-09-11T21:34:02.702Z. Evaluation run 2026-09-11T21:28:19.616Z; browser benchmark 2026-09-11T20:52:13.546Z.

Visual-only numbers describe the local OCR channel on its own. Combined numbers describe the DOM + vision pipeline as shipped.

## Local visual perception (Tesseract.js 7 LSTM, WebAssembly, on-device)

| Metric | Phase 5 before | Phase 5 after | After (%) |
| --- | --- | --- | --- |
| ocr line precision | 131/134 | 153/158 | 96.8% |
| ocr text recall | 77/77 | 77/77 | 100.0% |
| task relevant recall strict | 51/86 | 69/86 | 80.2% |
| task relevant recall recoverable | 59/86 | 78/86 | 90.7% |
| price exact | 11/26 | 12/26 | 46.2% |
| price recoverable | 19/26 | 22/26 | 84.6% |
| button recall | 3/24 | 19/24 | 79.2% |
| box recall (IoU >= 0.5) | 78/111 | 95/111 | 85.6% |
| box recall (IoU or covered >= 0.9) | 83/111 | 103/111 | 92.8% |

Price by format (after): rupee-sign exact 2/16, recoverable 12/16; Rs/INR exact 4/4, recoverable 4/4; Rs exact 4/4, recoverable 4/4; INR exact 2/2, recoverable 2/2.

## Visual context accuracy: how the SIH requirement is measured

Visual-context performance is evaluated using precision and recall rather than a single accuracy percentage because the OCR evaluation is an open-set detection problem where true-negative space is not well-defined. Precision is counted over OCR lines and recall over ground-truth items, so the two cannot be combined into one accuracy figure without inventing a denominator. No single accuracy number is reported.

| Question a judge may ask | Metric | Value |
| --- | --- | --- |
| Does the engine hallucinate text that is not on screen? | OCR line precision | 153/158 (96.8%) |
| Does it miss visible text? | OCR text recall | 77/77 (100.0%) |
| Was the information the task needs recovered exactly? | Task-relevant recall (strict) | 69/86 (80.2%) |
| Was it recovered well enough to act on? | Task-relevant recall (amount-recoverable) | 78/86 (90.7%) |
| Are prices read exactly? | Exact price recognition | 12/26 (46.2%) |
| Is the numeric amount recovered? | Numeric price recovery | 22/26 (84.6%) |
| Are clickable labels read? | Button recognition | 19/24 (79.2%) |
| Is text located where it is on screen? | Box recall (IoU >= 0.5) | 95/111 (85.6%) |

These are visual-only figures for the local OCR channel. The shipped agent fuses them with the DOM, so a rupee-sign price misread by OCR is still acted on correctly whenever the DOM carries the price.

## SIH requirement mapping

| SIH requirement | Measured by | Where |
| --- | --- | --- |
| Accuracy of visual context from the screen | OCR line precision, OCR text recall, task-relevant recall (strict and recoverable), exact price recognition, numeric price recovery, button recognition, box recall | table above; results/visual-results.json, results/boxes-results.json |
| PII detection precision and recall | per channel: visual only 18/18 / 18/19, DOM only 13/13 / 13/16, combined 20/22 / 20/20 | PII detection section; results/pii-results.json |
| Redaction precision | sensitive removed 20/20, precision 20/22, task-relevant preserved 103/103 | Redaction section; results/redaction-results.json |
| Client-side resource utilisation | cold engine load 1143 ms, warm OCR 2068 ms, local perception 2174 ms, JS heap per run | Client-side resources section; results/latency.json |
| End-to-end latency | n = 10: median 7924 ms, p95 13610 ms, with per-stage breakdown | End-to-end latency section; results/latency.json |
| Privacy of network traffic | 19 real requests: raw PII NO, image data NO | Privacy and network section; results/network-results.json |

## PII detection

| Channel | Precision before | Recall before | Precision after | Recall after |
| --- | --- | --- | --- | --- |
| Visual only (OCR) | 14/14 | 14/19 | 18/18 (100.0%) | 18/19 (94.7%) |
| DOM only | 13/13 | 13/16 | 13/13 (100.0%) | 13/16 (81.3%) |
| Combined DOM + vision | 17/19 | 17/20 | 20/22 (90.9%) | 20/20 (100.0%) |

Combined TP 20, FP 2, FN 0. Cases blocked fail-closed by the firewall: 0 (non-PII withheld: 0).

## Redaction

Sensitive values removed 20/20 (100.0%); non-sensitive values removed 2; precision 20/22 (90.9%); task-relevant items preserved 103/103; PII boxes masked at >= 0.9 coverage 17/21 (81.0%).

## Client-side resources (browser, offscreen document)

Normal one-round runs: 10 (cold 1). Capture 66 ms, OCR recognize 2068 ms, local perception 2174 ms (cold 3900 ms incl. engine load 1143 ms), privacy 330 ms, validate + execute 32 ms.
Node evaluation OCR (2x fixtures): 1906 ms mean per screen with 2 pass(es); second pass 1018 ms mean. JS heap in the vision document during browser runs: see latency.json per run.
CPU and GPU utilisation: not reported (no reliable in-browser measurement).

## End-to-end latency (browser, live Gemini)

n = 10: min 7592 ms, median 7924 ms, mean 8413 ms, p95 13610 ms, max 13610 ms. Cloud reasoning median 5297 ms = 66.8% of the mean total; local perception 27.4%; privacy 3.9%.
Before improvements (single OCR pass): n = 10: median 7411 ms, mean 7815 ms, p95 9514 ms; local perception median 1200 ms.
Stale-target safety case (separate): 14996 ms, 2 rounds, clicked (none). Price swaps: el_buy_a->buy_a, el_buy_a->buy_a, el_buy_b->buy_b, el_buy_b->buy_b, el_buy_c->buy_c, el_buy_c->buy_c.

## Privacy and network

19 real /reason requests captured. Raw PII uploaded: NO. Screenshot or base64 image uploaded: NO. Largest body 1965 bytes. Fields: task, page, placeholders, visual. Cloud OCR: NO. Cloud screenshot processing: NO.

## Engine facts

Vision: tesseract.js 7 LSTM (wasm), 2 pass(es). ONNX: NOT USED. WebGPU: available on the test machine, NOT USED by the OCR engine. WASM: USED (SIMD LSTM core). Local controller: deterministic orchestration, not an AI model. Cloud LLM: reasoning only.
