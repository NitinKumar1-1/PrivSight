"""Backend settings read from environment variables.

Load them with `uvicorn ... --env-file .env` (python-dotenv ships with
uvicorn[standard]) or export them in the shell. See .env.example.
"""

import os
from dataclasses import dataclass

DEFAULT_PROVIDER = "gemini"
DEFAULT_GEMINI_MODEL = "gemini-3.6-flash"
# Tried in order when the primary model is retired (404) or keeps answering
# "high demand" (503). Override with GEMINI_FALLBACK_MODELS=a,b,c.
DEFAULT_GEMINI_FALLBACK_MODELS = ("gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-flash-latest")
DEFAULT_TIMEOUT_SECONDS = 30.0

# Values that mean "no key was supplied" so a copied .env.example never
# reaches the network.
KEY_PLACEHOLDERS = {"", "API_KEY_HERE", "YOUR_API_KEY", "CHANGE_ME"}


@dataclass(frozen=True)
class Settings:
    llm_provider: str
    gemini_api_key: str | None
    gemini_model: str
    gemini_fallback_models: tuple[str, ...]
    llm_timeout_seconds: float
    # Print the exact (sanitized) prompt sent to the provider and its raw reply.
    llm_debug: bool
    # Optional Gemini thinking budget (tokens). None = provider default. 0 asks the
    # model to skip its reasoning phase, which can cut latency; measured in Phase 5.
    gemini_thinking_budget: int | None


def load_settings() -> Settings:
    return Settings(
        llm_provider=os.getenv("LLM_PROVIDER", DEFAULT_PROVIDER).strip().lower(),
        gemini_api_key=_secret(os.getenv("GEMINI_API_KEY")),
        gemini_model=os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL,
        gemini_fallback_models=_model_list(os.getenv("GEMINI_FALLBACK_MODELS")),
        llm_timeout_seconds=float(os.getenv("LLM_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS))),
        llm_debug=_flag(os.getenv("LLM_DEBUG")),
        gemini_thinking_budget=_optional_int(os.getenv("GEMINI_THINKING_BUDGET")),
    )


def _secret(value: str | None) -> str | None:
    cleaned = (value or "").strip()
    return None if cleaned in KEY_PLACEHOLDERS else cleaned


def _optional_int(value: str | None) -> int | None:
    cleaned = (value or "").strip()
    return int(cleaned) if cleaned.lstrip("-").isdigit() else None


def _flag(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _model_list(value: str | None) -> tuple[str, ...]:
    if value is None:
        return DEFAULT_GEMINI_FALLBACK_MODELS
    return tuple(part.strip() for part in value.split(",") if part.strip())
