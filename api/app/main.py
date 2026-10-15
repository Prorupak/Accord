import logging

from fastapi import FastAPI, Request

from .config import get_settings
from .http import ApiError, error_response, log
from .openrouter import PROVIDER
from .routes import mapping, suggestions
from .schemas import (
    MAX_BODY_BYTES,
    MAX_CANDIDATES,
    MAX_OUTPUT_TOKENS,
    MAX_PROVIDER_ATTEMPTS,
    MAX_SUGGEST_ROWS,
    REQUEST_DEADLINE_SECONDS,
)

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Accord API", version="0.1.0", description="Bounded inference API for Accord.")
app.include_router(mapping.router)
app.include_router(suggestions.router)


@app.exception_handler(ApiError)
async def _api_error(_: Request, exc: ApiError):
    return error_response(exc)


@app.exception_handler(Exception)
async def _unexpected(_: Request, exc: Exception):
    log.error("unhandled error type=%s", type(exc).__name__)
    return error_response(ApiError("UPSTREAM_ERROR", 500, "Unexpected server error."))


@app.get("/health")
def health():
    return {"status": "ok", "service": "accord-api"}


@app.get("/api/capabilities")
def capabilities():
    s = get_settings()
    return {
        "configured": s.is_configured,
        "provider": PROVIDER,
        "model": s.openrouter_model or None,
        "limits": {
            "maxBodyBytes": MAX_BODY_BYTES,
            "maxSuggestRows": MAX_SUGGEST_ROWS,
            "maxCandidatesPerRow": MAX_CANDIDATES,
            "requestDeadlineSeconds": REQUEST_DEADLINE_SECONDS,
            "maxProviderAttempts": MAX_PROVIDER_ATTEMPTS,
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
            "concurrentInferenceRequests": 1,
        },
    }
