"""Reasoning layer tests: parser, prompt, factory and the Gemini adapter (mocked HTTP)."""

import json

import httpx
import pytest

from app.config import Settings
from app.llm import LLMConfigError, LLMRequestError, LLMResponseError, create_reasoner
from app.llm.gemini import GeminiReasoner
from app.llm.parser import parse_action
from app.llm.prompt import SYSTEM_INSTRUCTION, build_user_prompt
from app.llm.stub import StubReasoner
from app.schemas import ReasonRequest

REQUEST = ReasonRequest.model_validate(
    {
        "task": "Find the cheapest black shirt and click Buy Now",
        "page": {
            "url": "http://localhost:8080/index.html",
            "title": "ShirtStore - Black Shirts",
            "elements": [
                {"id": "el_email", "tag": "input", "text": "[EMAIL_1]", "role": "textbox"},
                {"id": "el_buy_now", "tag": "button", "text": "Buy Now", "role": "button"},
            ],
            "text": "Email [EMAIL_1] Phone [PHONE_1] Black Shirt C Price: 699",
        },
        "placeholders": ["[EMAIL_1]", "[PHONE_1]"],
    }
)
TARGETS = ["el_email", "el_buy_now"]
GOOD_JSON = '{"action": "click", "target": "el_buy_now", "confidence": 0.9, "reason": "Buy Now"}'


# --- parser -----------------------------------------------------------------


def test_parse_valid_json():
    action = parse_action(GOOD_JSON, TARGETS)
    assert action.action == "click"
    assert action.target == "el_buy_now"
    assert action.value is None


def test_parse_strips_code_fences():
    action = parse_action(f"```json\n{GOOD_JSON}\n```", TARGETS)
    assert action.target == "el_buy_now"


@pytest.mark.parametrize(
    "raw, fragment",
    [
        ("click the buy button", "not valid JSON"),
        ("[1, 2]", "not an object"),
        ('{"action": "explode", "confidence": 1, "reason": "x"}', "contract"),
        ('{"action": "click", "confidence": 1, "reason": "x"}', "requires a target"),
        ('{"action": "click", "target": "el_nope", "confidence": 1, "reason": "x"}', "not one of the supplied"),
        ('{"action": "type", "target": "el_email", "confidence": 1, "reason": "x"}', "requires a value"),
        ('{"action": "click", "target": "el_buy_now", "confidence": 7, "reason": "x"}', "contract"),
    ],
)
def test_parse_rejects_malformed_output(raw, fragment):
    with pytest.raises(LLMResponseError) as exc:
        parse_action(raw, TARGETS)
    assert fragment in str(exc.value)


def test_parse_done_needs_no_target():
    action = parse_action('{"action": "done", "confidence": 1, "reason": "finished"}', TARGETS)
    assert action.action == "done"


def test_parse_type_with_placeholder_value():
    raw = '{"action": "type", "target": "el_email", "value": "[EMAIL_1]", "confidence": 0.8, "reason": "fill"}'
    assert parse_action(raw, TARGETS).value == "[EMAIL_1]"


# --- prompt -----------------------------------------------------------------


def test_prompt_contains_only_sanitized_request_fields():
    prompt = build_user_prompt(REQUEST)
    assert REQUEST.task in prompt
    assert "el_buy_now | button | button | Buy Now" in prompt
    assert "[EMAIL_1], [PHONE_1]" in prompt
    assert "Black Shirt C Price: 699" in prompt
    assert "[EMAIL_1]" in prompt


