"""Phase 8: press action, observed effects in the history, and evidence rules in the prompt."""

import pytest
from pydantic import ValidationError

from app.llm.base import LLMResponseError
from app.llm.parser import parse_action
from app.llm.prompt import SYSTEM_INSTRUCTION, build_user_prompt
from app.schemas import ReasonRequest

BASE = {
    "task": "Search for a black shirt",
    "page": {
        "url": "https://shop.example/",
        "title": "Shop",
        "elements": [{"id": "el_q", "tag": "input", "text": "", "role": "textbox"}],
        "text": "Shop",
    },
    "placeholders": [],
}


def test_press_requires_a_target_and_a_key():
    action = parse_action('{"action": "press", "target": "el_q", "value": "Enter", "confidence": 1, "reason": "submit", "final": false}', ["el_q"])
    assert action.action == "press" and action.value == "Enter"
    with pytest.raises(LLMResponseError):
        parse_action('{"action": "press", "value": "Enter", "confidence": 1, "reason": ""}', ["el_q"])
    with pytest.raises(LLMResponseError):
        parse_action('{"action": "press", "target": "el_q", "confidence": 1, "reason": ""}', ["el_q"])


def test_history_effect_and_note_are_accepted_and_shown():
    request = ReasonRequest.model_validate({**BASE, "history": [
        {"action": "type", "target": "el_q", "value": "black shirt", "effect": "no_change", "note": "typed text verified; nothing submitted"},
    ]})
    prompt = build_user_prompt(request)
    assert "- type | el_q | black shirt | no_change | typed text verified; nothing submitted" in prompt


def test_history_without_effect_still_works():
    request = ReasonRequest.model_validate({**BASE, "history": [{"action": "click", "target": "el_q", "value": None}]})
    assert "- click | el_q | - | - | -" in build_user_prompt(request)


@pytest.mark.parametrize("entry", [
    {"action": "type", "target": "el_q", "value": "x", "effect": "exploded"},
    {"action": "type", "target": "el_q", "value": "x", "note": "n" * 201},
])
def test_invalid_effect_or_note_is_rejected(entry):
    with pytest.raises(ValidationError):
        ReasonRequest.model_validate({**BASE, "history": [entry]})


def test_prompt_states_the_evidence_rules():
    assert "Typing is never final" in SYSTEM_INSTRUCTION
    assert "MISSING_REQUIRED_DATA" in SYSTEM_INSTRUCTION
    assert "AMBIGUOUS_TARGET" in SYSTEM_INSTRUCTION
    assert "never a default of your own" in SYSTEM_INSTRUCTION
    assert '"press" with value "Enter"' in SYSTEM_INSTRUCTION
