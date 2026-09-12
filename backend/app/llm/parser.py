"""Defensive parsing of model output into an ActionResponse.

This is deliberately minimal (Phase 2): valid JSON, contract shape, a target
where the action needs one, and a target that exists on the page. The full
Action Validator (confidence, domain and sensitive-field policy) is Phase 3.
"""

import json
import re
from collections.abc import Iterable

from pydantic import ValidationError

from app.llm.base import LLMResponseError
from app.schemas import ActionResponse

ACTIONS_REQUIRING_TARGET = {"click", "type", "press", "select"}
ACTIONS_REQUIRING_VALUE = {"type", "press", "select", "navigate"}

_CODE_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


def parse_action(raw_text: str, allowed_targets: Iterable[str]) -> ActionResponse:
    data = _load_json(raw_text)

    try:
        action = ActionResponse.model_validate(data)
    except ValidationError as exc:
        raise LLMResponseError(f"action does not match the contract: {_first_error(exc)}") from exc

    if action.action in ACTIONS_REQUIRING_TARGET and not action.target:
        raise LLMResponseError(f'action "{action.action}" requires a target')
    if action.action in ACTIONS_REQUIRING_VALUE and action.value is None:
        raise LLMResponseError(f'action "{action.action}" requires a value')

    known = set(allowed_targets)
    if action.target is not None and action.target not in known:
        raise LLMResponseError(f'target "{action.target}" is not one of the supplied element IDs')

    return action


def _load_json(raw_text: str) -> dict:
    text = raw_text.strip()
    fenced = _CODE_FENCE.match(text)
    if fenced:
        text = fenced.group(1)

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise LLMResponseError("response is not valid JSON") from exc

    if not isinstance(data, dict):
        raise LLMResponseError("response JSON is not an object")
    return data


def _first_error(exc: ValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "unknown validation error"
    first = errors[0]
    location = ".".join(str(part) for part in first.get("loc", ())) or "body"
    return f"{location}: {first.get('msg', 'invalid')}"
