# 25: CI and supply-chain hardening, stage 2: the chosen fixes

## Why
Brief 24's audit (2026-10-13, the report is outside the repository; your task prompt gives its path) found no critical issues and nine high ones. The maintainer chose these fixes (D57, 2026-10-13): the quick wins (PRs A to D below) and dropping the end-of-life runtimes (PR E). Release integrity (signed releases checked by the updater, plus CI attestation) is decided but comes in a later brief. Code scanning (CodeQL default setup), branch and tag rulesets, commit signing, Actions settings and account protection are the maintainer's own steps in GitHub settings, not code.

Read `DEVELOPMENT.md` and `CLAUDE.md` first. One topic per PR, each on its own branch from `main`, in the order below; each PR must pass `npm test` on Linux and Windows. Synthetic data only, no personal data, no em dashes in user-facing text.

## Rules for every version, action, image and hash you add
These come from the audit's method and are binding:
- Official sources only: the project's own repository and releases page, official documentation, the registry (GHCR, npm, PyPI), GitHub Advisory Database, OSV.
- Never a floating reference (`latest`, a branch, a major-only tag). Actions by full commit SHA with the version in a comment; container images by `@sha256:` digest with the tag in a comment.
- Get every SHA and digest yourself at the time of the PR, from the registry or repository (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, peeled to the commit; `docker buildx imagetools inspect` or the registry API for digests). Do not copy them from the audit report, this brief or memory.
- No version younger than 7 days: check its publication date; if the newest is younger, take the previous one. Put the version, its date and the source link in the PR description.

## How to prove a new check works
A check only counts if it fails when it should. For every new blocking check, show in the PR description:
1. it passes on the PR as it is;
2. it fails on a violation. Prefer a permanent self-test inside the job (the job generates a violation in a temporary folder outside the checkout, runs the tool on it, and fails if the tool does NOT complain). Otherwise push one commit with a deliberate violation to the PR branch, link the red run, then revert it with a new commit. Never put anything secret-shaped into the git history for this, never force-push, never delete branches.
If a new check finds existing problems, fix them in the same PR; do not add exceptions or make the check non-blocking to get green. If a fix is impossible (for example no fixed version exists), stop and list it in the PR for the maintainer.

## PR A: pipeline pinning and linting (audit H8, M5, L1, L5)
- `test.yml` and `rehearse.yml`: every `uses:` pinned by full SHA (rules above).
- Runner labels explicit (for example `ubuntu-24.04`, `windows-2025`, from the actions/runner-images README); Node versions as the CI matrix after PR E (keep majors here if PR E is not merged yet).
- `npm ci --ignore-scripts --no-fund` in CI, and `--ignore-scripts` on the update's `npm ci --omit=dev` (`lib/layout.mjs`), with a test that the flag is passed. Neither runtime dependency has install scripts today; check that this is still true.
- A blocking workflow-lint job on PRs touching `.github/` and weekly: actionlint and zizmor (official sources, pinned). Fix what they report.

## PR B: secret scanning in CI (audit H7, L8)
- `.github/workflows/secrets.yml`: Betterleaks (official repository github.com/betterleaks/betterleaks, image `ghcr.io/betterleaks/betterleaks` by digest) over the full git history on every PR and push to `main`, blocking; `actions/checkout` with `fetch-depth: 0` and `persist-credentials: false`; read-only token.
- Self-test step: generate a fake credential in a temporary folder outside the checkout and require the scanner to flag it.
- The two synthetic test values the audit found (`test/mcp.test.mjs`, `test/coach.test.mjs`) must not trip it: prefer changing them so they no longer look like real secrets over an allowlist; if an allowlist entry is unavoidable, it names the file and the reason.
- `.gitignore`: add `*.pem`, `*.key`, `*.enc` and `*-secrets*` (check that no tracked file matches).

## PR C: dependency checks and updates (audit H5, M3)
- `.github/dependabot.yml`: `npm` at `/` and `github-actions` at `/`, weekly, grouped minor and patch, `open-pull-requests-limit: 5`, `cooldown` with `default-days: 7`. The Python transcription packages: check in Dependabot's documentation whether it reads `deploy/modules/transcribe/constraints.txt`; if it does, add it the same way, if not, say so in the PR.
- A blocking `npm audit --audit-level=high` job (omit dev dependencies only if there are none that run in CI) on every PR and on a weekly schedule.
- A dependency licence check without a new dependency: a small Node script over `package-lock.json` (and the resolved Python set if it can be listed without network installs) against an allowlist of permissive licences; MPL-2.0 allowed with a comment (the audit found it in `certifi` and `tqdm`); runs in CI, blocking.

## PR D: security documentation and small pins (audit L4, M10, M11)
- `SECURITY.md`: report privately through GitHub's private vulnerability reporting; in scope: the installer, the update and rollback, the workspace, the MCP server, the transcription module downloads; supported versions: the latest release.
- `lib/coach.mjs`: install the interview coach at a pinned upstream commit (a constant in code, raised by a CometScout release) instead of the branch head; keep the existing upgrade path working; tests.
- Install docs (`README.md`, `README-rus.md`, `INSTALL.md`, the hints `deploy/install.sh` prints): clone a release tag instead of `main`; name exact versions for the model CLIs (rules above), or the vendor's own versioned install option; no `curl | bash` without a version.

## PR E: end-of-life runtimes and the setuptools fix (audit M4, H6)
- Node 22 or newer: `package.json` `engines`, the CI matrix (22 and 24), the minimum in `deploy/install.sh`, `doctor`, and the next `release.json` entry with `min_node` and an "action needed" note in English and Russian.
- Python 3.11 or newer for the optional modules: markers in `constraints.txt`, the check in `lib/transcribe.mjs`, the docs.
- `constraints.txt`: `setuptools` raised to a version that fixes GHSA-5rjg-fvgr-3xxf (fixed from 78.1.1) and still satisfies torch's `setuptools<82`; check the resolution in a temporary venv outside the repository (resolution only, for example `uv pip compile` if it is installed) and say in the PR what you checked.

Done when PRs A to E are open, green on Linux and Windows, each with its proof of failure and its sources, and the maintainer has the list of settings to change once they are merged.
