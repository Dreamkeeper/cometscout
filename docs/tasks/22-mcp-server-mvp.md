# 22: MCP server, first version: setup, settings and the daily basics

## Why
Setting CometScout up still means editing `settings.json` and profile files over SSH, or a Claude Code session following `AGENTS.md`. Most users already talk to an AI client (Claude Desktop, Claude Code, Codex). An MCP server lets that client read CometScout's state, explain what is missing, and change settings safely, with the same validation the CLI and the workspace use. The MCP is a third front end, never a new way to write state: every write goes through the existing writers (`lib/settings-writer.mjs`, `lib/applications.mjs`, ...).

Maintainer decisions (D54): stdio transport, reached over SSH for a VPS (`claude mcp add cometscout -- ssh <host> cometscout mcp`); this first version is read plus validated settings writes and the daily status changes; secrets never pass through the MCP. Packs, runs, transcripts and profile edits come in phase 2; installs, updates, backups and an HTTPS transport in phase 3.

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies: implement the MCP JSON-RPC protocol over stdio directly (it is small), following the current MCP specification (protocol version negotiation, `initialize`, `tools/list`, `tools/call` with `inputSchema` and `outputSchema` and structured content, `resources/list` and `resources/read`, `prompts/list` and `prompts/get`, tool annotations such as `readOnlyHint` and `destructiveHint`, errors as tool results where the spec says so). Synthetic data only, no em dashes in user-facing text, English and Russian where text reaches the user. Every change gets a test; `npm test` must pass on Linux and Windows.

## 1. Server
- `node cli.mjs mcp [--scope read|operate|admin]` (default `operate`; the scope can also come from `mcp.scope` in settings, and the lower of the two wins). stdout carries only protocol messages; logs go to stderr.
- Scopes: `read` lists and reads only; `operate` adds status changes and adding jobs; `admin` adds settings writes and the onboarding writes. Tools outside the scope are not listed.
- Every call that changes something appends one line to `data/state/mcp-log.jsonl`: time, tool, arguments with anything secret-looking removed, result summary.
- The run lock applies: a write while a run holds the lock is refused with a clear message (the workspace already behaves this way).

## 2. Tools in this version
Read:
- `status`: version, home, schedule, timezone, last run (time, result, counts), next run, sources enabled and their last result, Telegram on or off, update available, modules installed.
- `doctor`: the doctor lines as structured items (ok / todo / warn, text, fix).
- `run_log`: the last run's summary and failures; `limit`.
- `settings_get`: the effective settings with every secret-looking value redacted; optional `path`.
- `settings_schema`: every known setting with type, default, allowed values and one line of help, so the client can explain options without reading the code. Generate it from one source of truth in the code (add one if needed) and test that it covers every key `doctor` validates.
- `onboarding_state`: the onboarding steps from `AGENTS.md` with done or not (profile, CV library, sources, delivery, timer, modules), and the next step.
- `today`: today's picks and the interview-prep state, as the workspace's Today API returns them.
- `jobs_search`: query, verdict, folder, date range, limit; returns file, company, role, verdict, date. `job_get`: one job's text and decode result.
- `applications_list`: with status filter.
- `secrets_status`: which secrets each enabled feature needs and whether each is set (never the value).

Operate:
- `set_status`: company or file, status, role words, note (same rules as `cli.mjs status`).
- `record_interview`: as `cli.mjs interview`.
- `add_job`: a URL (fetched through `lib/fetch-detail.mjs`) or pasted text plus company and role, written to the inbox like the drop-dir source.

Admin:
- `settings_set`: `path`, `value`, `dry_run` (default true): validates the whole resulting settings like `doctor`, refuses unknown keys and secret keys, returns a unified diff; with `dry_run: false` writes through the settings writer (keeping the file's formatting and line endings) and returns the diff applied. Changing the schedule time reinstalls the timer as the workspace does.
- `secrets_form`: returns a one-time link to a workspace page (`/secrets?t=<token>`) where the user types the value; the token is single-use, expires after 15 minutes, and the page writes `.env` through the existing secrets code. The tool explains how to open it from the user's computer (an SSH tunnel to the workspace port) and never receives the value.

## 3. Resources and prompts
- Resources: `cometscout://settings/schema`, `cometscout://digest/latest`, `cometscout://doctor`, `cometscout://onboarding`.
- Prompts: `setup` (walk the user through the onboarding steps one at a time, using the tools), `tune-gates` (look at recent rejections and picks and propose gate or title changes, as dry runs first), `weekly-review` (applications, outcomes and picks of the week).

## 4. Docs
README "Use it from an AI client (MCP)": the one-line setup for Claude Code (`claude mcp add ...`), Claude Desktop (config snippet with `ssh`), Codex; the scopes; what is never exposed (secrets, shell, arbitrary files); the audit log. AGENTS.md: the onboarding can use the MCP tools. ROADMAP: phases 2 and 3.

## Tests
A protocol test harness that spawns `cli.mjs mcp` and speaks JSON-RPC over stdio: initialize and version negotiation, list per scope, each tool's happy path on the example profile with synthetic data, settings_set dry run diff and real write (formatting kept, unknown and secret keys refused, invalid values refused like doctor), the run lock refusal, audit log lines with secrets removed, the one-time secrets link (single use, expiry, the page writes `.env`, the value never appears in any tool result or log), resources and prompts, malformed requests answered with JSON-RPC errors without crashing, nothing but protocol on stdout.

## Done when
`npm test` passes on Linux and Windows; a real MCP client (Claude Code with `claude mcp add` against a local install) lists and calls the tools (say what you ran in the PR); docs updated. PR description lists what was built, what was not, and open questions.
