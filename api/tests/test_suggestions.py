import asyncio
import json

import httpx
import openai
import pytest

from app import config, openrouter
from app.main import app

from .conftest import BASE_URL, completion, status_error, timeout_error


def ref(side, row, col, value):
    return {"side": side, "rowId": row, "columnId": col, "value": value}


TOTE, BAG = "A:x:1", "B:y:1"
CUP, T350, T500 = "A:x:3", "B:y:3", "B:y:4"

SUGGEST_REQUEST = {
    "requestId": "req-sug-1",
    "generation": 3,
    "configurationHash": "cfg-abc",
    "rows": [
        {
            "left": {
                "rowId": TOTE,
                "fields": [ref("A", TOTE, "c1", "Organic cotton tote natural")],
            },
            "candidates": [
                {"rowId": BAG, "fields": [ref("B", BAG, "c1", "Natural cotton shopping bag")]}
            ],
        },
        {
            "left": {"rowId": CUP, "fields": [ref("A", CUP, "c1", "Travel cup blue")]},
            "candidates": [
                {"rowId": T350, "fields": [ref("B", T350, "c1", "Travel tumbler blue 350ml")]},
                {"rowId": T500, "fields": [ref("B", T500, "c1", "Travel tumbler blue 500ml")]},
            ],
        },
    ],
}


def tote_suggestion(**overrides):
    return {
        "leftId": TOTE,
        "rightId": BAG,
        "outcome": "suggest",
        "reasonCode": "semantic_equivalence",
        "evidence": [
            ref("A", TOTE, "c1", "Organic cotton tote natural"),
            ref("B", BAG, "c1", "Natural cotton shopping bag"),
        ],
        "explanation": "Both describe a natural cotton bag.",
        **overrides,
    }


def cup_abstain(**overrides):
    return {
        "leftId": CUP,
        "rightId": None,
        "outcome": "abstain",
        "reasonCode": "ambiguous",
        "evidence": [ref("A", CUP, "c1", "Travel cup blue")],
        "explanation": "Capacity unspecified; 350ml and 500ml both plausible.",
        **overrides,
    }


def output(*results):
    return {"results": list(results)}


def post(client, body=SUGGEST_REQUEST):
    return client.post("/api/suggest", json=body)


def test_valid_suggestion_and_abstention(client, provider):
    # Model returns rows out of order; response follows request order.
    provider.script = [output(cup_abstain(), tote_suggestion())]
    r = post(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["requestId"], body["generation"], body["configurationHash"]) == (
        "req-sug-1",
        3,
        "cfg-abc",
    )
    tote, cup = body["proposals"]
    assert tote["leftId"] == TOTE and tote["rightId"] == BAG and tote["outcome"] == "suggest"
    assert (
        cup["outcome"] == "abstain" and cup["rightId"] is None and cup["reasonCode"] == "ambiguous"
    )
    assert all(
        p["configurationHash"] == "cfg-abc" and p["generation"] == 3 for p in body["proposals"]
    )
    assert "id" not in tote  # proposal IDs are assigned by the browser
    assert body["meta"]["provider"] == "openrouter" and body["meta"]["model"] == "test/free-model"


