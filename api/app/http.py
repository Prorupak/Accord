"""Trust boundary: request guards, the §8.3 error envelope and the single inference slot."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from .config import get_settings
from .schemas import MAX_BODY_BYTES

log = logging.getLogger("accord.api")


class ApiError(Exception):
    def __init__(
        self,
        code: str,
        status: int,
        message: str,
        *,
        retryable: bool = False,
        request_id: str = "",
        retry_after: int | None = None,
    ):
        super().__init__(message)
        self.code, self.status, self.message = code, status, message
        self.retryable, self.request_id, self.retry_after = retryable, request_id, retry_after


def error_response(err: ApiError) -> JSONResponse:
    body = {
        "code": err.code,
        "message": err.message,
        "retryable": err.retryable,
        "requestId": err.request_id,
    }
    headers = {}
    if err.retry_after is not None:
        body["retryAfterSeconds"] = err.retry_after
        headers["Retry-After"] = str(err.retry_after)
    return JSONResponse({"error": body}, status_code=err.status, headers=headers)


def _invalid(message: str, request_id: str = "") -> ApiError:
    return ApiError("INVALID_INPUT", 400, message, request_id=request_id)


def _guard_origin(request: Request) -> None:
    s = get_settings()
    allowed_hosts = {f"127.0.0.1:{s.api_port}", f"localhost:{s.api_port}"}
    if request.headers.get("host", "") not in allowed_hosts:
        raise _invalid("Unexpected Host header.")
    origin = request.headers.get("origin")
    if origin is not None and origin not in {
        s.frontend_origin,
        *(f"http://{h}" for h in allowed_hosts),
    }:
        raise ApiError("INVALID_INPUT", 403, "Origin not allowed.")


async def read_json[M: BaseModel](request: Request, model: type[M]) -> M:
    _guard_origin(request)
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise ApiError("INVALID_INPUT", 415, "Content-Type must be application/json.")
    too_large = ApiError("PAYLOAD_TOO_LARGE", 413, f"Request body exceeds {MAX_BODY_BYTES} bytes.")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise too_large
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY_BYTES:
            raise too_large
    try:
        return model.model_validate_json(bytes(body))
    except ValidationError as exc:
        # Field locations only; never echo submitted values back.
        where = "; ".join(
            f"{'.'.join(map(str, e['loc'])) or 'body'}: {e['msg']}" for e in exc.errors()[:5]
        )
        raise _invalid(f"Invalid request: {where}", _request_id(bytes(body))) from None


def _request_id(body: bytes) -> str:
    try:
        rid = json.loads(body).get("requestId")
        return rid if isinstance(rid, str) and len(rid) <= 128 else ""
    except (ValueError, AttributeError):
        return ""


_slot = asyncio.Lock()


@asynccontextmanager
async def inference_slot(request: Request, request_id: str):
    if _slot.locked():
        raise ApiError(
            "BUSY",
            409,
            "Another analysis request is running.",
            retryable=True,
            request_id=request_id,
        )
    async with _slot:
        # A client that hangs up (Cancel in the UI) must free the slot now, not after the deadline.
        task = asyncio.current_task()
        disconnected = False

        async def watch() -> None:
            nonlocal disconnected
            while (await request.receive())["type"] != "http.disconnect":
                pass
            disconnected = True
            task.cancel()

        watcher = asyncio.create_task(watch())
        try:
            yield
        except asyncio.CancelledError:
            if not disconnected:
                raise
            task.uncancel()
            log.info("client disconnected request=%s", request_id)
            raise ApiError(
                "CANCELLED", 499, "Client cancelled the request.", request_id=request_id
            ) from None
        finally:
            watcher.cancel()
