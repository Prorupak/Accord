# Accord.

[![CI](https://github.com/Prorupak/Accord/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Prorupak/Accord/actions/workflows/ci.yml)

**Two CSV exports. One traceable result.**

Accord is an AI-assisted reconciliation workspace for comparing inventory data across different CSV exports.

When column names, product descriptions, and identifiers don't quite line up, Accord helps find the matches, surface discrepancies, and keep uncertain decisions reviewable.

**AI proposes. Code verifies. You decide.**

### What makes it different

- **Reviewable AI suggestions.** Semantic matches require your approval, with supporting evidence from the original records.
- **Deterministic matching.** Exact identifiers, duplicate conflicts, and one-to-one pairing rules are enforced in code.
- **Precise quantity comparisons.** Exact decimal arithmetic without floating-point surprises.
- **Traceable exports.** Download `matches.csv`, `unresolved.csv`, and `audit.json`.
- **Local-first workflow.** Original CSVs are parsed in your browser. AI requests send only limited, relevant fields.

### How it works

**Import → Map → Review → Export**

Choose two CSV files, confirm how their columns correspond, review suggested matches, and export a reconciliation package that accounts for every source row.

### Built with

Next.js · TypeScript · FastAPI · Python · OpenRouter · Pydantic · Zod · Docker

### Run locally

```bash
cp api/.env.example api/.env
docker compose up --build
```

Open `http://localhost:3000` and choose **Or explore with sample data**.

The local matching and export workflow can run without an AI key. Configure an OpenRouter API key and a compatible model to enable AI suggestions.

### Philosophy

A plausible model response isn't necessarily a correct match. Accord deliberately separates AI interpretation from verified application decisions.

No silent fuzzy matching. No hidden changes to source data. No unresolved rows disappearing from the results.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in
[SECURITY.md](SECURITY.md). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

### License

[MIT](LICENSE).
