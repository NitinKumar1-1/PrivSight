# PrivSight

Privacy-preserving browser agent. Smart India Hackathon 2026, problem statement SIH26171.

## Phase 5: measured evaluation

Phase 5 adds a reproducible SIH evaluation under `extension/evaluation/`
(see its README): eight rendered cases with hand-written ground truth and
page-geometry boxes, a harness that runs the real OCR engine and the real
DOM pipeline per channel, a browser benchmark that drives the built extension
against the live backend while recording every request, and a summary
generator. Results live in `extension/evaluation/results/` and
`extension/evaluation/reports/sih-summary.md`; every number there is computed.

Two measured improvements were kept from the Phase 4 limitation review:

- **Second OCR pass** on a polarity-normalised copy of the capture, merged
  where it adds lines the first pass missed and split at wide word gaps so
  fused columns stay separate. Recovers light-on-colour button labels.
  Costs about one extra recognition per screen.
- **Layout-proximity visual PII**: a label line ("Card number", "OTP",
  "Verification code") types a value in the neighbouring OCR line, to its
  right or directly below, only when the value has the shape the label
  demands. Recovers form-row and stacked layouts without classifying bare numbers.

Investigated and not adopted, with reasons recorded in the Phase 5 report:
rupee-sign recognition (the glyph is misread by the bundled fast English
model in every preprocessing variant; the larger model aborts in the bundled
core), ONNX/WebGPU (not attempted beyond feasibility; the OCR engine runs on
WebAssembly), and a Gemini thinking-budget setting (available as
`GEMINI_THINKING_BUDGET`, measured, see the report).

## Current scope (Phase 4)

Phase 1 proved the plumbing. Phase 2 added local PII detection and redaction.
Phase 3 made privacy and execution enforced local boundaries. Phase 4 adds
local visual perception, visual privacy, and a bounded local browser agent:

```
POPUP            user task
SERVICE WORKER   LOCAL BROWSER AGENT / CONTROLLER (deterministic, bounded loop)
                   OBSERVE   chrome.tabs.captureVisibleTab -> screenshot stays in memory
OFFSCREEN DOC      PERCEIVE  local neural OCR (Tesseract.js 7 LSTM, WebAssembly,
                             assets bundled) -> lines + boxes + confidence
CONTENT SCRIPT     DOM extraction (after DOM settles)
                   DOM + VISUAL FUSION (DOM first; vision supplements; conflicts recorded)
                   hybrid PII detection over fields, page text and OCR lines
                   redaction -> bounding-box mask regions -> ReasonRequest (+ visual block)
                   serialize -> LEAKAGE VERIFIER (structure, image-data, known values, patterns)
                   -> PRIVACY FIREWALL -> approved bytes or block
SERVICE WORKER   pattern re-check -> fetch (the only network call)
BACKEND          FastAPI -> LLMReasoner (Gemini) -> parser -> ActionResponse
SERVICE WORKER   untrusted response object
CONTENT SCRIPT   ACTION VALIDATOR (live page) -> executor -> click
CONTROLLER       re-observe at most twice if the target was stale; otherwise stop
```

What is and is not an AI model here, stated plainly:

- The local vision component is **Tesseract.js 7**, a pretrained LSTM neural
  OCR model running in WebAssembly inside the extension's offscreen document.
  It provides local neural OCR-based visual perception: text, boxes,
  confidence. It is not a general object detector or scene-understanding model.
- The Local Browser Agent / Controller is **deterministic TypeScript**. It is
  not an AI model. Its `reason` port is the cloud LLM; a local model could be
  slotted in behind the same port later.
- ONNX Runtime Web and WebGPU are **not used**. WebGPU availability is probed
  and shown in the popup for information only.

Two trust boundaries, both enforced locally:

