# PrivSight evaluation (Phase 5)

Reproducible, quantitative evaluation of the shipped pipeline against
hand-written ground truth. Nothing here is typed in from observation: ground
truth is written from the page sources, boxes come from page geometry, and
every number in `results/` is computed by the scripts.

```
evaluation/
  cases.json                  the cases: page, role, ground-truth box selectors
  fixtures/                   real Chromium screenshots (device scale 2), generated
  ground-truth/<case>.json    hand-written: expected text, prices, buttons, PII, non-PII
  ground-truth/<case>.boxes.json  generated from page geometry (never from OCR)
  scripts/render-fixtures.mjs renders fixtures + boxes with Playwright Chromium
  scripts/evaluate.eval.ts    the harness: real OCR + real DOM pipeline, scores everything
  scripts/benchmark.chrome.ts browser benchmark: built extension, live backend, real traffic
  scripts/summarize.mjs       presentation summary from the result files
  results/                    machine-readable results (sanitized; no values, no images)
  results/baseline-phase4/    frozen Phase 4 numbers
  results/local/              scratch (gitignored): image variants, model experiments
  reports/sih-summary.md      generated summary
```

## Commands

```
npm run eval:render     # re-render fixtures and ground-truth boxes (needs Playwright Chromium)
npm run eval            # evaluation harness -> results/latest.json + per-area files
npm run benchmark       # browser benchmark -> results/latency.json, results/network-results.json
node evaluation/scripts/summarize.mjs   # -> results/metrics.json, reports/sih-summary.md
PRIVSIGHT_SINGLE_PASS=1 npm run eval    # harness with the single-pass OCR (Phase 4 behaviour)
```

The benchmark needs the backend on :8000 with a real key and `npm run build`.

## Cases

| Case | Page | What it tests |
| --- | --- | --- |
| shirtstore-basic | index.html | DOM + vision, PII in DOM text and fields |
| visual-fallback | visual.html | one product name/price only on canvas |
| visual-only | visual-only.html | all names/prices only on canvas; A cheapest |
| visual-privacy | visual-privacy.html | PII only on canvas beside an order id and a date |
| price-formats | eval/price-formats.html | 12 prices: rupee sign, Rs, INR; 14 to 32 px; 4 backgrounds |
| buttons | eval/buttons.html | 12 labels in 8 colour styles, 3 sizes |
| pii-layouts | eval/pii-layouts.html | same-line, form-row and stacked PII beside 12 non-PII values |
| pii-collision | eval/pii-collision.html | the same digits as an OTP and as a quantity |

## Metric definitions (fixed before results were seen)

- OCR line precision: lines at confidence >= 0.55 whose 3+ letter words all occur in the
  ground-truth corpus / all such lines.
- OCR text recall: ground-truth text items found in the OCR output (space-insensitive).
- Task-relevant recall: product names + price texts + button labels found; "recoverable"
  additionally accepts a price whose numeric amount is recoverable despite a misread glyph.
- Price exact: a price line whose parsed amount equals the expected amount.
- Button recall: expected labels matched by the observation matcher.
- Box match: IoU >= 0.5 with any OCR line box (primary) or coverage >= 0.9 (secondary).
- Mask coverage: a PII box counts as masked when mask regions cover >= 0.9 of it.
- PII per channel: TP / FP / FN. Visual channel = OCR lines through the visual detectors;
  DOM channel = the real content-script pipeline without vision; combined = with vision.
  A fail-closed firewall block sends nothing: it counts as protected and the withheld
  non-PII is reported separately as over-blocking.
- Redaction precision = removed / (removed + non-sensitive removed).

### Visual context accuracy (SIH requirement)

No single "accuracy" percentage is reported for the visual channel. The OCR
evaluation is an open-set detection problem: there is no defined set of true
negatives (a screen is not a fixed list of candidates that could be marked
absent), and precision is counted over OCR lines while recall is counted over
ground-truth items, so the two cannot be combined into one accuracy or F1 figure
without inventing a denominator. The requirement is therefore evidenced by the
separate measures above: OCR line precision (false detections), OCR text recall
(missed visual information), task-relevant recall (whether the information the
task needs was recovered, strictly and amount-recoverably), exact price
recognition, numeric price recovery, button recognition, and box recall
(localisation). They are reported side by side so that a weakness in one (for
example rupee-sign prices) is not hidden by strength in another.

## Disclosures

- The harness was corrected twice after first runs, before any number was reported:
  ground-truth boxes were changed from element layout boxes to glyph-ink boxes
  (line boxes are 40% taller than ink and made every mask fail the 0.9 coverage test),
  and adjacent numeric field values are now separated by a non-digit token so two
  values cannot merge into one digit run.
- The OTP/quantity collision was moved out of `pii-layouts` into its own case
  (`pii-collision`) after the first run showed it blocked the whole page; the hard
  case is kept and reported, not removed. Shipped behaviour on it: the DOM-only channel
  blocks the request (fail closed, the non-PII values are withheld); with vision the
  colliding quantity is redacted as the OTP and the request proceeds without it. No leak
  in either mode.
- Non-PII ground-truth values that are long digit runs are written to `results/` by shape
  only (`<nonpii:6-digit>`), because a decoy may share digits with a PII fixture.
- Fixtures are rendered at device scale 2 and OCR'd at scale 1; the extension captures
  at the display's DPR and upscales toward 2x. Timings from Node are not browser timings;
  browser timings are in `results/latency.json`.
- Raw PII, OCR dumps and screenshots are never written to `results/`. Misses are reported
  by type and layout.
