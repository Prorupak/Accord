import json
from types import SimpleNamespace

import httpx2
import openai
import pytest
from fastapi.testclient import TestClient

from app import config, openrouter
from app.main import app

BASE_URL = "http://127.0.0.1:8000"


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    """Fake credentials from the environment (which beats api/.env); the provider call is mocked."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test-secret")
    monkeypatch.setenv("OPENROUTER_MODEL", "test/free-model")
    monkeypatch.setenv("API_PORT", "8000")
    monkeypatch.setenv("FRONTEND_ORIGIN", "http://localhost:3000")
    config.get_settings.cache_clear()
    monkeypatch.setattr(openrouter, "_client", None)
    yield
    config.get_settings.cache_clear()


@pytest.fixture
def client():
    return TestClient(app, base_url=BASE_URL)


def completion(content, prompt_tokens=100, completion_tokens=50):
    if not isinstance(content, str):
        content = json.dumps(content)
    return SimpleNamespace(
        model="test/free-model",
        usage=SimpleNamespace(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens),
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))],
    )


def status_error(cls, status, headers=None):
    response = httpx2.Response(
        status, headers=headers or {}, request=httpx2.Request("POST", "https://openrouter.test")
    )
    return cls("provider says no", response=response, body=None)


def timeout_error():
    return openai.APITimeoutError(request=httpx2.Request("POST", "https://openrouter.test"))


@pytest.fixture
def provider(monkeypatch):
    """Script provider outcomes: each item is a completion payload or an exception to raise."""
    state = SimpleNamespace(script=[], calls=[])

    async def fake_create(**kwargs):
        state.calls.append(kwargs)
        item = state.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item if isinstance(item, SimpleNamespace) else completion(item)

    monkeypatch.setattr(openrouter, "_create", fake_create)
    return state
