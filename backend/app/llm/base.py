"""Provider-independent reasoning interface.

The rest of the backend depends only on `LLMReasoner` and the error types
below. Swapping vendors means adding one adapter and one config branch.
"""

from typing import Protocol

from app.schemas import ActionResponse, ReasonRequest


class LLMError(Exception):
    """Base class for reasoning failures. Messages must never contain secrets."""


class LLMConfigError(LLMError):
    """The provider is not usable: missing credential, unknown provider."""


class LLMRequestError(LLMError):
    """The provider could not be reached or returned an HTTP error."""


class LLMResponseError(LLMError):
    """The provider answered, but not with a valid structured action."""


class LLMReasoner(Protocol):
    name: str

    def reason(self, request: ReasonRequest) -> ActionResponse:
        """Turn a sanitized request into exactly one structured browser action."""
        ...
