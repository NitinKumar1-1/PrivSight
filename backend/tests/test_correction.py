"""Phase 7: element context in the prompt, and one self-correction round when the model names an unknown id."""

import json

import httpx
import pytest

from app.llm.base import LLMResponseError
from app.llm.gemini import GeminiReasoner
from app.llm.prompt import SYSTEM_INSTRUCTION, build_user_prompt
from app.schemas import ReasonRequest

REQUEST = ReasonRequest.model_validate(
    {
        "task": "Add the cheapest black shirt to the cart. Do not buy.",
        "page": {
            "url": "https://shop.example/s?k=black+shirt",
            "title": "black shirt",
            "elements": [
                {"id": "el_a_autoid_1_announce", "tag": "button", "text": "Add to cart", "role": "button", "context": "J.VER Dress Shirt | INR 1,813.36"},
                {"id": "el_a_autoid_2_announce", "tag": "button", "text": "Add to cart", "role": "button", "context": "Gildan Crew T-Shirts | ₹952.99"},
            ],
            "text": "Results",
        },
        "placeholders": [],
    }
)


def _reasoner(handler) -> GeminiReasoner:
    return GeminiReasoner(api_key="test-key", model="m1", timeout_seconds=5.0, client=httpx.Client(transport=httpx.MockTransport(handler)), sleep=lambda _s: None)


def _reply(action: dict) -> dict:
    return {"candidates": [{"content": {"parts": [{"text": json.dumps(action)}]}}]}


def test_prompt_shows_context_beside_generic_controls():
    prompt = build_user_prompt(REQUEST)
    assert "- el_a_autoid_2_announce | button | button | Add to cart | Gildan Crew T-Shirts | ₹952.99" in prompt
    assert "nearby context" in prompt
    assert "copied exactly" in SYSTEM_INSTRUCTION


def test_unknown_target_triggers_one_correction_round_and_succeeds():
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        if len(calls) == 1:
            return httpx.Response(200, json=_reply({"action": "click", "target": "el_a_autoid_17_announce", "confidence": 1, "reason": "guess", "final": False}))
        return httpx.Response(200, json=_reply({"action": "click", "target": "el_a_autoid_2_announce", "confidence": 1, "reason": "cheapest", "final": False}))

    reasoner = _reasoner(handler)
    action = reasoner.reason(REQUEST)
    assert action.target == "el_a_autoid_2_announce"
    assert len(calls) == 2
    turns = calls[1]["contents"]
    assert turns[-2]["role"] == "model" and "el_a_autoid_17_announce" in turns[-2]["parts"][0]["text"]
    assert turns[-1]["role"] == "user" and "copied exactly" in turns[-1]["parts"][0]["text"]
    assert "test-key" not in json.dumps(calls)  # the key travels in the header only


def test_second_bad_reply_is_still_an_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_reply({"action": "click", "target": "el_nope", "confidence": 1, "reason": "", "final": False}))

    reasoner = _reasoner(handler)
    with pytest.raises(LLMResponseError):
        reasoner.reason(REQUEST)
