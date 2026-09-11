"""Offline reasoner that returns the Phase 1 hardcoded action.

Selected only by LLM_PROVIDER=stub. Used by tests and as a deliberate
fallback for demos without network access. Never chosen automatically.
"""

from app.schemas import ActionResponse, ReasonRequest

STUB_ACTION = ActionResponse(
    action="click",
    target="el_buy_now",
    confidence=1.0,
    reason="Stub reasoner: Phase 1 hardcoded test action",
)


class StubReasoner:
    name = "stub"

    def reason(self, request: ReasonRequest) -> ActionResponse:  # noqa: ARG002 - contract
        return STUB_ACTION
