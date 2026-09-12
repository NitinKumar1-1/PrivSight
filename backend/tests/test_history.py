"""Phase 7: action history in the request contract and the prompt."""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.llm.prompt import SYSTEM_INSTRUCTION, build_user_prompt
from app.main import app
from app.routes.reason import get_reasoner
from app.schemas import ActionResponse, ReasonRequest

client = TestClient(app)

BASE = {
    "task": "Search for a black shirt and add the cheapest to the cart. Do not purchase anything.",
    "page": {
        "url": "https://shop.example/",
        "title": "Shop",
        "elements": [{"id": "el_q", "tag": "input", "text": "", "role": "textbox"}, {"id": "el_go", "tag": "button", "text": "Go", "role": "button"}],
        "text": "Shop",
    },
    "placeholders": [],
}


def test_history_is_optional_and_defaults_empty():
    request = ReasonRequest.model_validate(BASE)
    assert request.history == []
    assert "PREVIOUS ACTIONS THIS TASK: none (first step)" in build_user_prompt(request)


def test_history_entries_appear_in_the_prompt_in_order():
    request = ReasonRequest.model_validate({**BASE, "history": [
        {"action": "type", "target": "el_q", "value": "black shirt"},
        {"action": "click", "target": "el_go", "value": None},
    ]})
    prompt = build_user_prompt(request)
    section = prompt.split("PREVIOUS ACTIONS THIS TASK")[1].split("PAGE TEXT:")[0]
    assert "- type | el_q | black shirt" in section
    assert "- click | el_go | -" in section
    assert section.index("type | el_q") < section.index("click | el_go")


@pytest.mark.parametrize(
    "history",
    [
        [{"action": "hack", "target": None, "value": None}],
        [{"action": "click", "target": "el_go", "value": None, "extra": 1}],
        [{"action": "type", "target": "el_q", "value": "x" * 201}],
        [{"action": "scroll", "target": None, "value": "down"}] * 21,
    ],
)
def test_malformed_history_is_rejected(history):
    with pytest.raises(ValidationError):
        ReasonRequest.model_validate({**BASE, "history": history})


def test_route_accepts_history():
    class Fake:
        name = "fake"

        def reason(self, request):
            assert len(request.history) == 1
            return ActionResponse(action="click", target="el_go", confidence=0.9, reason="submit")

    app.dependency_overrides[get_reasoner] = lambda: Fake()
    try:
        response = client.post("/reason", json={**BASE, "history": [{"action": "type", "target": "el_q", "value": "black shirt"}]})
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200
    assert response.json()["target"] == "el_go"


def test_system_instruction_covers_multistep_and_safety():
    assert "PREVIOUS ACTIONS" in SYSTEM_INSTRUCTION
    assert "single next action" in SYSTEM_INSTRUCTION
    assert "only when the task itself asks for it" in SYSTEM_INSTRUCTION
    assert "Never type personal or payment" in SYSTEM_INSTRUCTION
    assert '"final"' in SYSTEM_INSTRUCTION
    assert "Browser language" in SYSTEM_INSTRUCTION
    assert "do not give up" in SYSTEM_INSTRUCTION
    assert "Opening a product page is a step, not completion" in SYSTEM_INSTRUCTION
    assert "No substitution" in SYSTEM_INSTRUCTION
