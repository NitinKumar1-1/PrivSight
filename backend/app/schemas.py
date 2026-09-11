"""Request and response models shared with the extension.

These models mirror extension/src/shared/contract.ts field for field.
If one side changes, the other must change with it.
"""

from typing import Literal

from pydantic import BaseModel, Field

ActionType = Literal["click", "type", "scroll", "select", "navigate", "done"]


class PageElement(BaseModel):
    id: str = Field(..., description="PrivSight element identifier (data-ps-id)")
    tag: str
    text: str = ""
    role: str = ""


class PageInfo(BaseModel):
    url: str
    title: str
    elements: list[PageElement]
    text: str = ""


class ReasonRequest(BaseModel):
    task: str = Field(..., min_length=1)
    page: PageInfo = Field(..., description="Sanitized page: sensitive values already replaced by placeholders")
    placeholders: list[str] = Field(
        default_factory=list,
        description="Placeholder names present in the page, e.g. [EMAIL_1]. Never values.",
    )


class ActionResponse(BaseModel):
    action: ActionType
    target: str | None = None
    value: str | None = None
    confidence: float = Field(..., ge=0.0, le=1.0)
    reason: str
