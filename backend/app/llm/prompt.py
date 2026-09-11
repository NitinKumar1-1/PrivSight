"""Prompt construction for the reasoning model.

Only fields of the already-sanitized ReasonRequest are placed in the prompt.
Nothing else about the page is available to this module.
"""

from app.schemas import ReasonRequest

ALLOWED_ACTIONS = ["click", "type", "scroll", "select", "navigate", "done"]

SYSTEM_INSTRUCTION = """You are a browser task reasoning engine.
You control a web browser only by returning one structured action as JSON.

Rules:
1. Use only the supplied webpage context. Do not assume access to any other information.
2. Refer to elements only by the element IDs listed in the context. Never invent selectors.
3. Tokens like [EMAIL_1], [PHONE_1], [CARD_1], [PASSWORD_1] or [OTP_1] are placeholders for sensitive
   values that were redacted before you received this context. Treat each as an existing value of
   that type. Do not try to guess, reconstruct or ask for the real value. If an action needs such a
   value, put the placeholder itself in the "value" field.
4. Return exactly one JSON object and nothing else: no prose, no code fences, no executable code.
5. The JSON object has these fields:
   - "action": one of "click", "type", "scroll", "select", "navigate", "done"
   - "target": an element ID from the context (required for click, type, select; otherwise null)
   - "value": text for type/select, a URL for navigate, "up"/"down" for scroll, otherwise null
   - "confidence": a number between 0 and 1
   - "reason": one short sentence explaining the choice
6. If the task is already complete or cannot be done with the listed elements, return action "done".
7. Use a placeholder only when it appears in the REDACTED PLACEHOLDERS list of the context.
8. Never attempt to recover, infer or request the value behind a placeholder.
9. Never include scripts, URLs with javascript: or data: schemes, CSS selectors or code of any kind.
   Your output is validated locally before anything runs; an action that breaks these rules is discarded.
"""

# OpenAPI-style schema accepted by Gemini's responseSchema. Keeps the model's
# output inside the ActionResponse contract before parsing even starts.
RESPONSE_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ALLOWED_ACTIONS},
        "target": {"type": "string", "nullable": True},
        "value": {"type": "string", "nullable": True},
        "confidence": {"type": "number"},
        "reason": {"type": "string"},
    },
    "required": ["action", "confidence", "reason"],
}


def build_user_prompt(request: ReasonRequest) -> str:
    page = request.page
    lines = [
        f"TASK: {request.task}",
        "",
        f"PAGE URL: {page.url}",
        f"PAGE TITLE: {page.title}",
        "",
        "INTERACTIVE ELEMENTS (id | tag | role | visible text):",
    ]
    if page.elements:
        lines.extend(f"- {el.id} | {el.tag} | {el.role or '-'} | {el.text or '-'}" for el in page.elements)
    else:
        lines.append("- (none)")

    lines.append("")
    if request.placeholders:
        lines.append("REDACTED PLACEHOLDERS PRESENT: " + ", ".join(request.placeholders))
    else:
        lines.append("REDACTED PLACEHOLDERS PRESENT: none")

    lines.extend(["", "PAGE TEXT:", page.text or "(empty)", "", "Return the single JSON action now."])
    return "\n".join(lines)
