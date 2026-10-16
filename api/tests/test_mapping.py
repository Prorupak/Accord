import json

import pytest

from app import config

MAP_REQUEST = {
    "requestId": "req-map-1",
    "generation": 1,
    "datasets": [
        {
            "side": "A",
            "datasetId": "a" * 64,
            "columns": [
                {"id": "c0", "header": "sku"},
                {"id": "c1", "header": "item"},
                {"id": "c2", "header": "qty"},
            ],
            "samples": [{"rowId": "A:x:0", "cells": ["P01", "Stainless steel flask 750ml", "12"]}],
        },
        {
            "side": "B",
            "datasetId": "b" * 64,
            "columns": [
                {"id": "c0", "header": "product_code"},
                {"id": "c1", "header": "description"},
                {"id": "c2", "header": "stock"},
            ],
            "samples": [{"rowId": "B:y:0", "cells": ["P01", "S/S bottle 750 ml", "12"]}],
        },
    ],
}

EXPLAIN = {"productId": "SKU codes", "name": "Product text", "quantity": "Integers", "unit": "None"}


def side(product_id="c0", name="c1", quantity="c2", unit=None):
    return {
        "mapping": {"productId": product_id, "name": name, "quantity": quantity, "unit": unit},
        "explanations": EXPLAIN,
    }


def model_output(**overrides):
    return {"A": side(), "B": side(), "warnings": [], **overrides}


def post(client, body=MAP_REQUEST, **kw):
    return client.post("/api/map", json=body, **kw)


def test_valid_mapping(client, provider):
    provider.script = [model_output(B=side(name=None))]
    r = post(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["requestId"] == "req-map-1" and body["generation"] == 1
    assert body["A"]["mapping"]["name"] == "c1"
    assert body["B"]["mapping"]["name"] is None  # uncertain required field stays null
    assert body["meta"]["usage"] == {"inputTokens": 100, "outputTokens": 50}
    assert body["meta"]["attempts"] == 1
    call = provider.calls[0]
    assert call["max_tokens"] == 2000
    assert call["response_format"]["json_schema"]["strict"] is True
    assert call["extra_body"] == {
        "provider": {"require_parameters": True},
        "reasoning": {"enabled": False},
    }


@pytest.mark.parametrize(
    "bad",
    [model_output(A=side(name="c9")), model_output(B=side(quantity="c1"))],
    ids=["unknown-column", "reused-column"],
)
def test_bad_column_reference_rejected_without_repair(client, provider, bad):
    provider.script = [bad]
    r = post(client)
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "MODEL_INVALID_OUTPUT"
    assert len(provider.calls) == 1


def test_malformed_output_repaired_once(client, provider):
    provider.script = ["not json", model_output()]
    r = post(client)
    assert r.status_code == 200
    assert r.json()["meta"]["attempts"] == 2
    assert r.json()["meta"]["usage"]["inputTokens"] == 200
    assert "failed schema validation" in provider.calls[1]["messages"][-1]["content"]


def test_malformed_output_twice_is_controlled_error(client, provider):
    provider.script = ["```json {", {"A": {}}]
    r = post(client)
    assert r.status_code == 502
    err = r.json()["error"]
    assert err["code"] == "MODEL_INVALID_OUTPUT" and err["requestId"] == "req-map-1"
    assert len(provider.calls) == 2


def test_missing_configuration(client, provider, monkeypatch):
    monkeypatch.setenv("OPENROUTER_MODEL", "")
    config.get_settings.cache_clear()
    r = post(client)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "NOT_CONFIGURED"
    assert provider.calls == []


def test_invalid_schema_rejected(client, provider):
    bad = json.loads(json.dumps(MAP_REQUEST))
    bad["datasets"][0]["samples"][0]["cells"].pop()  # cell count mismatch
    r = post(client, bad)
    assert r.status_code == 400
    assert r.json()["error"] == {
        "code": "INVALID_INPUT",
        "message": r.json()["error"]["message"],
        "retryable": False,
        "requestId": "req-map-1",
    }
    assert "Stainless" not in r.text  # values are not echoed
    assert provider.calls == []


def test_extra_fields_and_one_side_rejected(client):
    assert post(client, {**MAP_REQUEST, "extra": 1}).status_code == 400
    assert post(client, {**MAP_REQUEST, "datasets": MAP_REQUEST["datasets"][:1]}).status_code == 400


def test_oversized_payload(client, provider):
    big = json.loads(json.dumps(MAP_REQUEST))
    big["datasets"][0]["columns"][0]["header"] = "x" * (65 * 1024)
    r = post(client, big)
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_oversized_chunked_payload(client):
    def chunks():
        for _ in range(70):
            yield b"x" * 1024

    r = client.post("/api/map", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_content_type_origin_and_host(client):
    raw = json.dumps(MAP_REQUEST)
    assert (
        client.post("/api/map", content=raw, headers={"content-type": "text/plain"}).status_code
        == 415
    )
    assert post(client, headers={"origin": "https://evil.example"}).status_code == 403
    assert post(client, headers={"host": "evil.example"}).status_code == 400


def test_internal_host_only_when_configured(client, provider, monkeypatch):
    assert post(client, headers={"host": "api:8000"}).status_code == 400
    monkeypatch.setenv("API_INTERNAL_HOST", "api")
    config.get_settings.cache_clear()
    provider.script = [model_output(B=side(name=None))]
    assert post(client, headers={"host": "api:8000"}).status_code == 200
    for host in ("api:9999", "evil:8000"):
        assert post(client, headers={"host": host}).status_code == 400
    origin = {"host": "api:8000", "origin": "http://api:8000"}
    assert post(client, headers=origin).status_code == 403


def test_vercel_hosts_only_when_set(client, provider, monkeypatch):
    same_origin = {"host": "accord-x.vercel.app", "origin": "https://accord-x.vercel.app"}
    assert post(client, headers=same_origin).status_code == 400
    monkeypatch.setenv("VERCEL_URL", "accord-x.vercel.app")
    config.get_settings.cache_clear()
    provider.script = [model_output(B=side(name=None))]
    assert post(client, headers=same_origin).status_code == 200
    foreign = {**same_origin, "origin": "https://evil.example"}
    assert post(client, headers=foreign).status_code == 403
    assert post(client, headers={"host": "evil.vercel.app"}).status_code == 400


def test_internal_host_rejects_patterns(monkeypatch):
    for bad in ("*", "api:8000", "evil.example"):
        monkeypatch.setenv("API_INTERNAL_HOST", bad)
        with pytest.raises(ValueError):
            config.Settings()
