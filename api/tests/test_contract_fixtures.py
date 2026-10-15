"""Cross-language drift check; web/src/analysis/contract.test.ts validates the same fixtures."""

import json
from pathlib import Path

from app import schemas
from app.http import ApiError, error_response
from app.schemas import SuggestModelOutput, SuggestRequest, SuggestResponse, verify_suggestions

from .conftest import completion

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "contracts" / "suggest"


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def model_output(response):
    keep = ("leftId", "rightId", "outcome", "reasonCode", "evidence", "explanation")
    return {"results": [{k: p[k] for k in keep} for p in response["proposals"]]}


def test_request_fixture_is_a_valid_request():
    req = SuggestRequest.model_validate(load("request"))
    assert req.model_dump(mode="json") == load("request")


def test_response_fixture_round_trips_exactly():
    # Any field added to or removed from the response models changes the dump.
    response = load("response")
    assert SuggestResponse.model_validate(response).model_dump(mode="json") == response


def test_response_fixture_passes_server_verification():
    req = SuggestRequest.model_validate(load("request"))
    verify_suggestions(req, SuggestModelOutput.model_validate(model_output(load("response"))))


def test_route_produces_the_fixture_shape(client, provider):
    response = load("response")
    provider.script = [completion(model_output(response), prompt_tokens=512, completion_tokens=140)]
    r = client.post("/api/suggest", json=load("request"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"].keys() == response["meta"].keys()
    assert body["meta"]["usage"] == response["meta"]["usage"]
    assert {k: v for k, v in body.items() if k != "meta"} == {
        k: v for k, v in response.items() if k != "meta"
    }


def test_error_envelopes_match_fixtures():
    for name, status in [("error-rate-limited", 429), ("error-not-configured", 503)]:
        e = load(name)["error"]
        err = ApiError(
            e["code"],
            status,
            e["message"],
            retryable=e["retryable"],
            request_id=e["requestId"],
            retry_after=e.get("retryAfterSeconds"),
        )
        assert json.loads(error_response(err).body) == load(name)


def test_limits_match_fixture():
    assert load("limits") == {
        "maxBodyBytes": schemas.MAX_BODY_BYTES,
        "maxIdChars": schemas.MAX_ID_CHARS,
        "maxCellChars": schemas.MAX_CELL_CHARS,
        "maxSuggestRows": schemas.MAX_SUGGEST_ROWS,
        "maxCandidates": schemas.MAX_CANDIDATES,
        "maxEvidence": schemas.MAX_EVIDENCE,
        "maxExplanationChars": schemas.MAX_EXPLANATION_CHARS,
    }