@pytest.mark.parametrize(
    "results",
    [
        pytest.param([tote_suggestion(rightId="B:y:999"), cup_abstain()], id="invented-candidate"),
        pytest.param([tote_suggestion(rightId=T350), cup_abstain()], id="other-rows-candidate"),
        pytest.param(
            [
                tote_suggestion(
                    evidence=[
                        ref("A", TOTE, "c1", "Organic cotton tote"),
                        ref("B", BAG, "c1", "Natural cotton shopping bag"),
                    ]
                ),
                cup_abstain(),
            ],
            id="altered-evidence",
        ),
        pytest.param(
            [
                tote_suggestion(
                    evidence=[
                        ref("A", TOTE, "c1", "Organic cotton tote natural"),
                        ref("B", BAG, "c7", "x"),
                    ]
                ),
                cup_abstain(),
            ],
            id="nonexistent-column",
        ),
        pytest.param(
            [
                tote_suggestion(evidence=[ref("A", TOTE, "c1", "Organic cotton tote natural")]),
                cup_abstain(),
            ],
            id="one-sided-evidence",
        ),
        pytest.param([tote_suggestion()], id="missing-row"),
        pytest.param([tote_suggestion(), cup_abstain(), cup_abstain()], id="duplicate-row"),
        pytest.param([tote_suggestion(), cup_abstain(leftId="A:x:9")], id="unknown-row"),
        pytest.param(
            [tote_suggestion(rightId=None), cup_abstain()], id="suggest-without-candidate"
        ),
        pytest.param([tote_suggestion(), cup_abstain(rightId=T350)], id="abstain-with-candidate"),
        pytest.param(
            [tote_suggestion(reasonCode="ambiguous"), cup_abstain()],
            id="suggest-with-abstain-reason",
        ),
    ],
)
def test_unverifiable_output_rejected(client, provider, results):
    provider.script = [output(*results)]
    r = post(client)
    assert r.status_code == 502, r.text
    assert r.json()["error"]["code"] == "MODEL_INVALID_OUTPUT"
    assert len(provider.calls) == 1  # reference errors are never re-prompted


def test_overlong_explanation_is_schema_failure_with_repair(client, provider):
    provider.script = [
        output(tote_suggestion(explanation="x" * 241), cup_abstain()),
        output(tote_suggestion(), cup_abstain()),
    ]
    assert post(client).status_code == 200
    assert len(provider.calls) == 2


def test_truncated_output_fails_without_repair(client, provider):
    provider.script = [completion("", finish_reason="length")]
    r = post(client)
    assert r.status_code == 502, r.text
    assert r.json()["error"]["code"] == "MODEL_INVALID_OUTPUT"
    assert len(provider.calls) == 1


def test_request_bounds(client, provider):
    row = SUGGEST_REQUEST["rows"][1]
    too_many_candidates = json.loads(json.dumps(SUGGEST_REQUEST))
    too_many_candidates["rows"][1]["candidates"] = [
        {"rowId": f"B:y:{i}", "fields": [ref("B", f"B:y:{i}", "c1", "x")]} for i in range(6)
    ]
    too_many_rows = {
        **SUGGEST_REQUEST,
        "rows": [
            {**row, "left": {"rowId": f"A:x:{i}", "fields": [ref("A", f"A:x:{i}", "c1", "x")]}}
            for i in range(6)
        ],
    }
    mislabeled = json.loads(json.dumps(SUGGEST_REQUEST))
    mislabeled["rows"][0]["candidates"][0]["fields"][0]["side"] = "A"
    for body in (too_many_candidates, too_many_rows, mislabeled):
        assert post(client, body).status_code == 400
    assert provider.calls == []


def test_rate_limit_retries_then_reports(client, provider):
    limited = status_error(openai.RateLimitError, 429, {"retry-after": "0"})
    provider.script = [limited, limited, limited]
    r = post(client)
    assert r.status_code == 429
    err = r.json()["error"]
    assert (
        err["code"] == "RATE_LIMITED" and err["retryable"] is True and err["retryAfterSeconds"] == 0
    )
    assert len(provider.calls) == 3  # attempt budget is shared and capped


def test_rate_limit_beyond_deadline_not_waited(client, provider):
    provider.script = [status_error(openai.RateLimitError, 429, {"retry-after": "120"})]
    r = post(client)
    assert r.status_code == 429 and r.json()["error"]["retryAfterSeconds"] == 120
    assert len(provider.calls) == 1


def test_transient_error_then_success(client, provider):
    provider.script = [
        status_error(openai.InternalServerError, 503, {"retry-after": "0"}),
        output(tote_suggestion(), cup_abstain()),
    ]
    r = post(client)
    assert r.status_code == 200 and r.json()["meta"]["attempts"] == 2


def test_provider_timeout(client, provider, monkeypatch):
    monkeypatch.setattr(openrouter.random, "uniform", lambda a, b: 0)
    monkeypatch.setattr(openrouter, "REQUEST_DEADLINE_SECONDS", 0.3)
    provider.script = [timeout_error(), timeout_error()]
    r = post(client)
    assert r.status_code == 504
    assert r.json()["error"]["code"] == "TIMEOUT"


