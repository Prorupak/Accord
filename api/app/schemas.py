"""Request/response contracts (spec §6, §8) and verification of model output against the request."""

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

MAX_BODY_BYTES = 64 * 1024
MAX_CELL_CHARS = 2048
MAX_ID_CHARS = 128
MAX_SAMPLES = 5
MAX_SUGGEST_ROWS = 5
MAX_CANDIDATES = 5
MAX_EVIDENCE = 6
MAX_EXPLANATION_CHARS = 240
REQUEST_DEADLINE_SECONDS = 45.0
MAX_PROVIDER_ATTEMPTS = 3
MAX_OUTPUT_TOKENS = 2000

Side = Literal["A", "B"]
Id = Annotated[str, Field(min_length=1, max_length=MAX_ID_CHARS)]
Cell = Annotated[str, Field(max_length=MAX_CELL_CHARS)]


def _cap(limit: int):
    def check(value):
        if len(value) > limit:
            raise ValueError(f"at most {limit} allowed")
        return value

    return AfterValidator(check)


# Output caps use AfterValidator so they stay out of the JSON Schema sent to the provider:
# strict-mode providers differ in which length keywords they accept.
Explanation = Annotated[str, _cap(MAX_EXPLANATION_CHARS)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---- /api/map ----


class Column(Contract):
    id: Id
    header: Cell


class Sample(Contract):
    rowId: Id
    cells: list[Cell]


class DatasetSample(Contract):
    side: Side
    datasetId: Id
    columns: list[Column] = Field(min_length=2, max_length=12)
    samples: list[Sample] = Field(max_length=MAX_SAMPLES)

    @model_validator(mode="after")
    def _consistent(self):
        ids = [c.id for c in self.columns]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate column id")
        if any(len(s.cells) != len(ids) for s in self.samples):
            raise ValueError("sample cell count must equal column count")
        rows = [s.rowId for s in self.samples]
        if len(set(rows)) != len(rows):
            raise ValueError("duplicate sample rowId")
        return self


class MapRequest(Contract):
    requestId: Id
    generation: int = Field(ge=0)
    datasets: list[DatasetSample] = Field(min_length=2, max_length=2)

    @model_validator(mode="after")
    def _two_sides(self):
        if sorted(d.side for d in self.datasets) != ["A", "B"]:
            raise ValueError("datasets must be exactly one A and one B")
        return self


class DraftMapping(Contract):
    productId: str | None
    name: str | None
    quantity: str | None
    unit: str | None


class FieldExplanations(Contract):
    productId: Explanation
    name: Explanation
    quantity: Explanation
    unit: Explanation


class SideDraft(Contract):
    mapping: DraftMapping
    explanations: FieldExplanations


class MapModelOutput(Contract):
    A: SideDraft
    B: SideDraft
    warnings: Annotated[list[Explanation], _cap(MAX_EVIDENCE)]


# ---- /api/suggest ----


class EvidenceRef(Contract):
    side: Side
    rowId: str
    columnId: str
    value: str


class RowFields(Contract):
    rowId: Id
    fields: list[EvidenceRef] = Field(min_length=1, max_length=MAX_EVIDENCE)


class SuggestRow(Contract):
    left: RowFields
    candidates: list[RowFields] = Field(min_length=1, max_length=MAX_CANDIDATES)

    @model_validator(mode="after")
    def _owned_fields(self):
        for side, owner in [("A", self.left), *[("B", c) for c in self.candidates]]:
            for f in owner.fields:
                if f.side != side or f.rowId != owner.rowId:
                    raise ValueError("field side/rowId must match the row that owns it")
                if len(f.columnId) > MAX_ID_CHARS or len(f.value) > MAX_CELL_CHARS:
                    raise ValueError("field exceeds size limit")
            cols = [f.columnId for f in owner.fields]
            if len(set(cols)) != len(cols):
                raise ValueError("duplicate columnId within a row")
        ids = [c.rowId for c in self.candidates]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate candidate rowId")
        return self


class SuggestRequest(Contract):
    requestId: Id
    generation: int = Field(ge=0)
    configurationHash: Id
    rows: list[SuggestRow] = Field(min_length=1, max_length=MAX_SUGGEST_ROWS)

    @model_validator(mode="after")
    def _unique_left(self):
        ids = [r.left.rowId for r in self.rows]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate Source A rowId")
        return self


class ModelSuggestion(Contract):
    leftId: str
    rightId: str | None
    outcome: Literal["suggest", "abstain"]
    reasonCode: Literal["semantic_equivalence", "ambiguous", "insufficient_evidence"]
    evidence: Annotated[list[EvidenceRef], _cap(MAX_EVIDENCE)]
    explanation: Explanation


class SuggestModelOutput(Contract):
    results: list[ModelSuggestion]


# ---- responses ----


class Usage(BaseModel):
    inputTokens: int | None
    outputTokens: int | None


class InferenceMeta(BaseModel):
    provider: str
    model: str
    promptVersion: int
    durationMs: int
    attempts: int
    usage: Usage | None


class MapResponse(BaseModel):
    requestId: str
    generation: int
    A: SideDraft
    B: SideDraft
    warnings: list[str]
    meta: InferenceMeta


class Proposal(ModelSuggestion):
    generation: int
    configurationHash: str


class SuggestResponse(BaseModel):
    requestId: str
    generation: int
    configurationHash: str
    proposals: list[Proposal]
    meta: InferenceMeta


# ---- verification: model output against the original request ----


def verify_mapping(req: MapRequest, out: MapModelOutput) -> None:
    for ds in req.datasets:
        draft = getattr(out, ds.side).mapping
        known = {c.id for c in ds.columns}
        chosen = [v for v in draft.model_dump().values() if v is not None]
        if unknown := [v for v in chosen if v not in known]:
            raise ValueError(f"side {ds.side}: unknown column(s) {unknown}")
        if len(set(chosen)) != len(chosen):
            raise ValueError(f"side {ds.side}: a column is mapped to more than one field")


def verify_suggestions(req: SuggestRequest, out: SuggestModelOutput) -> None:
    expected = [r.left.rowId for r in req.rows]
    got = [r.leftId for r in out.results]
    if len(set(got)) != len(got):
        raise ValueError("duplicate result for a Source A row")
    if set(got) != set(expected):
        raise ValueError("results must cover exactly the requested Source A rows")

    rows = {r.left.rowId: r for r in req.rows}
    for res in out.results:
        row = rows[res.leftId]
        supplied = {
            (f.side, f.rowId, f.columnId): f.value
            for owner in (row.left, *row.candidates)
            for f in owner.fields
        }
        for ev in res.evidence:
            key = (ev.side, ev.rowId, ev.columnId)
            if key not in supplied:
                raise ValueError(f"row {res.leftId}: evidence references an unsupplied field")
            if supplied[key] != ev.value:
                raise ValueError(f"row {res.leftId}: evidence value differs from supplied cell")

        if res.outcome == "abstain":
            if res.rightId is not None or res.reasonCode == "semantic_equivalence":
                raise ValueError(f"row {res.leftId}: abstention must have no candidate")
            continue
        if res.reasonCode != "semantic_equivalence":
            raise ValueError(f"row {res.leftId}: suggestion has an abstention reason")
        if res.rightId not in {c.rowId for c in row.candidates}:
            raise ValueError(f"row {res.leftId}: suggested candidate was not supplied")
        sides = {(ev.side, ev.rowId) for ev in res.evidence}
        if ("A", res.leftId) not in sides or ("B", res.rightId) not in sides:
            raise ValueError(f"row {res.leftId}: suggestion needs evidence from both rows")
