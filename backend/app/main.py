"""PrivSight backend entry point."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.reason import router as reason_router

# Chrome extension origins look like chrome-extension://<32 lowercase letters>.
# The regex allows any locally loaded extension during development.
# To tighten later, replace with allow_origins=["chrome-extension://<fixed-id>"].
EXTENSION_ORIGIN_REGEX = r"^chrome-extension://[a-p]{32}$"

app = FastAPI(title="PrivSight Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=EXTENSION_ORIGIN_REGEX,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)

app.include_router(reason_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
