"""OpenRouter access through the OpenAI SDK, with the §8.2 attempt/deadline budget."""

import asyncio
import json
import random
from collections.abc import Callable

import openai
from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from .config import get_settings
from .http import ApiError, log
from .schemas import (
    MAX_OUTPUT_TOKENS,
    MAX_PROVIDER_ATTEMPTS,
    REQUEST_DEADLINE_SECONDS,
    InferenceMeta,
    Usage,
)

PROVIDER = "openrouter"
PROMPT_VERSION = 1

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        s = get_settings()
        # SDK retries off: every retry counts against our own three-attempt budget.
        _client = AsyncOpenAI(
            api_key=s.openrouter_api_key.get_secret_value(),
            base_url=s.openrouter_base_url,
            max_retries=0,
        )
    return _client


async def _create(**kwargs):
    """The single provider call; tests replace this."""
    return await _get_client().chat.completions.create(**kwargs)


_TRANSIENT = (openai.APIConnectionError, openai.RateLimitError, openai.InternalServerError)


def _retry_after(exc: Exception) -> float | None:
    response = getattr(exc, "response", None)
    value = response.headers.get("retry-after") if response is not None else None
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


async def infer[M: BaseModel](
    *,
    route: str,
    request_id: str,
    system: str,
    payload: dict,
    output_model: type[M],
    verify: Callable[[M], None],
) -> tuple[M, InferenceMeta]:
    s = get_settings()
    if not s.is_configured:
        raise ApiError(
            "NOT_CONFIGURED",
            503,
            "AI inference is not configured. Set OPENROUTER_API_KEY and OPENROUTER_MODEL "
            "on the API server.",
            request_id=request_id,
        )

    loop = asyncio.get_running_loop()
    start = loop.time()
    deadline = start + REQUEST_DEADLINE_SECONDS
    base_messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    messages = base_messages
    response_format = {
        "type": "json_schema",
        "json_schema": {
            "name": output_model.__name__,
            "strict": True,
            "schema": output_model.model_json_schema(),
        },
    }
    attempts, repaired = 0, False
    tokens_in = tokens_out = None
    model = s.openrouter_model
    outcome = "ok"

    def meta() -> InferenceMeta:
        usage = (
            None
            if tokens_in is None and tokens_out is None
            else Usage(inputTokens=tokens_in, outputTokens=tokens_out)
        )
        return InferenceMeta(
            provider=PROVIDER,
            model=model,
            promptVersion=PROMPT_VERSION,
            durationMs=round((loop.time() - start) * 1000),
            attempts=attempts,
            usage=usage,
        )

    def fail(code: str, status: int, message: str, **kw) -> ApiError:
        nonlocal outcome
        outcome = code
        return ApiError(code, status, message, request_id=request_id, **kw)

    try:
        async with asyncio.timeout_at(deadline):
            while True:
                attempts += 1
                try:
                    completion = await _create(
                        model=s.openrouter_model,
                        messages=messages,
                        max_tokens=MAX_OUTPUT_TOKENS,
                        temperature=0,
                        response_format=response_format,
                        # Refuse providers that would silently ignore the JSON schema.
                        extra_body={"provider": {"require_parameters": True}},
                        timeout=max(1.0, deadline - loop.time()),
                    )
                except _TRANSIENT as exc:
                    remaining = deadline - loop.time()
                    wait = _retry_after(exc)
                    if wait is None:
                        wait = 0.5 * 2 ** (attempts - 1) + random.uniform(0, 0.25)
                    if attempts >= MAX_PROVIDER_ATTEMPTS or wait >= remaining:
                        raise
                    await asyncio.sleep(wait)
                    continue

                model = completion.model or model
                if completion.usage is not None:
                    tokens_in = (tokens_in or 0) + (completion.usage.prompt_tokens or 0)
                    tokens_out = (tokens_out or 0) + (completion.usage.completion_tokens or 0)
                content = completion.choices[0].message.content if completion.choices else None

                try:
                    parsed = output_model.model_validate_json(content or "")
                except ValidationError as exc:
                    if repaired or attempts >= MAX_PROVIDER_ATTEMPTS:
                        raise fail(
                            "MODEL_INVALID_OUTPUT",
                            502,
                            "Model returned output that does not match the schema.",
                        ) from None
                    repaired = True
                    errors = "; ".join(
                        f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()[:10]
                    )
                    messages = [
                        *base_messages,
                        {"role": "assistant", "content": content or ""},
                        {
                            "role": "user",
                            "content": f"That output failed schema validation ({errors}). "
                            "Return only corrected JSON for the same input.",
                        },
                    ]
                    continue

                try:
                    verify(parsed)
                except ValueError as exc:
                    # Wrong references are not repaired (spec §7.4).
                    raise fail(
                        "MODEL_INVALID_OUTPUT", 502, f"Model output failed verification: {exc}"
                    ) from None
                return parsed, meta()

    except TimeoutError:
        raise fail(
            "TIMEOUT", 504, "AI request exceeded the 45 second deadline.", retryable=True
        ) from None
    except openai.APITimeoutError:
        raise fail("TIMEOUT", 504, "AI provider timed out.", retryable=True) from None
    except openai.RateLimitError as exc:
        wait = _retry_after(exc)
        raise fail(
            "RATE_LIMITED",
            429,
            "AI provider rate limit reached.",
            retryable=True,
            retry_after=round(wait) if wait is not None else None,
        ) from None
    except openai.APIStatusError as exc:
        raise _status_error(exc, fail) from None
    except openai.APIConnectionError:
        raise fail(
            "UPSTREAM_ERROR", 502, "Could not reach the AI provider.", retryable=True
        ) from None
    finally:
        m = meta()
        tokens = m.usage or Usage(inputTokens=None, outputTokens=None)
        log.info(
            "inference route=%s request=%s outcome=%s attempts=%d ms=%d model=%s in=%s out=%s",
            route, request_id, outcome, m.attempts, m.durationMs, m.model,
            tokens.inputTokens, tokens.outputTokens,
        )  # fmt: skip


def _status_error(exc: openai.APIStatusError, fail) -> ApiError:
    status = exc.status_code
    if status in (401, 403):
        return fail("UPSTREAM_ERROR", 502, "AI provider rejected the configured credentials.")
    if status == 402:
        return fail("UPSTREAM_ERROR", 502, "AI provider requires credits for the configured model.")
    if status == 404 or "parameter" in str(exc).lower():
        return fail(
            "UPSTREAM_ERROR",
            502,
            "The configured model is unavailable or has no endpoint supporting "
            "strict JSON schema output.",
        )
    return fail("UPSTREAM_ERROR", 502, "AI provider returned an error.", retryable=status >= 500)
