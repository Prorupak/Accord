# Security policy

## Supported versions

Accord has not published a release. Security fixes go to the `develop` branch and reach `main`
with the next merge. Older commits are not patched.

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a vulnerability.

Report it privately through GitHub:
[Report a vulnerability](https://github.com/Prorupak/Accord/security/advisories/new). Include
the affected component (`web/`, `api/`, Docker or CI), steps to reproduce and the impact. Use
synthetic data only, never a real inventory file or a working credential.

This is a volunteer, single-maintainer project. Reports are handled on a best-effort basis, with
no guaranteed response time. You will get a reply in the advisory once the report has been reviewed.

## Scope notes

- The API is designed for loopback or a private Compose network. It is not hardened for direct
  internet exposure.
- The API's rate limits and daily provider budget are shared, in memory and per process. They
  do not stop volumetric DDoS. See `docs/edge-protection.md` for edge requirements.
- `audit.json` contains the original source records. Treat exports as being as sensitive as the
  input files.
- Data sent to an AI provider is described under "Data handling" in `README.md`.
