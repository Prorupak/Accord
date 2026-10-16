# Accord progress

Last updated: 2026-10-16

## Cloudflare D0 + CF-01 (2026-10-16): static-export build target (Mode A)

**Mode A: local static build only.** Nothing is deployed. There is no Cloudflare account, Worker,
provider key or GitHub secret. Plan: `docs/accord-cloudflare-deployment-plan.md`.

`ACCORD_DEPLOY_TARGET=cloudflare-static` (`pnpm build:cloudflare`) writes a static site to `web/out/`.
When it is unset, `pnpm dev`, `pnpm build`, `pnpm start`, Playwright and Docker standalone behave as
before. An unknown value, or the static target combined with `NEXT_OUTPUT_STANDALONE=1`, fails the build.

The real build turned up these static-export blockers:

1. `rewrites()` is only *warned* about under `output: "export"`, then silently dropped, so `/api/*`
   would get a 404 HTML page. In static mode the key is now omitted.
2. `cacheComponents: true` fails the export step with `Invariant: PPR cannot be enabled in export
   mode`. `partialPrefetching` requires `cacheComponents`. Both are off in static mode only. The app
   uses no cache APIs, and the default build keeps both on.
3. Two client calls, `/api/map` (Mapping "Suggest mappings with AI") and `/api/suggest` (Review "Run
   AI suggestions"), would hit the 404 and show up as `MALFORMED_RESPONSE`. In static mode
   (`src/analysis/availability.ts`, which reads the value inlined by `next.config.ts`) both actions
   are replaced by "unavailable in this hosted version" text. Nothing is sent. The transport code is
   still in the bundle but no UI path reaches it.

Not blockers: the build-time fixture read in `app/page.tsx`, which works when built from `web/`.
There is no `next/image`, `next/headers`, cookies, server actions, route handlers or proxy, and the
UI never calls `/api/capabilities`.

Tests: `next.config.test.ts` covers the mode switch. `AccordApp.test.tsx` has a static-mode test
for the hidden AI actions with zero fetches. `pnpm e2e:static` (`playwright.static.config.ts`,
`e2e/static.static.ts`) serves `out/` with `python3 -m http.server` and runs the canonical sample →
manual pair → three downloads → audit replay at 390px, then a refresh and a 404. It asserts zero
`/api/` requests and zero failed asset loads. The run is serial because Python's server resets
connections under parallel workers. The CI `e2e` job gained a `pnpm e2e:static` step.

| Check (2026-10-16, local macOS) | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `next typegen`, `tsc --noEmit` | Clean |
| `pnpm test` | 378 passed |
| `pnpm build` (default) | Passes; Cache Components and PPR still on; no export warning |
| `pnpm e2e` | 11 passed |
| `pnpm build:cloudflare` | `out/index.html`, `404.html`, `favicon.ico`; 964 KB |
| `grep -rlE "OPENROUTER\|sk-or-\|api_key\|127.0.0.1:8000" out/` | No matches |
| `pnpm e2e:static` | 3 passed |
| Bad target / static+standalone | Build fails with the explicit error |
| `uv run pytest -q`, ruff check/format | 47 passed; clean |
| `docker compose build/up --wait`, `scripts/docker-smoke.sh` | All smoke checks passed |
| `pnpm lint` | **Fails, also on clean HEAD `65dbdde`**: `typescript-eslint does not support TS 7.0` (from the TS 7 Dependabot merge, #12) |

D0 blockers (gate CF-02, not CF-01):

- `pnpm lint` is broken on `main` by TS 7 / typescript-eslint, so CI's `web` job cannot be green.
  It needs an owner decision: pin TypeScript 6, or wait for typescript-eslint support.
- `gh run list` returns HTTP 404 from this machine, so the CI status on GitHub was not verified.
- Mapping's `aria-describedby="ai-disclosure"` is still orphaned in local mode. Static mode does not
  render the button. Fix it before any public AI (Mode B).

## Deployment phase 01 (2026-10-16): Docker and Compose

Done. `web/Dockerfile` (Next.js standalone, repo-root context), `api/Dockerfile` (uv locked
production sync, uvicorn on 0.0.0.0), `compose.yaml` (web on 127.0.0.1:3000 only, api internal with a
`/health` healthcheck), `.dockerignore` files, `scripts/docker-smoke.sh` and `docs/docker.md`. The
API Host guard gained an opt-in `API_INTERNAL_HOST` (one bare hostname; unset keeps the old
behaviour). No deploy, CI or Cloudflare changes.

## Phase 04-III (2026-10-16): Export experience

Done. Export follows `docs/accord-export-design-handoff/`. It has a flat four-cell summary `dl`, a
"Prepare your handoff." status panel with a single primary action, "Inside the package." (three connected
file panels), two hairline-separated notes (unresolved is valid; audit contains source data, replay is not
tamper-proof authentication) and a `Back to review` stage action. The domain, workflow, analysis, API,
export formats and `useExportArtifacts` are unchanged; links still use the hook's URLs and `isStillCurrent` guard.

- `ExportScreen.tsx` rewritten; `AccordApp.tsx` uses the prototype's Export lead.
- States are the real ones: `Ready to prepare` → `Export prepared` (revision from the snapshot) and the
  existing violation / Blob-failure alerts. Before a valid preparation each file shows `Prepare first`
  text, not a link. Download links keep the accessible name `Download <file>`.
- Partial / cancelled / failed analysis and unreviewed suggestions show a review notice; the button is
  only disabled while an analysis runs (`canExport`), with a visible reason.
- Tests: the canonical export test now checks the summary `dl`, the pre-prepare state and `Export prepared`;
  a new test covers prepare → Back to review → change a decision → return (all three URLs revoked, no links,
  `Ready to prepare`, a fresh set of URLs, decisions kept). The two e2e sentence assertions read the summary;
  a new Playwright test checks 1440 / 1024 / 390 with no overflow and 44px prepare/download targets.

Results: `pnpm test` 373/373. `tsc`, lint and build are clean. Playwright 11/11. Production screenshots at 1440
(unprepared and prepared), 1024 and 390 were compared with the prototype PNGs.

Deviations from the prototype:
- Not ported: the prototype-state dropdown, `Incomplete AI analysis` toggle, demo tag, toast, simulated
  downloads, fixed counts/revision and the "Export concept" footer.
- No `Export out of date` state: leaving Export unmounts the screen and the hook revokes its URLs, so a
  returning user always sees `Ready to prepare` for the current revision. No stale link can exist.
- No `Preparing` state: `prepareExport` is synchronous.
- Matched-pairs sub-caption is `Accepted one-to-one`, not an exact/reviewed split (`counts()` has no breakdown).
- Caption drops `Nothing downloaded yet`; Accord does not track downloads.

Open:
- Not checked: 200% zoom, reduced motion in a browser, and a screen-reader pass.

## Phase 04-II (2026-10-16): Review workspace

Done. Review follows `docs/accord-review-design-handoff/` (see "Review" in `docs/ui-design-system.md`).
It has a flat summary strip, AI controls beside the workspace heading, and a queue + inspector workspace
(3fr/2fr from 1280px, `Records` / `Details` panes below). There are no per-row `Details` buttons. The domain,
workflow, analysis, API and export code are unchanged. Every action still goes through `workflow.decide`.

- Width: Review keeps the shared `max-w-content` column so the shell does not change width between stages (the brief allowed a wider Review; dropped after review feedback).
- `reviewRows.ts`: new `filterCount`, `counterpart`, `matchesQuery` (in-memory name/ID search) and
  `statusTone`. `ReviewScreen.tsx`, `RecordDetail.tsx` and `AnalysisPanel.tsx` are restyled. Selection
  state stays local to the screen.
- Copy: `Exclude ID match` → `Exclude exact match`. The AI disclosure now says that names and product IDs
  are sent and quantities are not (that matches `domain/aiContext.ts`).
- Found while testing: a default (unpinned) selection jumped to the first record after `Accept pair`.
  Decisions now pin the shown record.
- Tests: 6 new UI tests (filter counts and search, default and stable selection, no delta on a pending
  row, a B-only record with no invented A, the disclosure) plus conflict assertions and a
  `reviewRows` unit test. Two new Playwright tests: an identifier conflict blocked through export, and
  the layout at 1440 / 1024 / 390 (pane switching, focus, no horizontal overflow, queue inside the
  first 900px). Existing specs click rows instead of `Details`.

Results: `pnpm test` 372/372. `tsc`, lint and build are clean. Playwright 9/9. Production screenshots at 1440,
1024 and 390, before and after a stubbed AI run (test double, no provider call), were compared with
the prototype. There is no horizontal overflow, and the queue starts at about 555px at 1440×900.

Deviations from the prototype:
- Not ported: `Load sample AI results`, demo data and arithmetic, the "pcs" unit, the toast, the demo tag,
  `Selection is local` and the "Built-in safeguards" demo line.
- The manual picker is the existing search + `Pair with …` list, not a `<select>`. There is no `Reconsider`
  for deferred rows because the reducer has no un-defer.
- Status labels stay the app's own (`Approved suggestion`, `Manual match`, `Unresolved: …`) and the filter
  stays `Identifier conflicts`. The pane switch is an `aria-pressed` button group, not ARIA tabs, because
  both panes are visible from 1280px.
- The split starts at 1280px (Tailwind `xl`), not the prototype's 1120px.

Open:
- Not checked: 200% zoom, reduced motion in a browser (the global rule applies), a screen-reader pass, and
  a live `/api/suggest` run (it costs quota).

## Phase 04-I / Step 04 (2026-10-16): Mapping screen

Done. Mapping matches `docs/accord-mapping-prototype.html` (see "Mapping" in `docs/ui-design-system.md`).
It has a source strip with `Ready` marks, a section head with the AI trigger and a draft strip
(Dismiss / Apply draft), two source panels with `CORE FIELDS` / `OPTIONAL FIELDS`, header-only
selects and `PREVIEW FROM` value previews, comparison rules with custom checkboxes and a safeguards
line, and an anchored confirmation bar. The reducer, domain, hashing, `/api/map` contract,
confirmation and discard prompts are unchanged.

- `MappingScreen.tsx` is rewritten. `AccordApp.tsx` uses the prototype's longer Mapping lead.
- Copy now follows the prototype: `Match IDs case-insensitively`, `Both files use the same quantity
  unit`, `Apply draft`, the footer status lines, and options that show the header only (values moved
  to the preview). The tests and both e2e specs are updated to match.
- New tests: the source strip and heading outline, previews, readiness gating, rule semantics, AI
  flags (`AI draft available`, Dismiss, `Suggested`, `Edited`), and a Playwright layout check at
  1024 and 390.

Results: `pnpm test` 366/366, `tsc`, lint and build clean, Playwright 7/7. Production screenshots
were compared with the prototype at 1440 (including a stubbed AI draft), 1024 and 390. There is no
horizontal overflow.

Open:
- The "what is sent to the AI provider" caption under the AI button is commented out in the source.
  The button's `aria-describedby="ai-disclosure"` now points at nothing. Mapping therefore no longer
  states what is sent, which §11.7 and the Step 03 note relied on. Restore it or decide otherwise.
- Not ported from the prototype: the header concept tag, the "Two validated source files" aside and
  the footer line (shell chrome or demo-only).
- Not checked: the AI success path against a live `/api/map` (it costs quota) and a screen reader pass.

## Phase 04-I / Step 03 (2026-10-16): Import screen

Done. Import now matches the editorial reference: one card holds the eyebrow `01 / Start a comparison`,
the H1 and the lead, then two dashed dropzones, then a footer with `Or explore with sample data` and
`Continue →`. The parser, reducer, `chooseFile`, `confirmDiscard` and the other screens are unchanged.

- `AccordApp.tsx`: the `STAGES` entries can override the eyebrow. Import frames the intro and `<main>` in a
  card. The error banner moved above the intro on every stage.
- `ImportScreen.tsx`: each source card is now a label-wrapped dropzone around a `sr-only` input with the same
  id. The file facts are a single caption line. Errors and `Clear Source X` sit below the zone.
- Tests: the action names are `Or explore with sample data` and `Continue` (exact). The file-fact and eyebrow
  assertions are updated.

Results: `pnpm test` 361/361, `tsc`, lint and build clean, Playwright 6/6. Screenshots were checked at
1440, 1024 and 390 (empty, keyboard focus, loaded, parse error).

Open:
- **Spec departure (§3.1, §11.7), chosen by the user:** Import no longer shows "Choose two CSV exports, or
  explore the sample." or the session-privacy note, and the sample action reads `Or explore with sample
  data`. Mapping still states what is sent to the AI provider. Restore the privacy note before release
  if §11.7 stays binding.
- Not checked: 200% zoom, a real drag and drop in a browser (the handlers are unchanged), and a screen
  reader pass on the dropzone name.

## Phase 04-I / Step 02 (2026-10-16): application shell and workflow navigation

Done. The shell now uses the 04-I/01 tokens. Screen content, the reducer, domain, analysis, API
and export code are unchanged.

- **`web/src/ui/AccordApp.tsx`:** a 64px `h-header` with the text brand `accord.` (accent period)
  and `Start over`, then one `max-w-content` column holding the workflow navigation, the error
  banner and `<main>`.
  - **Navigation:** four native buttons in a 4-column grid (`1. Import` … `4. Export`). Current is
    `aria-current="step"` with an accent underline; unavailable steps are `disabled` via
    `canEnterStage`. "Complete" is derived (both sources loaded; mappings confirmed) and exposed in
    the accessible name; Review and Export are never claimed complete. No new state.
  - **Error banner:** `role="alert"`, error tokens, a per-kind title over the existing message,
    and `Dismiss`. Routing is unchanged, so import and analysis errors still show only in place.
  - **Start over:** confirms with `window.confirm` whenever a source is loaded or mappings are
    confirmed, then dispatches the existing `workflow/reset`. Back navigation never asks.
- **Headings:** the shell renders none. Each screen's title is its one `h1` (`text-page`). Panel
  headings moved down one level (`h3`→`h2`, `h4`→`h3`) in Import, Mapping, AnalysisPanel and
  RecordDetail. Copy is unchanged.
- **Tests:** 9 new shell tests in `AccordApp.test.tsx` (gating, current/complete semantics,
  keyboard order, one `h1` per stage, alert dismissal, reset with nothing to lose, cancelled and
  confirmed reset, decisions kept across back navigation, a pending AI run dropped by Start over).
  New `web/e2e/shell.e2e.ts`: 390px visibility and overflow, Tab/Enter stage navigation, and the
  Start over dialog dismiss/accept.
- **Docs:** "Application shell" section in `docs/ui-design-system.md`; skill rule 9 points to it.

| Check | Result |
| --- | --- |
| `pnpm test` | 21 files, 360 tests passed |
| `npx tsc --noEmit`, `pnpm lint`, `pnpm build` | Clean |
| `pnpm exec playwright test` | 6 passed (3 existing, 3 new) |
| Screenshots at 1440, 1024, 390 (Import, Mapping, Review, Export, focus) | Inspected; no horizontal scroll, all four steps visible at 390 |

Not checked in a browser: the error banner (covered by unit tests only), 200% zoom and
reduced motion. No transitions were added.

### Revision: match the editorial shell reference

- The header drops the tagline. `Start over` is now a ghost button with a reset icon.
- Steps read `01 Import` … `04 Export`. A completed step shows a `success` check instead of its
  number, and its accessible name is `Import, complete` (screen-reader-only text, not an `aria-label`).
- **The shell now owns the stage intro:** an eyebrow (`02 / MAPPING`), the single `h1` and a muted
  lead.
  - The titles are "Bring two exports into agreement.", "Understand your columns.", "Review the
    proposed matches." (the lead names both files) and "Export a traceable result."
  - The four screens no longer render an `h1`. Import's lead moved into the shell.
- Tests were updated for the new names and titles, and one test was added for the eyebrow and lead.

| Check | Result |
| --- | --- |
| `pnpm test` | 21 files, 361 tests passed |
| `npx tsc --noEmit`, `pnpm lint`, `pnpm build` | Clean |
| `pnpm exec playwright test` | 6 passed |
| Screenshots at 1440, 1024 and 390 (all four stages) | Inspected; matches the reference layout, all four steps fit at 390 |

## Phase 04-I / Step 01 (2026-10-16): design foundations

Done. The app now has one token source and a documented design system. No screen was
redesigned, and the domain, workflow, analysis, export and API code is unchanged.

- **`web/app/globals.css`** is the canonical token source. It has a Tailwind 4 `@theme static`
  block holding:
  - The semantic palette from spec §11.2, plus `line-strong` for control boundaries. Tailwind's
    default palette is removed.
  - The Helvetica and mono stacks, and nine type roles (`display` … `caption`).
  - Layout tokens: gutter, content width, header, panel, control heights.
  - 8px and 12px radii, one overlay shadow, and motion durations.
- **Base layer:** hairline default border colour, the body on canvas/ink, a global
  `:focus-visible` ring, an `aria-invalid` border and a reduced-motion override.
- **Component layer:** `.btn` and `.btn-primary` cover hover, active, selected (via
  `aria-current`/`aria-pressed`), disabled and busy. Form controls get the same treatment.
  `.data-table` uses tabular numerals.
- **`app/layout.tsx`:** Geist removed. It was loaded but never rendered.
- **Screens:** colour swaps only. Palette classes became tokens (`text-error`, `border-error`,
  `border-accent`, `bg-accent-soft`), the shell uses `max-w-content px-gutter`, and the summary
  counts use `tabular-nums`. The dark-mode variant was removed (light-only v1).
- **Docs:**
  - New `docs/ui-design-system.md`.
  - The `accord-design-system` skill (`.claude/skills/`) now points at that document, and its
    reference uses `error`/`line-strong`.
  - `CLAUDE.md` links both.

| Check (run 2026-10-16) | Result |
| --- | --- |
| `pnpm test` (web) | 21 files, 351 tests passed |
| `npx tsc --noEmit` / `pnpm lint` / `pnpm build` (web) | Clean |
| `pnpm exec playwright test` (web) | 3 passed |
| Visual | Playwright screenshots of Import, Mapping and Review at 1440, 1024 and 390 px with reduced motion. No page overflow, and the focus ring is 2px accent |
| Contrast | Computed for every token pair (see `docs/ui-design-system.md`) |

Still open: the Import, Mapping, Review and Export redesigns (Phase 04-I later steps), the app
header at `h-header`, the type-role adoption in screens, and the Review layouts in spec
§11.3–11.4. Not checked: a manual screen-reader pass, 200% zoom, the Export screen at all three
widths (the e2e covers 390px only), and Safari/Firefox rendering.

## Phase 03-III (2026-10-15): functional application

Done. `web/` now has a working app instead of the Next starter page. It covers import, mapping,
review and decisions, AI suggestions and export, all through the existing domain, reducer and
orchestrator. The styling is deliberately plain; visual design is Phase 04. The backend is unchanged.

- **New `web/src/ui/`:**
  - `AccordApp.tsx`: the only caller of `useAccordWorkflow` and `useSuggestAnalysis`. It renders
    the stage navigation (gated by `canEnterStage`), the typed error banner, and "Start over".
  - Screens: `ImportScreen`, `MappingScreen`, `ReviewScreen` with `RecordDetail` and
    `AnalysisPanel`, and `ExportScreen`.
  - `reviewRows.ts`: the derived review table model, recomputed each render.
  - `useExportArtifacts.ts`: the snapshot and Blob URL lifecycle.
- **New `web/src/analysis/mapSuggestion.ts`:** a strict `/api/map` client. It sends headers and
  five samples per side and produces drafts that are applied only on an explicit click.
- **Small API changes:**
  - `useAccordWorkflow().confirmMappings(approve?)` lets the mapping screen ask before a remap
    discards decisions.
  - `readApiError` was extracted from `response.ts` so both clients map server errors the same
    way. Behavior is unchanged.
- **Sample data:** `app/page.tsx` reads `fixtures/inventory/*.csv` at build time. "Try sample
  data" sends them through `chooseFile` like any user file.
- **Export:**
  - Each explicit prepare calls `prepareExport` once and creates three Blob URLs. If any URL
    fails, the ones already created are revoked.
  - Links render only while `isSnapshotCurrent` holds and the reconciliation context is the same
    object, so a reload of the same file confirmed with the same mapping also invalidates them.
  - Stale entries and unmount revoke the URLs. Link clicks re-check validity.
- **Tests:**
  - Vitest: 51 new tests. `reviewRows`, `mapSuggestion`, `useExportArtifacts`, and an
    `AccordApp` integration suite that drives the real app in jsdom, with `fetch`, `confirm` and
    `URL.createObjectURL` stubbed at the browser boundary.
  - Playwright (`web/e2e/`, new dev dependency `@playwright/test` 1.64.0): three tests.
    - Canonical path: export, parse the files, and `replayAudit` on the downloaded audit.
    - `UPSTREAM_ERROR` path with a manual pair, then export.
    - 390 px layout check.
  - AI responses come from `page.route`, and a catch-all aborts any unstubbed `/api/*` call.

| Check (run 2026-10-15) | Result |
| --- | --- |
| `pnpm test` (web) | 21 files, 351 tests passed (300 existing, 51 new) |
| `npx tsc --noEmit` / `pnpm lint` / `pnpm build` (web) | Clean; `/` prerendered static |
| `pnpm exec playwright test` (web) | 3 passed (Chromium, production build) |
| `uv run pytest -q` (api) | 41 passed |
| `uv run ruff check .` / `ruff format --check .` | Clean |
| Layout | Checked with headless Chromium at 1440, 1024 and 390 px: no page overflow, table unclipped on desktop |

**Live provider: not run in this phase.** The last result is still the Phase 03-II 502
`UPSTREAM_ERROR`. The app shows that error and keeps manual reconciliation and export working.
A successful live run stays a separate release gate.

Open after this phase:

1. Live `/api/map` and `/api/suggest` runs through the UI with a model that supports strict JSON schema.
2. A manual keyboard-only and screen-reader pass. Focus order and labels were checked through
   tests and screenshots, not with assistive technology.
3. Phase 04 visual design. Not built: elapsed time in the run panel, an event list, focus return
   after decisions beyond keeping the selected record, and a reduced-motion audit (there is no
   motion today).

## Phase 03-II (2026-10-15): AI orchestration for `/api/suggest`

Done. The browser can now run a bounded, verified semantic-suggestion pass. Design notes are in
`docs/ai-orchestration.md`. There is still no UI; Phase 03-III consumes `useSuggestAnalysis`.

- **New `web/src/analysis/`:**
  - `contract.ts`: strict Zod schemas that mirror the Pydantic models, the limits, and the typed failure taxonomy.
  - `request.ts`: a pure request builder with a UTF-8 byte cap.
  - `response.ts`: validation against the frozen request.
  - `runner.ts`: a sequential runner with one request in flight, at most four requests and 20 rows, a 4-minute deadline, `AbortController` and idempotent cancel.
  - `useSuggestAnalysis.ts`: a React adapter that starts each committed run exactly once and is safe under Strict Mode.
- **Domain changes:**
  - New `domain/aiContext.ts`, which clips AI context to 160 code points as specified in §7.4.
  - `proposalDefect` now does three new things:
    - It compares evidence with the clipped value the model saw.
    - It allows an abstention to cite competing Source B rows. This was a gap: the API accepted such abstentions, but the engine counted the row as failed.
    - It fails closed with a new `truncated_context` reason when a suggestion rests on clipped identity text.
  - `unresolvedReason` now checks `no_candidates` before the run-level cancelled or failed reasons.
- **Reducer change:** `analysis/completed` ignores unsent rows that have no candidates left, which happens when a human resolved them mid-run. Such a run now ends `complete` instead of `partial`.
- **Contract drift tests:**
  - Shared fixtures live in `fixtures/contracts/suggest/`.
  - They are checked by `api/tests/test_contract_fixtures.py` and by `web/src/analysis/contract.test.ts`.
  - The backend app code is unchanged. The only API change is the new test file.

| Check (run 2026-10-15) | Result |
| --- | --- |
| `pnpm test` (web) | 17 files, 300 tests passed (233 existing, 62 analysis, 5 domain/reducer regressions) |
| `npx tsc --noEmit` (web) | Clean |
| `pnpm lint` (web) | Clean |
| `pnpm build` (web) | Succeeded |
| `uv run pytest -q` (api) | 41 passed (35 existing, 6 contract fixtures) |
| `uv run ruff check .` / `ruff format --check .` | Clean |

**Live provider check: failed.** One authorized request was sent: the `api/README.md` smoke
payload, posted directly to `127.0.0.1:8000/api/suggest`. The API on that port was the
already-running local dev server, configured with `google/gemma-4-31b-it:free`. The result:

- **Response:** 502 `UPSTREAM_ERROR`: "The configured model is unavailable or has no endpoint supporting strict JSON schema output." `retryable: false`.
- **Not verified:** whether strict structured output works with this model. Because no successful response came back, there were no proposals, abstentions, usage or model metadata, and the Pydantic `SuggestResponse` path was not exercised.
- **Client validation:** the real error body passed `apiErrorSchema`. `readSuggestResponse` classified it as `UPSTREAM_ERROR`, run-scoped, not retryable, with no metadata.
- **Next step:** choose a model with an OpenRouter endpoint that supports strict `json_schema` in `api/.env`, then rerun the smoke test. The server's message cannot tell a 404 apart from a "parameter" rejection (Phase 01 open item 3).

Still open: Phase 03-III (export lifecycle, Blob URLs, downloads and the working UI), a model
that passes the live check, and the evaluation harness.

## Phase 03-I (2026-10-15): workflow state and reducer

Done. The browser-side workflow state machine is built in `web/src/workflow/` (design notes in
`docs/workflow-state.md`). It wraps the domain engine without duplicating its policy. The UI does
not use it yet, and nothing calls the API.

- **State:** one `WorkflowState` holding the stage, both sources (each with a pending import
  token), the draft mapping, `reconciliation` (null until mappings are confirmed) and a display
  error. Counts, statuses and progress are derived by selectors.
- **Reducer:** pure, with an exhaustive action union and no generic setters.
  - Imports are token-guarded, so a slower earlier file cannot overwrite a newer one.
  - Replacing or clearing a source drops the confirmation, decisions, proposals and any run,
    and keeps the other source.
  - Confirmation re-validates the current draft and datasets against what was hashed.
  - Every decision goes through `applyDecision`.
  - Analysis start, batch, batch failure, completion, cancellation and failure are guarded by
    status, generation and configuration hash. Terminal transitions advance the generation.
- **Hook:** `useAccordWorkflow` owns one `useReducer`. It creates tokens, decision IDs and
  timestamps, and it runs parsing and hashing outside the reducer.
- **Domain changes:**
  - New `proposalIdOf` helper.
  - Bug fix: `addProposals` no longer drops and re-adds a proposal when the same batch is
    replayed. Before, the replay bumped revision with no change. There is a regression test.
- **Web change:** added the dev dependency `jsdom` 30.1.3, for the hook test only.
- **Deviation:** spec §5.3 puts the reducer under `src/app/`. It lives in `web/src/workflow/`
  instead, next to `web/src/domain/`, because `web/app/` is the Next.js route directory.

| Check (run 2026-10-15) | Result |
| --- | --- |
| `pnpm test` (web) | 12 files, 233 tests passed (174 existing, 1 domain regression, 58 workflow) |
| `npx tsc --noEmit` (web) | Clean |
| `pnpm lint` (web) | Clean |
| `pnpm build` (web) | Succeeded |
| Backend | Unchanged; not re-run |

Still open: 03-II (AI orchestration: the `/api/suggest` request builder, Zod response schema,
context clipping, batching, retries and `AbortController`) and 03-III (export lifecycle, Blob URLs,
downloads and the working UI).

## Phase 02 (2026-10-15): deterministic reconciliation engine

The browser-side domain engine is now built in `web/src/domain/` (design notes in
`docs/domain-engine.md`). It has no UI wiring yet, and it does not call the API.

- **CSV ingestion:** strict parsing (§4.1).
  - SHA-256 over the original bytes, fatal UTF-8 decoding, BOM handling.
  - Positional columns, side-qualified row IDs, blank-record counting.
  - Typed errors that never include cell values.
- **Mapping and configuration:** validation, and a fixed-tuple configuration hash.
- **Exact-ID matching:**
  - Duplicate-ID quarantine applied on both sides.
  - A single eligibility policy (`checkPair`) shared by every matching path.
- **Candidates:** lexical retrieval (NFKC, case fold, token-set Jaccard; top five; ties broken by B index) plus a manual-picker set.
- **Quantities:** BigInt arithmetic in thousandths, with unit rules (§4.6).
- **Decisions:** accept, reject, defer, exclude-exact and undo, plus proposal intake with generation and hash guards.
- **Invariants:** an invariant checker, with export blocked whenever a check fails.
- **Export and replay:**
  - `matches.csv`, `unresolved.csv` and `audit.json` built from one revision, with formula protection.
  - A pure `replayAudit`.
- **Fixtures:** `fixtures/inventory/source-{a,b}.csv` (spec §13.1).
- **Web changes:**
  - Added dependencies, at exact versions: `papaparse` 5.7.0, `zod` 4.6.7, `@types/papaparse` 5.5.2, `vitest` 5.0.4.
  - Added a `test` script.
  - Raised the `tsconfig` target from ES2017 to ES2020, which BigInt literals and Unicode property regexes require.
- **Audit schema:** the only addition is three row-ID lists in `audit.analysis`. See `domain-engine.md`.

| Check (run 2026-10-15) | Result |
| --- | --- |
| `pnpm test` (web) | 8 files, 174 tests passed |
| `npx tsc --noEmit` (web) | Clean |
| `pnpm lint` (web) | Clean |
| `pnpm build` (web) | Succeeded |
| `uv run pytest -q` (api, unchanged) | 35 passed |
| `uv run ruff check .` / `ruff format --check .` | Clean |

The canonical fixture integration test passes. It produces 3 accepted pairs (P01 and P03 by ID, plus tote/bag by an injected manual decision), 1 unmatched A row, 2 unmatched B rows and a P03 delta of `-1`. Replaying the serialized audit reproduces both CSVs byte for byte.

Still open: the workflow reducer and UI, the `/api/suggest` request builder and client-side response schema, AI-context clipping, cancellation orchestration, browser downloads, the eval harness, and live inference.

The phase 01 report below is kept as written, except for item 5 under Open items.

## Summary

The FastAPI backend is built and tested. It sits behind the existing Next.js app through a dev
proxy. Both inference endpoints from spec §6–8 work against a mocked provider. Live OpenRouter
inference has **not** been verified yet.

The spec's Node/Express + AI SDK backend became Python + FastAPI, calling OpenRouter through the
OpenAI Python SDK. Everything else follows `accord-implementation-spec.md`.

## Done

### Repo hygiene

- Added a root `.gitignore`. Before this, `api/.env` (which holds the real OpenRouter key) was
  untracked but not ignored, so a plain `git add .` would have committed it. It now excludes
  `.env`, `.env.*` (except `.env.example`), `.venv/`, Python caches, `.pytest_cache/`,
  `.ruff_cache/` and `.DS_Store`.

### Backend (`api/`)

Python 3.13 project managed with uv. Dependencies: fastapi, uvicorn, pydantic v2,
pydantic-settings, openai. Dev: pytest, httpx, ruff.

| File | Role |
| --- | --- |
| `app/main.py` | App, `GET /health`, `GET /api/capabilities`, error handlers |
| `app/config.py` | Settings from `api/.env`; key held as `SecretStr` |
| `app/http.py` | Request guards, §8.3 error envelope, single inference slot |
| `app/schemas.py` | Request/response contracts, limits, model-output verification |
| `app/openrouter.py` | Provider call, retry/repair budget, error mapping |
| `app/routes/mapping.py` | `POST /api/map` (§7.2 prompt) |
| `app/routes/suggestions.py` | `POST /api/suggest` (§7.3 prompt) |
| `app/__main__.py` | `uv run python -m app` dev server |
| `README.md`, `.env.example` | Setup, commands, smoke test |

What it enforces:

- **Trust boundary:** Host must be `127.0.0.1` or `localhost` on the API port. Origin, when
  present, must be the frontend. Content type must be JSON. The 64 KiB body cap is checked
  before parsing, including on streamed bodies. Validation errors name fields, never values.
- **Request bounds:** at most 5 Source A rows, 5 candidates per row, and 5 samples per side.
  Cells are capped at 2,048 characters. Unknown fields are rejected.
- **Inference budget:** one request at a time (a second gets 409 `BUSY`), 45 s deadline,
  at most 3 provider attempts with at most 1 schema repair, `max_tokens` 2000, temperature 0.
  SDK retries are off. Retry-After is honored only if it fits in the deadline.
- **Strict output:** requests use a strict JSON schema and
  `provider.require_parameters=true`, so OpenRouter refuses rather than routing to a provider
  that ignores the schema. No fallback model and no downgrade.
- **Verification of model output** (no retry on failure; returns 502 `MODEL_INVALID_OUTPUT`):
  unknown row IDs, invented candidates, duplicate or missing results, nonexistent columns,
  altered evidence values, one-sided evidence, and inconsistent abstention.
- **Echoes:** `requestId`, `generation` and (for suggest) `configurationHash`, on the response
  and on each proposal.
- **Secrets and data:** the key never reaches the frontend, logs or error messages. Logs record
  route, request ID, outcome, attempts, duration, model and token counts, never cell contents.
  A missing key does not stop startup; inference returns 503 `NOT_CONFIGURED`.

### Frontend (`web/`)

- `web/next.config.ts`: added only a `rewrites()` entry sending `/api/*` to
  `ACCORD_API_ORIGIN` (default `http://127.0.0.1:8000`). Same-origin, so no CORS.
- No UI work yet. The app still renders the starter page.

## Verification

| Check | Result |
| --- | --- |
| `uv run pytest -q` | 35 passed, provider mocked, no network |
| `uv run ruff check .` / `ruff format --check .` | Clean |
| `npm run lint`, `tsc --noEmit` (web) | Clean |
| `/health`, `/api/capabilities`, `/docs`, `/openapi.json` on a running server | 200 |
| `/api/capabilities` and `/api/map` through the Next proxy on :3000 | Proxied; Host/Origin guard passed |
| `git check-ignore api/.env` | Ignored |
| Live OpenRouter request | **Not run** |

## Open items

1. **Live smoke test.** Run the `curl` in `api/README.md` once to confirm the configured model
   (`google/gemma-4-31b-it:free`) returns verified proposals. It uses the OpenRouter quota, so it
   waits for an explicit go-ahead.
2. **Strict-schema support is unknown** for that free model. If it lacks it, the API returns
   502 `UPSTREAM_ERROR` saying so, and a different model must be chosen in `.env`.
3. **Error-classification heuristic.** A provider error mentioning "parameter" is reported as
   missing strict-schema support. The live run will show whether OpenRouter's wording matches.
4. **Frontend.** The upload, mapping, review and export UI from the spec is not built. Nothing
   calls the API yet.
5. ~~Nothing is committed.~~ Superseded: phase 01 was merged to `develop` in PR #1.

## Running locally

```sh
# terminal 1
cd api && uv sync && uv run python -m app      # http://127.0.0.1:8000/docs

# terminal 2
cd web && pnpm dev                          # http://localhost:3000
```