def test_prompt_includes_visual_observations_and_conflicts_when_present():
    request = ReasonRequest.model_validate(
        {
            **REQUEST.model_dump(),
            "visual": {
                "engine": "tesseract.js 7 LSTM (wasm)",
                "observations": [
                    {"type": "text", "text": "Black Shirt C", "bbox": {"x": 1, "y": 2, "width": 30, "height": 10}, "confidence": 0.93, "target": None},
                    {"type": "price", "text": "Price: Rs 699", "bbox": {"x": 1, "y": 20, "width": 30, "height": 10}, "confidence": 0.9, "target": None},
                    {"type": "button", "text": "Buy Now C", "bbox": {"x": 1, "y": 40, "width": 30, "height": 10}, "confidence": 0.88, "target": "el_buy_c"},
                ],
                "conflicts": ["Black Shirt A: page text says 799, vision read 7799"],
            },
        }
    )
    prompt = build_user_prompt(request)
    assert "VISUAL OBSERVATIONS (local OCR engine: tesseract.js 7 LSTM (wasm)" in prompt
    assert "- price | Price: Rs 699 | - | 0.90" in prompt
    assert "- button | Buy Now C | el_buy_c | 0.88" in prompt
    assert "CONFLICT: Black Shirt A: page text says 799, vision read 7799" in prompt
    assert "trust the page text" in SYSTEM_INSTRUCTION


def test_prompt_has_no_visual_section_without_visual_context():
    assert "VISUAL OBSERVATIONS" not in build_user_prompt(REQUEST)


def test_system_instruction_explains_placeholders_and_json_only():
    assert "[EMAIL_1]" in SYSTEM_INSTRUCTION
    assert "exactly one JSON object" in SYSTEM_INSTRUCTION
    assert "no executable code" in SYSTEM_INSTRUCTION
    assert "Never attempt to recover" in SYSTEM_INSTRUCTION
    assert "only when it appears in the REDACTED PLACEHOLDERS list" in SYSTEM_INSTRUCTION
    assert "validated locally" in SYSTEM_INSTRUCTION


# --- factory ----------------------------------------------------------------


def settings(**overrides) -> Settings:
    base = {
        "llm_provider": "gemini",
        "gemini_api_key": "test-key",
        "gemini_model": "m",
        "gemini_fallback_models": ("m2",),
        "llm_timeout_seconds": 5.0,
        "llm_debug": False,
        "gemini_thinking_budget": None,
    }
    return Settings(**{**base, **overrides})


def test_factory_builds_gemini_when_key_present():
    reasoner = create_reasoner(settings())
    assert isinstance(reasoner, GeminiReasoner)
    assert reasoner.name == "gemini"
    assert reasoner.models == ["m", "m2"]


def test_factory_refuses_gemini_without_key():
    with pytest.raises(LLMConfigError) as exc:
        create_reasoner(settings(gemini_api_key=None))
    assert "GEMINI_API_KEY" in str(exc.value)


def test_factory_builds_stub_only_when_asked():
    assert isinstance(create_reasoner(settings(llm_provider="stub")), StubReasoner)


def test_factory_rejects_unknown_provider():
    with pytest.raises(LLMConfigError):
        create_reasoner(settings(llm_provider="mystery"))


def test_stub_returns_phase1_action():
    action = StubReasoner().reason(REQUEST)
    assert (action.action, action.target) == ("click", "el_buy_now")


# --- gemini adapter (mocked transport) --------------------------------------


def gemini_reply(text: str, status: int = 200) -> httpx.Response:
    body = {"candidates": [{"content": {"parts": [{"text": text}]}}]}
    return httpx.Response(status, json=body)


def make_reasoner(handler, fallback_models=()) -> GeminiReasoner:
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return GeminiReasoner(
        api_key="secret-key",
        model="test-model",
        timeout_seconds=5.0,
        client=client,
        fallback_models=fallback_models,
        sleep=lambda _seconds: None,  # no real waiting in tests
    )


def test_gemini_sends_key_in_header_and_sanitized_prompt_in_body():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = json.loads(request.content)
        return gemini_reply(GOOD_JSON)

    action = make_reasoner(handler).reason(REQUEST)

    assert action.target == "el_buy_now"
    assert seen["url"].endswith("/models/test-model:generateContent")
    assert "secret-key" not in seen["url"]
    assert seen["headers"]["x-goog-api-key"] == "secret-key"

    body = seen["body"]
    assert body["system_instruction"]["parts"][0]["text"] == SYSTEM_INSTRUCTION
    assert body["generationConfig"]["responseMimeType"] == "application/json"
    user_text = body["contents"][0]["parts"][0]["text"]
    assert user_text == build_user_prompt(REQUEST)
    assert "[EMAIL_1]" in user_text


