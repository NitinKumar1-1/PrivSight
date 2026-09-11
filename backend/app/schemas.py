"""Request and response models shared with the extension.

These models mirror extension/src/shared/contract.ts field for field.
If one side changes, the other must change with it.

Request models forbid unknown fields: nothing the extension did not declare
(a screenshot, raw OCR, a debug blob) can ride along into the prompt.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ActionType = Literal["click", "type", "scroll", "select", "navigate", "done"]
VisualObservationType = Literal["text", "price", "button", "input"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PageElement(_Strict):
    id: str = Field(..., description="PrivSight element identifier (data-ps-id)")
    tag: str
    text: str = ""
    role: str = ""


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


class ActionResponse(BaseModel):
    action: ActionType
    target: str | None = None
    value: str | None = None
    confidence: float = Field(..., ge=0.0, le=1.0)
    reason: str
