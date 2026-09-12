"""Request and response models shared with the extension.

These models mirror extension/src/shared/contract.ts field for field.
If one side changes, the other must change with it.

Request models forbid unknown fields: nothing the extension did not declare
(a screenshot, raw OCR, a debug blob) can ride along into the prompt.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ActionType = Literal["click", "type", "press", "scroll", "select", "navigate", "done"]
ActionEffect = Literal["url_changed", "dom_changed", "no_change", "unknown"]
VisualObservationType = Literal["text", "price", "button", "input"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PageElement(_Strict):
    id: str = Field(..., description="PrivSight element identifier (data-ps-id)")
    tag: str
    text: str = ""
    role: str = ""
    context: str = Field(default="", max_length=160, description="Nearby title/price for generic controls; redacted like text")
    options: list[str] = Field(default_factory=list, max_length=30, description="Option labels of a standard select; redacted like text")


class PageInfo(_Strict):
    url: str
    title: str
    elements: list[PageElement]
    text: str = ""


class VisualBBox(_Strict):
    x: float
    y: float
    width: float
    height: float


class VisualObservation(_Strict):
    type: VisualObservationType
    text: str = Field(..., max_length=500)
    bbox: VisualBBox
    confidence: float = Field(..., ge=0.0, le=1.0)
    target: str | None = None


class VisualContext(_Strict):
    engine: str
    observations: list[VisualObservation]
    conflicts: list[str] = Field(default_factory=list)


class ActionRecord(_Strict):
    """One action already executed for this task (multi-step). Values are redacted text."""

    action: ActionType
    target: str | None = None
    value: str | None = Field(default=None, max_length=200)
    effect: ActionEffect | None = Field(default=None, description="What the page did after the action, observed locally")
    note: str | None = Field(default=None, max_length=200, description="Value-free local note about the action's result")


class ReasonRequest(_Strict):
    task: str = Field(..., min_length=1)
    page: PageInfo = Field(..., description="Sanitized page: sensitive values already replaced by placeholders")
    placeholders: list[str] = Field(
        default_factory=list,
        description="Placeholder names present in the page, e.g. [EMAIL_1]. Never values.",
    )
    visual: VisualContext | None = Field(
        default=None,
        description="Sanitized structured observations from the local vision engine. Never image data.",
    )
    history: list[ActionRecord] = Field(
        default_factory=list,
        max_length=20,
        description="Actions already executed for this task, oldest first. Empty on the first step.",
    )
    guidance: str | None = Field(default=None, max_length=400, description="Local controller note for this round: what is missing or failed; value-free")


class ActionResponse(BaseModel):
    action: ActionType
    target: str | None = None
    value: str | None = None
    confidence: float = Field(..., ge=0.0, le=1.0)
    reason: str
    final: bool = Field(default=False, description="True when this single action completes the task")
