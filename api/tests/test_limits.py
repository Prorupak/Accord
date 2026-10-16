import threading

import openai
import pytest
from pydantic import ValidationError

from app import config, limits
from app.limits import SlidingWindow

from .conftest import status_error
from .test_mapping import MAP_REQUEST, model_output
from .test_suggestions import SUGGEST_REQUEST, cup_abstain, output, tote_suggestion


def map_ok(client, provider, n):
    provider.script += [model_output() for _ in range(n)]
    return [client.post("/api/map", json=MAP_REQUEST).status_code for _ in range(n)]


def suggest_ok(client, provider, n):
    provider.script += [output(tote_suggestion(), cup_abstain()) for _ in range(n)]
    return [client.post("/api/suggest", json=SUGGEST_REQUEST).status_code for _ in range(n)]


def assert_rate_limited(r, request_id=""):
    assert r.status_code == 429, r.text
    err = r.json()["error"]
    assert err["code"] == "RATE_LIMITED" and err["retryable"] is True
    assert err["requestId"] == request_id
    assert isinstance(err["retryAfterSeconds"], int) and err["retryAfterSeconds"] >= 1
    assert r.headers["retry-after"] == str(err["retryAfterSeconds"])
    assert "sk-test-secret" not in r.text and "Stainless" not in r.text and "tote" not in r.text


# SlidingWindow


def test_window_admits_limit_then_reports_wait():
    now = [0.0]
    w = SlidingWindow(3, 60, lambda: now[0])
    assert [w.acquire() for _ in range(3)] == [None, None, None]
    now[0] = 10.0
    assert w.acquire() == 50  # oldest entry (t=0) frees at t=60


def test_window_expiry():
    now = [0.0]
    w = SlidingWindow(2, 60, lambda: now[0])
    w.acquire(), w.acquire()
    now[0] = 59.9
    assert w.acquire() == 1
    now[0] = 60.0
    assert w.acquire() is None


def test_window_memory_is_bounded():
    now = [0.0]
    w = SlidingWindow(5, 60, lambda: now[0])
    for i in range(10_000):
        now[0] = i * 0.5
        w.acquire()
        assert len(w._times) <= 5


def test_window_concurrent_acquire_is_atomic():
    w = SlidingWindow(20, 60)
    admitted, barrier = [], threading.Barrier(50)

    def worker():
        barrier.wait()
        for _ in range(4):
            if w.acquire() is None:
                admitted.append(1)

    threads = [threading.Thread(target=worker) for _ in range(50)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(admitted) == 20


# Route limits


def test_map_threshold(client, provider, clock):
    assert map_ok(client, provider, 6) == [200] * 6
    calls = len(provider.calls)
    assert_rate_limited(client.post("/api/map", json=MAP_REQUEST))
    assert len(provider.calls) == calls  # no provider call after rejection


def test_suggest_threshold(client, provider, clock):
    assert suggest_ok(client, provider, 12) == [200] * 12
    calls = len(provider.calls)
    assert_rate_limited(client.post("/api/suggest", json=SUGGEST_REQUEST))
    assert len(provider.calls) == calls


def test_route_limits_are_independent(client, provider, clock):
    map_ok(client, provider, 6)
    assert client.post("/api/map", json=MAP_REQUEST).status_code == 429
    assert suggest_ok(client, provider, 1) == [200]


def test_route_window_expires(client, provider, clock):
    map_ok(client, provider, 6)
    assert client.post("/api/map", json=MAP_REQUEST).status_code == 429
    clock.now += 60
    assert map_ok(client, provider, 1) == [200]


def test_limit_applies_before_body_validation(client, provider, clock):
    for _ in range(6):
        assert client.post("/api/map", json={}).status_code == 400
    assert_rate_limited(client.post("/api/map", json={}))
    assert provider.calls == []


def test_configured_route_limit(client, provider, clock, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_MAP_PER_MINUTE", "2")
    config.get_settings.cache_clear()
    assert map_ok(client, provider, 2) == [200, 200]
    assert client.post("/api/map", json=MAP_REQUEST).status_code == 429


@pytest.mark.parametrize("header", ["x-forwarded-for", "cf-connecting-ip", "x-real-ip"])
def test_spoofed_client_headers_share_one_bucket(client, provider, clock, header):
    for i in range(6):
        client.post("/api/map", json={}, headers={header: f"203.0.113.{i}"})
    r = client.post("/api/map", json={}, headers={header: "198.51.100.77"})
    assert_rate_limited(r)


def test_invalid_limit_settings_rejected(monkeypatch):
    for name in ("RATE_LIMIT_MAP_PER_MINUTE", "RATE_LIMIT_SUGGEST_PER_MINUTE"):
        monkeypatch.setenv(name, "0")
        with pytest.raises(ValidationError):
            config.Settings()
        monkeypatch.delenv(name)
    monkeypatch.setenv("PROVIDER_ATTEMPTS_PER_DAY", "-1")
    with pytest.raises(ValidationError):
        config.Settings()


# Provider budget


def budget(monkeypatch, n):
    monkeypatch.setenv("PROVIDER_ATTEMPTS_PER_DAY", str(n))
    config.get_settings.cache_clear()


def test_retries_consume_provider_budget(client, provider, clock, monkeypatch):
    budget(monkeypatch, 2)
    limited = status_error(openai.RateLimitError, 429, {"retry-after": "0"})
    provider.script = [limited, limited, output(tote_suggestion(), cup_abstain())]
    r = client.post("/api/suggest", json=SUGGEST_REQUEST)
    assert_rate_limited(r, "req-sug-1")
    assert "budget" in r.json()["error"]["message"]
    assert len(provider.calls) == 2  # third attempt refused before reaching the provider


def test_repair_consumes_provider_budget(client, provider, clock, monkeypatch):
    budget(monkeypatch, 2)
    provider.script = [
        output(tote_suggestion(explanation="x" * 241), cup_abstain()),
        output(tote_suggestion(), cup_abstain()),
    ]
    assert client.post("/api/suggest", json=SUGGEST_REQUEST).status_code == 200
    assert limits.provider_window().acquire() is not None


def test_exhausted_budget_blocks_before_provider(client, provider, clock, monkeypatch):
    budget(monkeypatch, 1)
    assert suggest_ok(client, provider, 1) == [200]
    calls = len(provider.calls)
    r = client.post("/api/map", json=MAP_REQUEST)  # budget is global, across routes
    assert_rate_limited(r, "req-map-1")
    assert r.json()["error"]["retryAfterSeconds"] == limits.DAY_SECONDS
    assert len(provider.calls) == calls
    clock.now += limits.DAY_SECONDS
    assert map_ok(client, provider, 1) == [200]


def test_unconfigured_server_spends_no_budget(client, clock, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    config.get_settings.cache_clear()
    assert client.post("/api/map", json=MAP_REQUEST).status_code == 503
    assert len(limits.provider_window()._times) == 0