def test_gemini_thinking_budget_is_sent_only_when_configured():
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return gemini_reply(GOOD_JSON)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    GeminiReasoner(api_key="k", model="m", timeout_seconds=5.0, client=client).reason(REQUEST)
    assert "thinkingConfig" not in seen[-1]["generationConfig"]
    GeminiReasoner(api_key="k", model="m", timeout_seconds=5.0, client=client, thinking_budget=0).reason(REQUEST)
    assert seen[-1]["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}


def test_gemini_debug_prints_sanitized_prompt_and_reply_but_never_the_key(capsys):
    client = httpx.Client(transport=httpx.MockTransport(lambda _r: gemini_reply(GOOD_JSON)))
    reasoner = GeminiReasoner(
        api_key="secret-key", model="m", timeout_seconds=5.0, client=client, debug=True
    )
    reasoner.reason(REQUEST)
    out = capsys.readouterr().out
    assert "PROMPT SENT TO GEMINI" in out
    assert "[EMAIL_1]" in out
    assert "RAW REPLY FROM GEMINI" in out
    assert "el_buy_now" in out
    assert "secret-key" not in out


def test_gemini_non_retryable_http_error_fails_fast_without_key():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(400, json={"error": {"message": "bad request"}})

    with pytest.raises(LLMRequestError) as exc:
        make_reasoner(handler, fallback_models=("other",)).reason(REQUEST)
    assert len(calls) == 1
    assert "400" in str(exc.value)
    assert "secret-key" not in str(exc.value)


def test_gemini_retries_high_demand_503_then_succeeds():
    calls = []

    def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(503, json={"error": {"message": "high demand"}})
        return gemini_reply(GOOD_JSON)

    assert make_reasoner(handler).reason(REQUEST).target == "el_buy_now"
    assert len(calls) == 3


def test_gemini_falls_back_to_next_model_when_primary_is_retired():
    seen_models = []

    def handler(request: httpx.Request) -> httpx.Response:
        model = request.url.path.split("/models/")[1].split(":")[0]
        seen_models.append(model)
        if model == "test-model":
            return httpx.Response(404, json={"error": {"message": "no longer available"}})
        return gemini_reply(GOOD_JSON)

    action = make_reasoner(handler, fallback_models=("backup-model",)).reason(REQUEST)
    assert action.target == "el_buy_now"
    assert seen_models == ["test-model", "backup-model"]  # 404 skips retries for that model


def test_gemini_exhausts_all_models_then_reports_last_failure():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(503, json={"error": {"message": "high demand"}})

    with pytest.raises(LLMRequestError) as exc:
        make_reasoner(handler, fallback_models=("backup-model",)).reason(REQUEST)
    assert len(calls) == 6  # 3 attempts x 2 models
    assert "backup-model" in str(exc.value)
    assert "high demand" in str(exc.value)
    assert "secret-key" not in str(exc.value)


def test_gemini_network_failure_retries_then_reports_cause():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raise httpx.ConnectError("[Errno 11001] getaddrinfo failed")

    with pytest.raises(LLMRequestError) as exc:
        make_reasoner(handler).reason(REQUEST)
    assert len(calls) == 3
    assert "getaddrinfo failed" in str(exc.value)
    assert "secret-key" not in str(exc.value)


def test_gemini_recovers_when_the_retry_succeeds():
    calls = []

    def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("blip")
        return gemini_reply(GOOD_JSON)

    assert make_reasoner(handler).reason(REQUEST).target == "el_buy_now"
    assert len(calls) == 2


def test_gemini_blocked_or_empty_answer_becomes_response_error():
    def blocked(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}})

    with pytest.raises(LLMResponseError) as exc:
        make_reasoner(blocked).reason(REQUEST)
    assert "SAFETY" in str(exc.value)

    def empty(_request: httpx.Request) -> httpx.Response:
        return gemini_reply("   ")

    with pytest.raises(LLMResponseError):
        make_reasoner(empty).reason(REQUEST)


def test_gemini_malformed_action_becomes_response_error():
    def handler(_request: httpx.Request) -> httpx.Response:
        return gemini_reply('{"action": "click", "confidence": 1, "reason": "no target"}')

    with pytest.raises(LLMResponseError):
        make_reasoner(handler).reason(REQUEST)
