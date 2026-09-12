"""Phase 7: quota exhaustion is recognised, not retried per model, and reported clearly."""

import json

import httpx
from fastapi.testclient import TestClient

from app.llm.base import LLMRequestError
from app.llm.gemini import GeminiReasoner
from app.main import app
from app.routes.reason import get_reasoner

client = TestClient(app)

QUOTA_BODY = json.dumps({"error": {"code": 429, "message": "You exceeded your current quota, please check your plan and billing details.", "status": "RESOURCE_EXHAUSTED"}})
REQUEST = {"task": "x", "page": {"url": "u", "title": "t", "elements": [{"id": "el_go", "tag": "button", "text": "Go", "role": "button"}], "text": "Go"}, "placeholders": []}


def test_quota_429_moves_to_the_next_model_without_retrying():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(429, text=QUOTA_BODY)

    reasoner = GeminiReasoner(api_key="k", model="m1", timeout_seconds=5.0, client=httpx.Client(transport=httpx.MockTransport(handler)), fallback_models=("m2",), sleep=lambda _s: None)
    try:
        reasoner.reason(__import__("app.schemas", fromlist=["ReasonRequest"]).ReasonRequest.model_validate(REQUEST))
    except LLMRequestError as exc:
        assert "429" in str(exc)
    else:
        raise AssertionError("expected LLMRequestError")
    assert len(calls) == 2  # one call per model, no per-model retries
    assert "m1:" in calls[0] and "m2:" in calls[1]


def test_rate_limit_429_without_quota_marker_is_still_retried():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if len(calls) < 2:
            return httpx.Response(429, text='{"error":{"message":"Resource has been exhausted (e.g. check quota)."}}')
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps({"action": "done", "confidence": 1, "reason": "ok", "final": True})}]}}]})

    reasoner = GeminiReasoner(api_key="k", model="m1", timeout_seconds=5.0, client=httpx.Client(transport=httpx.MockTransport(handler)), sleep=lambda _s: None)
    action = reasoner.reason(__import__("app.schemas", fromlist=["ReasonRequest"]).ReasonRequest.model_validate(REQUEST))
    assert action.action == "done"
    assert len(calls) == 2


def test_route_reports_quota_exhaustion_as_a_clear_503():
    class Exhausted:
        name = "fake"

        def reason(self, request):
            raise LLMRequestError("Gemini unavailable after trying m1. Last failure: m1 attempt 1: HTTP 429: You exceeded your current quota")

    app.dependency_overrides[get_reasoner] = lambda: Exhausted()
    try:
        response = client.post("/reason", json=REQUEST)
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert "quota" in response.json()["detail"]
    assert "backend/.env" in response.json()["detail"]
