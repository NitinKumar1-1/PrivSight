"""POST /reason: receives sanitized page context and returns a browser action.

Phase 2: the request is already sanitized by the extension. It is handed to
the configured LLMReasoner, whose parsed answer is returned unchanged.
Failures map to 503 (not configured) or 502 (provider or parse failure) so
the extension shows a readable message instead of crashing.
"""

from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException

from app.config import load_settings
from app.llm import LLMConfigError, LLMReasoner, LLMRequestError, LLMResponseError, create_reasoner
from app.safe_print import safe_print
from app.schemas import ActionResponse, ReasonRequest

router = APIRouter()


@lru_cache(maxsize=1)
def _configured_reasoner() -> LLMReasoner:
    return create_reasoner(load_settings())


def get_reasoner() -> LLMReasoner:
    try:
        return _configured_reasoner()
    except LLMConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/reason", response_model=ActionResponse)
def reason(request: ReasonRequest, reasoner: LLMReasoner = Depends(get_reasoner)) -> ActionResponse:
    # Log counts and identifiers only. Page text is never printed.
    print(
        f"[reason] task={request.task!r} url={request.page.url} "
        f"elements={len(request.page.elements)} placeholders={len(request.placeholders)}"
    )

    try:
        action = reasoner.reason(request)
    except LLMRequestError as exc:
        safe_print(f"[reason] provider error: {exc}")
        if "exceeded your current quota" in str(exc):
            raise HTTPException(
                status_code=503,
                detail="Cloud reasoner unavailable: the Gemini API key has used up its quota (HTTP 429). Wait for the quota to reset or configure another key in backend/.env, then run the task again.",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Reasoning provider error: {exc}") from exc
    except LLMResponseError as exc:
        safe_print(f"[reason] invalid action: {exc}")
        raise HTTPException(status_code=502, detail=f"Invalid action from reasoning provider: {exc}") from exc

    print(
        f"[reason] provider={reasoner.name} action={action.action} "
        f"target={action.target} confidence={action.confidence:.2f}"
    )
    safe_print(f"[reason] model reasoning: {action.reason}")
    return action