- **Privacy.** Raw values and the placeholder map exist only in the content
  script. The firewall serializes the request there, the independent leakage
  verifier checks the exact bytes (known values in any variant, its own
  email/card/phone patterns, exact contract shape), and only an approved
  string is handed to the service worker. `postReason` re-runs the pattern
  and structure checks on that string immediately before `fetch`. Any doubt
  is a block. Blocked reasons name the type only, never the value.
- **Execution.** Everything the backend returns is untrusted. The action
  validator runs in the content script and checks structure, allowlisted
  action, confidence range, executable content, target format and presence
  in the live DOM, target compatibility, value rules, http/https-only
  navigation, and the sensitive-field policy (a placeholder only into a field
  of the same type, never a raw value into a sensitive field). The executor
  accepts only validated actions and still implements click and done;
  contract-valid but unimplemented actions are rejected as "unsupported by
  current executor".

Not in this phase: ONNX/WebGPU inference, general visual reasoning,
unrestricted autonomous agents, coordinate clicking, real-world website
support, Firefox runtime testing.

### Screenshot locality

The screenshot exists only in the service worker and the offscreen document,
both extension-internal. It is never placed in a request. Four independent
guards keep it that way: the wire contract has no image field; the backend
rejects unknown fields; the leakage verifier blocks `data:image`, base64 runs
and oversized strings; and the pre-fetch gate re-runs those checks on the
exact bytes. The masked preview shown in the popup is local UI only.

### Visual privacy

OCR lines go through the same redactor as page text, so placeholder numbering
is consistent. Two signals type a value: the existing regexes (email, Luhn
card, mobile with an order/invoice guard) and a label rule for lines like
`OTP: 123456` or `Password: ...`. Value shape alone never classifies. For every
line that held a value the matching word boxes become mask regions, drawn
locally over the capture for the demonstration.

### DOM + visual fusion

DOM first. A visual line already present in the DOM is dropped. A visual line
the DOM lacks (canvas content) is kept. A visual button label is mapped to the
live DOM button by accessible text and carries its `data-ps-id`; there is no
coordinate target. A visual price that disagrees with the DOM price for the
same product is dropped and reported as a CONFLICT line; the prompt tells the
model to trust the page text. On the demo pages the rupee sign is read as
"7" by the OCR engine, so those conflicts are real and visible.

### Dynamic pages

Extraction waits for the DOM to settle (300 ms quiet, 2 s cap). The validator
checks the live DOM at execution time. On an unknown or stale target the
controller re-observes, at most twice, then stops.

### Demo pages

| Page | Purpose |
| --- | --- |
| `index.html` | DOM + vision. Three products, three buttons, fake PII in DOM text and fields. |
| `visual.html` | Visual fallback. Shirt C's name and price are drawn on a canvas; the DOM has only the button. |
| `visual-privacy.html` | Visual PII. Email, phone, card and OTP exist only as canvas pixels, next to an order id and a date that must not be redacted. |
| `dynamic.html` | Delayed insertion of Buy Now C (`?delay=ms`) and optional removal (`?vanish=ms`) for stale-target tests. |
| `visual-only.html` | Every product name and price exists only as canvas pixels (A is cheapest at Rs 499); the DOM has the buttons only. Proves the answer comes from local vision. |

## Layout

```
backend/     FastAPI app. POST /reason validates, prompts the configured LLM, returns one action.
  app/llm/   Provider-independent LLMReasoner interface, Gemini adapter, stub, prompt, parser.
extension/   Chrome Manifest V3 extension (TypeScript, Vite).
  src/privacy/  Hybrid detectors, Redactor, sanitizer, leakage verifier, privacy firewall.
  src/content/  Element ids, perception, action validator, executor, message handlers.
demo-site/   Local shopping page with fake PII used as the controlled test target.
```

The wire contract lives in two files that must stay identical:

- `extension/src/shared/contract.ts`
- `backend/app/schemas.py`

## Run

Three terminals.

**1. Backend** (port 8000)

```
cd backend
pip install -r requirements.txt
copy .env.example .env        # then put your Gemini key in .env (server-side only)
python -m uvicorn app.main:app --port 8000 --reload --env-file .env
```

