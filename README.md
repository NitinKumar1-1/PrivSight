# PrivSight

Privacy-preserving browser agent. Smart India Hackathon 2026, problem statement SIH26171.

## Current scope (Phase 3)

Phase 1 proved the plumbing. Phase 2 added local PII detection and redaction.
Phase 3 turns that into an enforced boundary on both sides of the cloud:

```
CONTENT SCRIPT   DOM -> hybrid PII detection -> redaction -> ReasonRequest
                 -> serialize -> LEAKAGE VERIFIER -> PRIVACY FIREWALL
SERVICE WORKER   approved bytes -> pattern re-check -> fetch
BACKEND          FastAPI -> LLMReasoner (Gemini) -> parser -> ActionResponse
SERVICE WORKER   untrusted response object
CONTENT SCRIPT   ACTION VALIDATOR (live page) -> executor -> click
```

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

Not in this phase: OCR, visual perception, ONNX, multi-step agent loop,
real-world website support.

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

The build runs twice: popup and service worker first, then the content script
on its own (`vite.content.config.ts`) so `dist/content.js` stays a single file
even though it shares the privacy modules with the service worker.

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

Backend (43 tests: validation, reasoner integration, error mapping, parser, prompt, Gemini adapter with mocked HTTP, CORS):

```
cd backend
python -m pytest
```

Extension (120 tests: hybrid detectors with conflict and false-positive cases, redactor, sanitizer,
leakage verifier, firewall including the sabotaged-redactor block, action validator, pipeline
integration with a fetch stub, executor):

```
cd extension
npm test
```

Neither suite needs the servers, Chrome or a Gemini key.

End-to-end price-swap test (needs the backend running with a real key). It
loads the actual `demo-site/index.html` into jsdom, runs the real extraction,
firewall and network gate, calls the live backend, validates the response and
runs the page's own click handler, for three price configurations:

```
cd extension
npm run test:e2e
```

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
