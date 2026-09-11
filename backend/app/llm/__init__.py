"""Reasoner factory. The only place that knows which provider is configured."""

from app.config import Settings
from app.llm.base import LLMConfigError, LLMError, LLMReasoner, LLMRequestError, LLMResponseError
from app.llm.gemini import GeminiReasoner
from app.llm.stub import StubReasoner

__all__ = [
    "LLMConfigError",
    "LLMError",
    "LLMReasoner",
    "LLMRequestError",
    "LLMResponseError",
    "create_reasoner",
]


def create_reasoner(settings: Settings) -> LLMReasoner:
    if settings.llm_provider == "gemini":
        if not settings.gemini_api_key:
            raise LLMConfigError(
                "GEMINI_API_KEY is not configured. Copy backend/.env.example to backend/.env, "
                "set the key, and start uvicorn with --env-file .env"
            )
        return GeminiReasoner(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            timeout_seconds=settings.llm_timeout_seconds,
            fallback_models=settings.gemini_fallback_models,
            debug=settings.llm_debug,
        )

    if settings.llm_provider == "stub":
        return StubReasoner()

    raise LLMConfigError(f'Unknown LLM_PROVIDER "{settings.llm_provider}" (expected "gemini" or "stub")')
