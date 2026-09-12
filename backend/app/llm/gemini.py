"""Gemini adapter for LLMReasoner, using the REST API through httpx.

No vendor SDK: one POST to generateContent with a JSON response schema.
The API key is sent as a header, never in the URL, so it cannot appear in
access logs or exception messages.

Resilience (needed for a live demo on a free tier):
  * transient failures (network blip, HTTP 429/5xx "high demand") are retried
    a few times with a short pause;
  * if a model is unavailable (HTTP 404, e.g. retired) or keeps failing, the
    next model in the fallback chain is tried.
"""

import time
from collections.abc import Callable, Sequence

import httpx

from app.llm.base import LLMRequestError, LLMResponseError
from app.safe_print import safe_print
from app.llm.parser import parse_action
from app.llm.prompt import RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, build_user_prompt
from app.schemas import ActionResponse, ReasonRequest

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
MAX_ERROR_EXCERPT = 300
ATTEMPTS_PER_MODEL = 3
RETRY_DELAY_SECONDS = 1.5
RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
# A 429 whose body says the quota itself is used up (daily/plan quota, not a per-minute burst)
# will not clear in seconds: skip straight to the next model instead of pausing and retrying.
QUOTA_EXHAUSTED_MARKER = "exceeded your current quota"
SKIP_MODEL_STATUSES = {404}


class GeminiReasoner:
    name = "gemini"

    def __init__(
        self,
        api_key: str,
        model: str,
        timeout_seconds: float,
        client: httpx.Client | None = None,
        fallback_models: Sequence[str] = (),
        sleep: Callable[[float], None] = time.sleep,
        debug: bool = False,
        thinking_budget: int | None = None,
    ) -> None:
        self._debug = debug
        self._thinking_budget = thinking_budget
        self._api_key = api_key
        self._models = [model, *[m for m in fallback_models if m and m != model]]
        self._timeout = timeout_seconds
        self._client = client or httpx.Client()
        self._sleep = sleep

    @property
    def model(self) -> str:
        return self._models[0]

    @property
    def models(self) -> list[str]:
        return list(self._models)

    def reason(self, request: ReasonRequest) -> ActionResponse:
        payload = self._build_payload(request)
        if self._debug:
            self._dump("PROMPT SENT TO GEMINI (sanitized context only)", payload["contents"][0]["parts"][0]["text"])
        response = self._post(payload)
        text = self._extract_text(response)
        if self._debug:
            self._dump("RAW REPLY FROM GEMINI", text)
        allowed = [el.id for el in request.page.elements]
        try:
            return parse_action(text, allowed)
        except LLMResponseError as first:
            # One correction round: tell the model what was wrong with its own reply and ask again.
            # The page context is unchanged and still sanitized; nothing new is revealed.
            correction = (
                f"Your previous reply was rejected: {first}. Reply again with exactly one JSON action. "
                "Use only an element ID that appears in the INTERACTIVE ELEMENTS list, copied exactly, or return \"done\"."
            )
            payload["contents"].append({"role": "model", "parts": [{"text": text}]})
            payload["contents"].append({"role": "user", "parts": [{"text": correction}]})
            print(f"[llm] correction round: {first}")
            retry_text = self._extract_text(self._post(payload))
            if self._debug:
                self._dump("RAW REPLY FROM GEMINI (correction round)", retry_text)
            return parse_action(retry_text, allowed)

    @staticmethod
    def _dump(title: str, body: str) -> None:
        rule = "-" * 70
        for line in (f"[llm-debug] {title}", rule, body, rule):
            safe_print(line)

    def _build_payload(self, request: ReasonRequest) -> dict:
        generation_config: dict = {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        }
        if self._thinking_budget is not None:
            generation_config["thinkingConfig"] = {"thinkingBudget": self._thinking_budget}
        return {
            "system_instruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
            "contents": [{"role": "user", "parts": [{"text": build_user_prompt(request)}]}],
            "generationConfig": generation_config,
        }

    def _post(self, payload: dict) -> dict:
        headers = {"x-goog-api-key": self._api_key, "Content-Type": "application/json"}
        failures: list[str] = []

        for model in self._models:
            url = f"{GEMINI_API_BASE}/models/{model}:generateContent"
            for attempt in range(1, ATTEMPTS_PER_MODEL + 1):
                try:
                    response = self._client.post(url, json=payload, headers=headers, timeout=self._timeout)
                except httpx.TransportError as exc:
                    # Transport errors describe the socket, DNS or TLS failure. They
                    # never contain request headers, so the key cannot appear here.
                    failures.append(f"{model} attempt {attempt}: {type(exc).__name__}: {exc}")
                    self._pause(attempt)
                    continue
                except httpx.HTTPError as exc:
                    raise LLMRequestError(f"Gemini request failed: {type(exc).__name__}: {exc}") from exc

                if response.status_code == 200:
                    print(f"[llm] gemini model={model} attempt={attempt}")
                    return self._decode(response)

                excerpt = response.text[:MAX_ERROR_EXCERPT]
                failures.append(f"{model} attempt {attempt}: HTTP {response.status_code}: {excerpt}")
                if response.status_code in SKIP_MODEL_STATUSES:
                    break  # this model is gone; move to the next one
                if response.status_code == 429 and QUOTA_EXHAUSTED_MARKER in response.text:
                    break  # quota used up on this model; try the next one without waiting
                if response.status_code in RETRYABLE_STATUSES:
                    self._pause(attempt)
                    continue
                raise LLMRequestError(f"Gemini ({model}) returned HTTP {response.status_code}: {excerpt}")

        raise LLMRequestError(
            f"Gemini unavailable after trying {', '.join(self._models)}. Last failure: {failures[-1]}"
        )

    def _pause(self, attempt: int) -> None:
        if attempt < ATTEMPTS_PER_MODEL:
            self._sleep(RETRY_DELAY_SECONDS)

    @staticmethod
    def _decode(response: httpx.Response) -> dict:
        try:
            return response.json()
        except ValueError as exc:
            raise LLMResponseError("Gemini response body is not JSON") from exc

    @staticmethod
    def _extract_text(body: dict) -> str:
        candidates = body.get("candidates") or []
        if not candidates:
            reason = (body.get("promptFeedback") or {}).get("blockReason", "no candidates returned")
            raise LLMResponseError(f"Gemini returned no answer: {reason}")

        parts = ((candidates[0].get("content") or {}).get("parts")) or []
        text = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
        if not text.strip():
            raise LLMResponseError("Gemini returned an empty answer")
        return text
