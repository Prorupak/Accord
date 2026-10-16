# Accord

[![CI](https://github.com/Prorupak/Accord/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Prorupak/Accord/actions/workflows/ci.yml)

Accord compares two inventory or catalog CSV exports, proposes matches, and produces a
traceable reconciliation package: `matches.csv`, `unresolved.csv` and `audit.json`.

The browser does the parsing, matching, decisions and exports. The FastAPI backend in `api/`
only makes two bounded AI calls: column-mapping drafts and semantic match suggestions. It never
stores data or accepts a match. The spec is `docs/accord-implementation-spec.md`. What is built
and what is open is in `docs/progress.md`.

## Run it

```sh
# terminal 1: API (needed only for AI features)
cd api
uv sync
cp .env.example .env        # set OPENROUTER_API_KEY and OPENROUTER_MODEL
uv run python -m app        # http://127.0.0.1:8000/docs

# terminal 2: web app
cd web
pnpm install
pnpm dev                    # http://localhost:3000
```

The web app proxies `/api/*` to `ACCORD_API_ORIGIN` (default `http://127.0.0.1:8000`). Without
the API, or without a key, everything except the two AI buttons still works.

You need no OpenRouter key or credits to develop, run the tests or use manual reconciliation.
Without a key the AI buttons report `NOT_CONFIGURED`. Requirements: Node 24, pnpm 10, Python 3.13
and [uv](https://docs.astral.sh/uv/).

### With Docker

```sh
docker compose up -d --build   # http://localhost:3000; api/.env is optional
scripts/docker-smoke.sh        # checks the running stack, never calls the AI provider
docker compose down
```

See `docs/docker.md`.

## Decision boundary

The model proposes and a person decides. Nothing the model returns changes the reconciliation
until someone accepts it.

- **Deterministic matching.** Records pair automatically only by exact, unique product ID, under
  the configured case mode. IDs are compared as text and never parsed as numbers. An ID that
  appears more than once in either file quarantines every row carrying it, and those rows can't
  be paired, automatically or by hand. Two different non-empty IDs are never paired. Quantities are parsed exactly
  (blank means missing, never zero) and `B − A` is computed without floating point.
- **AI output is a proposal.** A mapping draft changes nothing until you apply it. A suggested
  pair counts only after an explicit `accept` decision. The API verifies every response against
  its request (known row IDs, supplied candidates, exact evidence values). The browser checks it
  again and drops stale or invalid proposals. A failed AI call never blocks manual work.
- **Ownership.** The browser owns parsing, matching state, decisions and exports. The API only
  runs two bounded inference calls. It stores nothing and cannot accept a match.
- **Export invariants.** Before export, Accord checks that every pair references real rows
  under the current configuration, that no row is used twice, that every non-automatic pair has
  a matching decision, and that every row ends up in exactly one place
  (`|A| = |P| + |UA|`, `|B| = |P| + |UB|`). The export is a frozen snapshot of that state. The
  full rules are in `docs/domain-engine.md`.

## Use it

1. **Import.** Choose a CSV for Source A and Source B, or drop the files on their cards. Each
   card shows the file name, size, record and column counts, or the exact parse error. **Try
   sample data** loads `fixtures/inventory/source-{a,b}.csv` through the same validation path.
2. **Mapping.** For each source, pick the Product name and Quantity columns (required), and
   optionally Product ID and Unit. A column can serve only one field. Choose case-sensitive or
   case-insensitive ID matching. If neither file has a unit column, tick "Both quantity columns
   use the same unit" to get quantity differences. **Suggest mappings with AI** is optional. Its
   result is a draft that changes nothing until you click **Apply suggested draft**. Then click
   **Confirm mappings**.
3. **Review.** Records with the same unique product ID are paired automatically ("Matched by
   product ID"). The table shows both quantities and the difference (B − A). Select **Details**
   on a record to see its original cells, the eligibility, the quantity comparison and any AI
   evidence. From there you can:
   - accept, reject or leave unresolved an AI suggestion;
   - exclude an ID match and restore it later;
   - undo an approved or manual pair;
   - pair a record manually from every eligible Source B record. The search covers names and
     IDs. Records with conflicting or duplicate IDs are never offered.
4. **AI suggestions.** **Run AI suggestions** sends up to 20 unmatched Source A records with
   their candidates, in at most four requests. **Cancel analysis** stops it. The panel shows the
   real status (Not run, Running, Partial, Complete, Cancelled, Failed), counts, errors with
   retry guidance, and the provider and model the server reported. Suggestions are never
   applied without your approval. You can keep deciding while a run is in progress.
5. **Export.** When no run is active, **Prepare export** checks the invariants and freezes the
   current state into one snapshot. That gives you three download links. Any later change, such
   as a decision, a new source, a new mapping or **Start over**, removes and revokes the links.
   You then prepare again.

## When AI fails

AI failures never block reconciliation. A missing key (`NOT_CONFIGURED`), a provider error
(`UPSTREAM_ERROR`), a rate limit, a timeout, a network error or an unreadable response shows a
fixed message in the panel. ID matches, manual pairs and earlier valid suggestions are kept.
Records the run did not analyze are exported as unresolved, with the reason. Nothing is retried
automatically, there is no fallback model, and a fake suggestion is never substituted.

## Data handling

Files are parsed and held in the browser tab's memory only. Nothing goes to storage, and
reloading the page discards the session. AI requests send the column headers and the first five
records of each file (mapping), or the mapped fields of the selected records and their
candidates (suggestions), to the AI provider configured in `api/.env`. `audit.json` contains the
original parsed records, every decision and the cited evidence. Treat it as being as sensitive
as the source files.

## Tests

```sh
cd web
pnpm test                   # vitest: domain, workflow, orchestration, UI integration
pnpm exec next typegen && npx tsc --noEmit && pnpm lint && pnpm build
pnpm exec playwright install chromium   # once
pnpm e2e                    # Playwright against a production build on :3100

cd api
uv run pytest -q && uv run ruff check . && uv run ruff format --check .
```

The browser and UI tests answer `/api/*` with deterministic test doubles (`page.route` in
Playwright, a stubbed `fetch` in vitest). The doubles report themselves as provider
`test-double`. No test needs the API server or a provider key, and the app contains no test
transport that could switch on outside tests.

## Limitations

- A live OpenRouter run has not succeeded yet. The configured free model returned 502
  `UPSTREAM_ERROR` in the last smoke test (see `docs/progress.md`).
- Fixed limits: 256 KiB and 200 records per file, 12 columns, 20 records per AI pass.
- No persistence, accounts, saved workspaces, audit restore, or PDF/XLSX export.
- No releases have been published yet. There is no hosted deployment.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in
[SECURITY.md](SECURITY.md). Maintainer settings are in `docs/github-maintenance.md`. Changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE).