def test_overall_deadline(client, monkeypatch):
    async def slow(**_):
        await asyncio.sleep(5)

    monkeypatch.setattr(openrouter, "_create", slow)
    monkeypatch.setattr(openrouter, "REQUEST_DEADLINE_SECONDS", 0.1)
    r = post(client)
    assert r.status_code == 504 and r.json()["error"]["code"] == "TIMEOUT"


def test_unsupported_structured_output_reported(client, provider):
    provider.script = [status_error(openai.NotFoundError, 404)]
    r = post(client)
    assert r.status_code == 502
    err = r.json()["error"]
    assert err["code"] == "UPSTREAM_ERROR" and "strict JSON schema" in err["message"]
    assert "provider says no" not in r.text  # provider messages are not forwarded


def test_one_active_request(monkeypatch):
    release = asyncio.Event()

    async def held(**_):
        await release.wait()
        return completion(output(tote_suggestion(), cup_abstain()))

    monkeypatch.setattr(openrouter, "_create", held)

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url=BASE_URL) as c:
            first = asyncio.create_task(c.post("/api/suggest", json=SUGGEST_REQUEST))
            await asyncio.sleep(0.05)
            second = await c.post("/api/suggest", json=SUGGEST_REQUEST)
            release.set()
            return await first, second

    first, second = asyncio.run(run())
    assert second.status_code == 409 and second.json()["error"]["code"] == "BUSY"
    assert first.status_code == 200


def test_client_disconnect_frees_slot(monkeypatch):
    calls = 0

    async def held_then_ok(**_):
        nonlocal calls
        calls += 1
        if calls == 1:
            await asyncio.Event().wait()  # first call never answers; only cancellation ends it
        return completion(output(tote_suggestion(), cup_abstain()))

    monkeypatch.setattr(openrouter, "_create", held_then_ok)

    async def run():
        hang_up = asyncio.Event()
        body = json.dumps(SUGGEST_REQUEST).encode()
        messages = iter([{"type": "http.request", "body": body, "more_body": False}])

        async def receive():
            try:
                return next(messages)
            except StopIteration:
                await hang_up.wait()
                return {"type": "http.disconnect"}

        sent = []

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "POST", "scheme": "http", "path": "/api/suggest", "raw_path": b"/api/suggest",
            "query_string": b"", "root_path": "",
            "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 8000),
            "headers": [(b"host", b"127.0.0.1:8000"), (b"content-type", b"application/json")],
        }  # fmt: skip
        first = asyncio.create_task(app(scope, receive, send))
        await asyncio.sleep(0.05)
        hang_up.set()
        await asyncio.wait_for(first, 1)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url=BASE_URL) as c:
            return sent[0]["status"], await c.post("/api/suggest", json=SUGGEST_REQUEST)

    first_status, second = asyncio.run(run())
    assert first_status == 499
    assert second.status_code == 200


def test_model_output_logged_only_when_opted_in(client, provider, monkeypatch, caplog):
    caplog.set_level("INFO", logger="accord.api")
    provider.script = [output(tote_suggestion(), cup_abstain())]
    assert post(client).status_code == 200
    assert "completion route=suggest" in caplog.text
    assert "Organic cotton tote" not in caplog.text  # cell values stay out by default

    caplog.clear()
    monkeypatch.setenv("LOG_MODEL_OUTPUT", "true")
    config.get_settings.cache_clear()
    provider.script = [output(tote_suggestion(), cup_abstain())]
    assert post(client).status_code == 200
    assert "model output route=suggest" in caplog.text
    assert "Organic cotton tote" in caplog.text


def test_verification_failure_reason_logged(client, provider, caplog):
    caplog.set_level("INFO", logger="accord.api")
    provider.script = [output(tote_suggestion(rightId=T350), cup_abstain())]
    assert post(client).status_code == 502
    assert (
        f"verification failed route=suggest request=req-sug-1 attempt=1 reason=row {TOTE}"
        in caplog.text
    )
