def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "accord-api"}


def test_capabilities_reports_configuration_without_secrets(client):
    r = client.get("/api/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["provider"] == "openrouter"
    assert body["limits"]["maxSuggestRows"] == 5
    assert "sk-test-secret" not in r.text
    assert "key" not in r.text.lower()


def test_capabilities_unconfigured(client, monkeypatch):
    from app import config

    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    config.get_settings.cache_clear()
    assert client.get("/api/capabilities").json()["configured"] is False
