# GitHub maintenance

Manual repository settings and the maintainer runbook. Nothing here is applied automatically.
GitHub moves settings around now and then. If a path below doesn't match, search the settings page
for the setting's name. Mark each item done in the checklist at the end.

Repository: `Prorupak/Accord`. Default branch: `main`. Integration branch: `develop`.

## 1. Before making the repository public

Do these first, in order:

1. Run the secret audit again (see "Secret audit" below). If any credential was ever committed,
   **revoke and rotate it at the provider first**. Removing it from the branch does not remove it
   from history.
2. Confirm the copyright holder in `LICENSE` (Rupak Sapkota) holds the rights. In particular, check
   that no employer or client owns the work, and that every fixture and asset is yours or permissively
   licensed. `web/public/*.svg` and `web/app/favicon.ico` are the `create-next-app` defaults.
3. Confirm you want `rupaksapkota2000@gmail.com` published as the Code of Conduct contact. It
   becomes public in `CODE_OF_CONDUCT.md`.
4. Settings → General → Danger Zone → **Change visibility** → Public.

## 2. About and metadata

On the repository home page, click the gear next to **About**:

- Description: `Compare two inventory CSV exports, review proposed matches, and export a traceable reconciliation package.`
- Website: leave empty (there is no hosted demo).
- Topics: `nextjs`, `fastapi`, `typescript`, `python`, `csv`, `reconciliation`, `open-source`.
- Leave Releases and Packages unticked until a release exists.

## 3. Settings → General

- **Features:** tick Issues. Tick Discussions only when you are ready to moderate them (see §7).
  Untick Wikis and Projects if you won't use them.
- **Pull Requests:**
  - Tick **Allow squash merging**. Set the default message to "Pull request title and description".
  - Untick **Allow merge commits** and **Allow rebase merging**, so history stays one commit per PR.
  - Tick **Always suggest updating pull request branches**.
  - Tick **Automatically delete head branches**.
- Leave auto-merge off. Dependency PRs are always merged by hand.

## 4. Settings → Actions → General

- **Actions permissions:** "Allow Prorupak, and select non-Prorupak, actions and reusable workflows".
  - Tick "Allow actions created by GitHub".
  - Under "Allow specified actions and reusable workflows", enter:
    `pnpm/action-setup@*, astral-sh/setup-uv@*`
  - Tick "Require actions to be pinned to a full-length commit SHA" if your plan offers it. `ci.yml`
    already pins every action.
- **Approval for running fork pull request workflows from contributors:** "Require approval for
  first-time contributors".
- **Workflow permissions:** "Read repository contents and packages permissions". Untick "Allow GitHub
  Actions to create and approve pull requests".
- Settings → Secrets and variables → Actions: should stay empty. CI needs no secrets. Never add an
  OpenRouter key here.

## 5. Rulesets

Wait until CI has run at least once on a pull request, so the status checks `web`, `api`, `e2e` and
`docker` exist and can be selected.

Settings → Rules → Rulesets → **New ruleset** → New branch ruleset. Create one for `develop` and
one for `main`. Both use the same rules:

- Ruleset name: `develop` (or `main`). Enforcement status: **Active**.
- Bypass list: leave empty. (Add yourself only if you accept skipping checks in an emergency.)
- Target branches: **Add target** → Include by pattern → `develop` (or `main`).
- Tick **Restrict deletions**.
- Tick **Block force pushes**.
- Tick **Require a pull request before merging**:
  - Required approvals: **0**. This is a solo-maintainer repo, and 1 would block you from merging
    your own PRs.
  - Leave "Require review from Code Owners" **unticked**.
  - Tick **Require conversation resolution before merging**.
  - Allowed merge methods: Squash.
- Tick **Require status checks to pass**:
  - Add checks: `web`, `api`, `e2e`, `docker` (source: GitHub Actions).
  - Tick "Require branches to be up to date before merging". It reruns CI after every base change.
    Untick it if the queue gets slow.
- Leave "Require linear history" unticked. Squash-only merging already keeps history linear.
- Click **Create**.

When a second maintainer with write access joins, raise required approvals to 1 and consider
code-owner review.

## 6. Labels

Issues → Labels. GitHub creates `bug`, `documentation`, `enhancement`, `good first issue` and
`help wanted` by default. Keep those and add:

| Label | Use |
| --- | --- |
| `security` | Security hardening (never undisclosed vulnerabilities) |
| `tests` | Test-only changes |
| `area: web` | `web/` |
| `area: api` | `api/` |
| `area: infra` | Docker, CI, Dependabot |
| `dependencies` | Dependabot creates and applies this on its own |

Delete defaults you won't use (`duplicate`, `invalid`, `question` and `wontfix` are optional).