Check: `curl http://localhost:8000/health` returns `{"status":"ok"}`.

Without a key the server still starts, and `/reason` answers HTTP 503 with a
message saying the key is missing. For an offline demo set `LLM_PROVIDER=stub`
in `.env`; the stub returns the Phase 1 hardcoded click and is never chosen
automatically.

Environment variables (see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_PROVIDER` | `gemini` | `gemini` or `stub` |
| `GEMINI_API_KEY` | none | Required for `gemini`. Never put it in the extension. |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Primary model |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.5-flash-lite,gemini-3.5-flash,gemini-flash-latest` | Tried in order if the primary is retired (404) or overloaded (503) |
| `LLM_TIMEOUT_SECONDS` | `30` | Upstream request timeout per attempt |

Each model gets up to 3 attempts with a short pause on 429/5xx or a network
blip before the next model is tried. The backend log line `[llm] gemini model=...`
shows which model answered. A run can take 5 to 30 seconds depending on load.

**2. Demo site** (port 8080)

```
cd demo-site
python -m http.server 8080
```

Open http://localhost:8080/index.html in Chrome.

Opening `index.html` directly as a `file://` URL also works, but then you must
tick "Allow access to file URLs" on the extension card in `chrome://extensions`.

**3. Extension**

```
cd extension
npm install
npm run build
```

Then in Chrome: `chrome://extensions`, enable Developer mode, Load unpacked,
select `extension/dist`. After every `npm run build`, click the reload icon on
the extension card.

The build runs twice: popup, offscreen document and service worker first,
then the content script on its own (`vite.content.config.ts`) so
`dist/content.js` stays a single file even though it shares the privacy
modules with the service worker. The OCR worker, WebAssembly core and English
weights are copied from `public/vendor/` into `dist/vendor/`; nothing is
fetched from a CDN at runtime.

## Demo

1. Open the demo site tab. It shows fake account data (`demo@example.com`,
   `9999999999`) and a prefilled delivery form with a password, card number
   and OTP. All values are test data.
2. Click the PrivSight toolbar icon.
3. The task box is prefilled with "Find the cheapest black shirt and click Buy Now". Click Run.
4. The pipeline panel fills in: Local PII detection, Leakage verification,
   Privacy Firewall, Cloud reasoning, Local action validator, Browser
   execution. The badge reads PROTECTED once the firewall allows the request.
   Hover a row for details (signal names and check names, never values).
5. Expand "Sanitized payload sent to backend" in the popup to see the exact
   request body. It contains placeholders and no raw values.
6. Each product has its own button (Buy Now A, B, C with ids `el_buy_a`,
   `el_buy_b`, `el_buy_c`). The model must pick one; the chosen button turns
   green and the line under the grid reads, for example, "Black Shirt C
   Purchased". Change the prices in `demo-site/index.html` and run again to
   see the target change with them.

Keep the popup open during the run. Status lines are sent to the popup live and
are not stored, so closing it mid-run loses the log (the action still executes).

## Privacy verification

This is the key Phase 2 check. Do it against the real network request, not the popup.

1. `chrome://extensions`, PrivSight card, "Inspect views: service worker".
2. Open the Network tab, run the task, select the `/reason` request, view Payload.
3. Confirm the body contains `[EMAIL_1]`, `[PHONE_1]`, `[PASSWORD_1]`, `[CARD_1]`, `[OTP_1]`
   and does not contain `demo@example.com`, `9999999999`, `DemoPassword123`,
   `4111 1111 1111 1111` or `123456`.
4. The backend terminal prints `[reason] ... elements=N placeholders=M` and
   `[reason] provider=gemini action=click target=el_buy_c`. It never prints page text.
5. With `LLM_DEBUG=1` the terminal also prints the exact prompt sent to Gemini.

### Seeing the firewall block

The firewall only blocks when something is actually wrong, so the demo page
never triggers it. The block path is exercised by tests that sabotage the
redactor (`tests/privacy/firewall.test.ts`, `tests/content/pipeline.test.ts`)
and assert that the verdict is BLOCKED, the reason names only the PII type,
and `fetch` is never called. The popup shows REQUEST BLOCKED with the reason
in that case.

The same check runs automatically in `extension/tests/privacy/sanitize.test.ts`,
which serializes the outgoing request from a copy of the demo page and asserts
every raw value is absent.

## How detection works

`extension/src/privacy/detectors.ts`

- Form fields are scored from several signals. Strong (3): input type,
  autocomplete token. Medium (2): keywords in name, id, class, placeholder,
  aria-label, associated label. Weak (1): nearby text, the shape of the current
  value. A type needs a total of 2, so a 10-digit order number or a 6-digit
  code on its own never classifies a field. Strong signals win conflicts.
- Free text: regexes for emails, phone numbers (Indian with optional +91,
  international with +, US style) and card numbers (13 to 19 digits, Luhn
  checked). A digit run preceded by "order", "invoice", "ref", "tracking" or
  similar is treated as an identifier, not a phone.

`extension/src/privacy/redactor.ts` assigns `[TYPE_n]` placeholders in order of
discovery. The same value always gets the same placeholder within a run. Field
values are registered first so a value that also appears in page text reuses
the field's placeholder. Over-detection is the safe failure mode.

Element IDs are never derived from a field's value (see `element-ids.ts`), so a
filled email field without an `id` attribute cannot leak through its identifier.

## Tests

Backend (47 tests: validation incl. forbidden image fields, reasoner integration, error mapping, parser, prompt incl. visual section, Gemini adapter with mocked HTTP, CORS):

```
cd backend
python -m pytest
```

Extension (199 unit tests: hybrid detectors with conflict and false-positive cases, labelled-value
visual PII rule, redactor incl. digit-bounded numeric values, sanitizer, leakage verifier incl.
image-data checks, firewall including the sabotaged-redactor block, OCR output parsing, observation
building, DOM + visual fusion, bounding-box masking, DOM settle wait, agent controller state machine,
action validator, false-positive page, pipeline integration with a fetch stub, executor), plus 5
integration tests that run the real OCR engine on real screenshots:

```
cd extension
npm test
```

Neither suite needs the servers, Chrome or a Gemini key.

End-to-end price-swap test in jsdom (needs the backend running with a real
key). It loads the actual `demo-site/index.html`, runs the real extraction,
firewall and network gate, calls the live backend, validates the response and
runs the page's own click handler, for three price configurations:

```
cd extension
npm run test:e2e
```

Real-browser end-to-end (needs the backend and `npm run build`). Loads the
built extension into Playwright's Chromium headless, drives the popup, and
asserts on every network request the browser makes: DOM + vision, visual
fallback, visual-only (canvas prices), visual PII, delayed button, stale target,
injected malicious actions, three repeated runs, and the three price
configurations. Results are written to `e2e/chrome-results.json`. Branded Chrome 137+ ignores `--load-extension`, which is why
Playwright's Chromium build is used for automation; the extension itself is
loaded unpacked into the installed Chrome for manual runs.

```
npx playwright install chromium   # once
npm run test:chrome
```

SIH evaluation harness (no backend needed). Runs the real bundled OCR engine
over real Chrome screenshots in `eval/fixtures/` (rendered headless at device
scale 2), scores against `eval/ground-truth.json`, and writes
`eval/results.json`. Every number is computed; see that file for the latest.

```
npm run eval
```

## Measured results (Phase 4, this machine)

All numbers below were produced by the harnesses in this repository, not
estimated. Machine: i5-13420H, Intel UHD integrated GPU, 24 GB RAM, Chrome 152
for manual runs, Playwright Chromium 1243 for automated runs.

**Local OCR perception** (`npm run eval`, real bundled engine over real
Chrome screenshots at device scale 2, see `extension/eval/results.json`):

| Metric | Result |
| --- | --- |
| Expected visible text found | 31 / 31 |
| Canvas-only text found (not in DOM) | 8 / 8 |
| Prices, strict string match | 1 / 9 |
| Prices, amount recoverable (trailing digits) | 9 / 9 |
| Buttons (white text on orange) | 0 / 9 |
| OCR line precision | 47 / 55 (0.855) |
| OCR recognize time, Node/WASM | 1017 to 1394 ms per page, mean 1221 ms |

The rupee glyph is consistently read as "7" (`₹799` becomes `7799`), which
is why strict price matching is low while the amount is recoverable. The
fusion layer reports these as conflicts and the DOM value wins. Button
labels on this design are not recognised by the engine in any tested mode;
buttons come from the DOM, and the visual button mapping is a bonus when it
works (2 of 3 mapped in the in-browser runs).

**Visual PII** (line level, same harness): precision 8 / 8 (1.0), recall
8 / 10 (0.8). The two misses are on `index.html`, where the card number and
OTP sit inside form inputs whose rendered text the engine reads as
`4111: 1191: 1111 1111` and a detached `123456`; those values are still
redacted through the DOM field path, so nothing leaks. Zero false positives
across prices, product names, order ids and dates.

**Redaction**: sensitive values removed 7 / 7, task-relevant strings
preserved 40 / 40.

**In-browser, built extension** (`npm run test:chrome`, two complete passes,
8 of 8 scenarios each). Per-run figures from the popup's metrics panel:

| Stage | Measured |
| --- | --- |
| Screen capture | 52 to 98 ms |
| OCR engine load (first run only) | 1163 to 1228 ms |
| OCR recognize (in-browser, WASM) | 1042 to 1964 ms |
| Privacy processing (settle wait, fusion, redaction, firewall) | 306 to 2127 ms |
| Cloud reasoning (Gemini free tier, with retries) | 5.7 to 31 s |
| Validate and execute | 2 to 65 ms |
| End to end | 8.3 to 33 s, dominated by the cloud call |
| JS heap of the vision document | 2 to 5 MB (worker heap not included) |

Scenarios: DOM + vision, visual fallback (canvas-only price, C chosen with
the model citing "Rs 699"), visual PII (4 regions masked locally, only
placeholders on the wire), delayed button, stale target (validator blocked,
one re-observation, no stale click), price swaps A and B, prices restored.
Every network request the browser made was recorded: only the demo server
and the backend were contacted, and no request carried image data, base64
runs or raw values.

**Not measured**: CPU and GPU utilisation are not observable from inside a
page or extension; the OCR worker's own heap is not exposed to the offscreen
document. WebGPU was probed ("adapter available") but not used.

## Firefox

Not runtime-tested in this phase (Firefox is not installed on the development
machine). The vision, privacy, fusion, validator and controller modules have
no `chrome.*` calls; everything browser-specific is in
`extension/src/host/chrome.ts`. Firefox has `browser.tabs.captureVisibleTab`
but no offscreen-document API, so the port would host the OCR engine in a
background page instead. The manifest's `offscreen` permission and
`wasm-unsafe-eval` CSP would need the Firefox equivalents.

## Error handling

| Situation | Backend response | Popup shows |
| --- | --- | --- |
| No API key | 503 | "GEMINI_API_KEY is not configured ..." |
| Provider unreachable or HTTP error | 502 | "Reasoning provider error: ..." |
| Model output not valid JSON, wrong shape, missing target, unknown element ID | 502 | "Invalid action from reasoning provider: ..." |

| Firewall or network gate blocks | no request made | "Privacy Firewall blocked request: EMAIL leakage detected" |
| Validator blocks | n/a | "Action blocked by local validator: Target element not found on the current page" |

The extension never executes anything but a `ValidatedAction`, and the executor
still implements only `click` and `done`.
