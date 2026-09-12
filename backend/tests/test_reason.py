"""Backend route tests: request validation, reasoner integration, error mapping, CORS.

The route is exercised with a fake reasoner so no network is needed.
"""

import pytest
from fastapi.testclient import TestClient

from app.llm.base import LLMConfigError, LLMRequestError, LLMResponseError
from app.main import app
from app.routes.reason import get_reasoner
from app.schemas import ActionResponse, ReasonRequest

client = TestClient(app)

EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

VALID_REQUEST = {
    "task": "Find the cheapest black shirt and click Buy Now",
    "page": {
        "url": "http://localhost:8080/index.html",
        "title": "ShirtStore - Black Shirts",
        "elements": [
            {"id": "el_products", "tag": "a", "text": "Products", "role": "link"},
            {"id": "el_email", "tag": "input", "text": "[EMAIL_1]", "role": "textbox"},
            {"id": "el_buy_now", "tag": "button", "text": "Buy Now", "role": "button"},
        ],
        "text": "Email [EMAIL_1] Phone [PHONE_1] Black Shirt A Price: 799 Black Shirt C Price: 699",
    },
    "placeholders": ["[EMAIL_1]", "[PHONE_1]"],
}

CLICK_BUY_NOW = ActionResponse(action="click", target="el_buy_now", confidence=0.95, reason="Buy Now matches the task")


class FakeReasoner:
    name = "fake"

    def __init__(self, result=CLICK_BUY_NOW, error: Exception | None = None):
        self.result = result
        self.error = error
        self.requests: list[ReasonRequest] = []

    def reason(self, request: ReasonRequest) -> ActionResponse:
        self.requests.append(request)
        if self.error:
            raise self.error
        return self.result


@pytest.fixture
def reasoner():
    fake = FakeReasoner()
    app.dependency_overrides[get_reasoner] = lambda: fake
    yield fake
    app.dependency_overrides.clear()


def use_reasoner(fake: FakeReasoner) -> None:
    app.dependency_overrides[get_reasoner] = lambda: fake


@pytest.fixture(autouse=True)
def clear_overrides():
    yield
    app.dependency_overrides.clear()


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_reason_returns_the_reasoner_action(reasoner):
    response = client.post("/reason", json=VALID_REQUEST)
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "click"
    assert body["target"] == "el_buy_now"
    assert body["confidence"] == 0.95


def test_reason_response_matches_contract_fields(reasoner):
    body = client.post("/reason", json=VALID_REQUEST).json()
    assert set(body.keys()) == {"action", "target", "value", "confidence", "reason", "final"}
    assert body["final"] is False  # the fake reasoner does not set it; the contract default is "not final"


def test_reasoner_receives_exactly_the_sanitized_request(reasoner):
    client.post("/reason", json=VALID_REQUEST)
    assert len(reasoner.requests) == 1
    received = reasoner.requests[0]
    assert received.model_dump() == ReasonRequest.model_validate(VALID_REQUEST).model_dump()
    assert received.placeholders == ["[EMAIL_1]", "[PHONE_1]"]
    assert "[EMAIL_1]" in received.page.text


def test_placeholders_default_to_empty_for_phase1_requests(reasoner):
    request = {k: v for k, v in VALID_REQUEST.items() if k != "placeholders"}
    response = client.post("/reason", json=request)
    assert response.status_code == 200
    assert reasoner.requests[0].placeholders == []


def test_missing_credentials_return_503():
    def unconfigured():
        from fastapi import HTTPException

        raise HTTPException(status_code=503, detail=str(LLMConfigError("GEMINI_API_KEY is not configured")))

    app.dependency_overrides[get_reasoner] = unconfigured
    response = client.post("/reason", json=VALID_REQUEST)
    assert response.status_code == 503
    assert "GEMINI_API_KEY" in response.json()["detail"]


def test_provider_failure_returns_502():
    use_reasoner(FakeReasoner(error=LLMRequestError("Gemini returned HTTP 429: quota")))
    response = client.post("/reason", json=VALID_REQUEST)
    assert response.status_code == 502
    assert "429" in response.json()["detail"]


def test_malformed_model_output_returns_502_not_500():
    use_reasoner(FakeReasoner(error=LLMResponseError("response is not valid JSON")))
    response = client.post("/reason", json=VALID_REQUEST)
    assert response.status_code == 502
    assert "not valid JSON" in response.json()["detail"]


def test_reason_rejects_unknown_fields_such_as_a_screenshot(reasoner):
    for extra in ({"screenshot": "data:image/png;base64,AAAA"}, {"page": {**VALID_REQUEST["page"], "image": "x"}}):
        response = client.post("/reason", json={**VALID_REQUEST, **extra})
        assert response.status_code == 422, extra
    assert reasoner.requests == []


def test_reason_accepts_sanitized_visual_context_and_rejects_image_fields_inside_it(reasoner):
    visual = {
        "engine": "tesseract.js 7 LSTM (wasm)",
        "observations": [
            {"type": "price", "text": "Price: Rs 699", "bbox": {"x": 1, "y": 2, "width": 3, "height": 4}, "confidence": 0.9, "target": None}
        ],
        "conflicts": [],
    }
    assert client.post("/reason", json={**VALID_REQUEST, "visual": visual}).status_code == 200
    assert reasoner.requests[-1].visual.observations[0].text == "Price: Rs 699"

    bad = {**visual, "observations": [{**visual["observations"][0], "image": "AAAA"}]}
    assert client.post("/reason", json={**VALID_REQUEST, "visual": bad}).status_code == 422
    bad_type = {**visual, "observations": [{**visual["observations"][0], "type": "screenshot"}]}
    assert client.post("/reason", json={**VALID_REQUEST, "visual": bad_type}).status_code == 422


def test_reason_rejects_missing_page(reasoner):
    response = client.post("/reason", json={"task": "x"})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "page"]


def test_reason_rejects_empty_task(reasoner):
    request = {**VALID_REQUEST, "task": ""}
    response = client.post("/reason", json=request)
    assert response.status_code == 422


def test_reason_rejects_element_without_id(reasoner):
    request = {
        **VALID_REQUEST,
        "page": {**VALID_REQUEST["page"], "elements": [{"tag": "button", "text": "Buy Now"}]},
    }
    response = client.post("/reason", json=request)
    assert response.status_code == 422


def test_reason_accepts_page_with_no_elements(reasoner):
    request = {**VALID_REQUEST, "page": {**VALID_REQUEST["page"], "elements": []}}
    response = client.post("/reason", json=request)
    assert response.status_code == 200


def test_cors_allows_extension_origin(reasoner):
    response = client.post("/reason", json=VALID_REQUEST, headers={"Origin": EXTENSION_ORIGIN})
    assert response.headers.get("access-control-allow-origin") == EXTENSION_ORIGIN


def test_cors_preflight_for_extension_origin():
    response = client.options(
        "/reason",
        headers={
            "Origin": EXTENSION_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert "POST" in response.headers.get("access-control-allow-methods", "")


def test_cors_rejects_unknown_web_origin(reasoner):
    response = client.post("/reason", json=VALID_REQUEST, headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in response.headers