## 7. Discussions

When you are ready to moderate: Settings → General → Features → tick **Discussions** →
**Set up discussions**. Keep the **Q&A** and **Ideas** categories and delete the rest. Then:

- In `SUPPORT.md`, replace "once they are enabled" with a link to
  `https://github.com/Prorupak/Accord/discussions`.
- In `.github/ISSUE_TEMPLATE/config.yml`, add a contact link:

  ```yaml
  - name: Ask a question
    url: https://github.com/Prorupak/Accord/discussions/categories/q-a
    about: Questions and ideas go to Discussions.
  ```

## 8. Security (Settings → Advanced Security)

On older UIs this is "Code security and analysis".

- **Dependency graph:** Enable (it is on by default for public repos).
- **Dependabot alerts:** Enable.
- **Dependabot security updates:** Enable. These PRs always target the default branch (`main`),
  whatever `target-branch` says. Version updates from `.github/dependabot.yml` go to `develop`.
  Cherry-pick or merge a security fix into `develop` too.
- **Grouped security updates:** Enable.
- **CodeQL analysis:** **Set up → Default**. Languages: JavaScript/TypeScript, Python. (Also
  "GitHub Actions" if it is offered.) Query suite: Default. Do not add a `codeql.yml` workflow
  alongside default setup.
- **Secret Protection / Secret scanning:** Enable.
- **Push protection:** Enable.
- **Private vulnerability reporting:** Enable. `SECURITY.md` and the issue-template contact link point
  to `/security/advisories/new`, which only works once this is on.

Some of these exist for free only on public repositories. Check what the UI offers rather than
assuming.

## 9. Dependabot

- `.github/dependabot.yml` checks npm (`/web`), uv (`/api`), Docker (`/web`, `/api`) and GitHub
  Actions weekly on Monday. A new release waits 7 days (`cooldown`). Minor and patch updates are
  grouped per ecosystem, and majors get their own PR.
- Review each PR's CI and release notes, then squash-merge by hand. Nothing auto-merges.
- Node in `web/Dockerfile` and pnpm/Node in `ci.yml` must stay in step. When Dependabot bumps the
  Node image, update `node-version` in `ci.yml` to match. Do the same for uv: the `api/Dockerfile`
  image tag and `version` in `ci.yml`.
- Dependabot PRs run CI without secrets, like fork PRs.

## 10. Contributor onboarding

- Label small, well-understood, low-risk tasks `good first issue`. Describe the expected change and
  the test to run. Don't give that label to anything that touches `web/src/domain/`, the API
  contract or `api/app/http.py`.
- Point new contributors to `CONTRIBUTING.md`. It covers setup without an API key, the four CI
  checks and the data rules.
- First-time contributors' workflow runs need your approval (§4). Read the diff before approving,
  especially changes under `.github/`, `scripts/` and package manifests.

## 11. Releases

To cut a release (v0.1.0 shown; substitute the new version):

1. Confirm the open release gates in `docs/progress.md`, including the live OpenRouter run.
2. Merge `develop` into `main` through a PR.
3. In `CHANGELOG.md`, move the `Unreleased` entries under `## [0.1.0] - YYYY-MM-DD`, add a
   fresh `Unreleased` heading and update the compare links at the bottom.
4. Releases → **Draft a new release** → tag `v0.1.0` on `main` → title `v0.1.0` → paste the
   changelog section → **Publish release**.

There is no automated publishing, image push or deployment. Add one only in its own phase, with its
own review of tokens and permissions.

## Secret audit

Run before going public and whenever in doubt. These print findings without secret values:

```sh
docker run --rm -v "$PWD":/repo zricethezav/gitleaks:v8.30.1 git /repo --redact --no-banner
git log --all --oneline -- '*.env' '**/.env' '*.pem' '*.key'   # expect no output
git ls-files | grep -Ei '\.env$|\.pem$|\.key$|secret'          # expect only api/.env.example
```

## Publication checklist

- [ ] Secret audit clean; any exposed credential rotated (§1)
- [ ] Copyright holder and asset rights confirmed (§1)
- [ ] Code of Conduct contact confirmed (§1)
- [ ] Repository public; About and topics set (§1–2)
- [ ] General: squash-only, delete head branches (§3)
- [ ] Actions: read-only token, allow-list, fork approval (§4)
- [ ] CI passed on a PR; rulesets for `develop` and `main` with the four checks (§5)
- [ ] Labels created (§6)
- [ ] Discussions enabled and linked, or deliberately left off (§7)
- [ ] CodeQL default setup, Dependabot alerts and security updates, secret scanning, push protection,
  private vulnerability reporting (§8)
