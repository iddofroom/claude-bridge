# Repo lanes — setup

The owner, 2026-10-03: from the phone menu of bakbukim ("משימות לקלוד") he dictates or types a task, and Claude on this machine carries it out in the bakbukim project. Such a task can take an hour, so it must not run in the one-at-a-time queue, where it would hold up the CS drafts and manager triage behind it. It runs in a lane of its own, the same machinery as the jobs lane (`../jobs/README.md`), with one difference: a פינגו job starts from an empty folder, while a repo job has to work inside an existing project.

## What a repo job gets

- A fresh git worktree of the project, cut from `origin/<base>` right before the run, at `<repo>\.claude\worktrees\studio-<date>-<id>`, on branch `task/studio-<date>-<id>`. Running inside the project is what makes its `CLAUDE.md`, `AGENTS.md`, skills and `node_modules` (resolved upward from the worktree) apply.
- `--permission-mode bypassPermissions`, every built-in tool, no MCP servers (`--strict-mcp-config`), and `repo-jobs/rules.md` appended to the system prompt.
- A folder for `RESULT.md` / `RESULT.json` OUTSIDE the worktree (`%TEMP%\bridge-repo-jobs\<date>-<id>`), named at the end of the prompt. Inside the project, a run that stages with `git add -A` would commit them.
- The jobs lane's stop rules: stopped after `JOBS_IDLE_MINUTES` without writing anything in the worktree, or at the lane's minutes as a backstop. A stopped run is still answered from `RESULT.json`, or from `RESULT.md`.
- When the run ends, `git worktree remove` WITHOUT `--force`: a worktree that still holds uncommitted work is kept, and the log says so. Branches are left alone.
- Git setup runs in the background (it never holds up the queue), can never prompt for credentials (`GIT_TERMINAL_PROMPT=0`, no stdin) and is killed after 2 minutes; a failure fails that one job.
- The idle watcher counts writes in the worktree AND in the result folder.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `REPO_JOBS` | `bakbukim-tasks:bakbukim:dev:240` | `lane:repo folder:base branch:minutes`, comma-separated |
| `REPO_JOBS_SOURCES` | `bakbukim-tasks=bakbukim-owner-task` | `lane=source[\|source…]`, comma-separated |
| `SIGNED_FULL_SOURCES` | `bakbukim=bakbukim-manager-execute` | one-at-a-time queue rows that run full only when signed: `workspace=source[\|source…]` (see below) |

Fail-closed, like every job lane: a repo lane runs only rows with `permission_mode='full'` from its own sources; those sources are failed in every other workspace; פינגו's sources cannot reach a repo lane. The hub stores `'full'` only for the workspaces it allows that for (iddofroom `app/api/copilot/external/prompt`); everything else arrives with no mode, which this poller treats as read-only. A configured repo lane whose repo folder is missing fails its rows instead of leaving them queued.

## The signature (why the hub's secret is not enough)

The hub authenticates every external caller with one shared secret and takes `workspace` and `source` from the request body, so any holder of that secret could name a repo lane. A repo job therefore also needs the caller's **Ed25519 signature** (`signature.mjs`): the caller signs the prompt with a private key only it holds (bakbukim: the Worker secret `BRIDGE_TASK_SIGNING_KEY`), and the poller verifies it with the public key committed here as `<lane>.pub.pem`. Nothing secret lives on this machine, and neither the hub nor a leaked hub secret can sign.

- The prompt ends with `[[bridge-signature v1 ts=<ISO> nonce=<id> sig=<base64url>]]`, over `bridge-signature v1\n<lane>\n<ts>\n<nonce>\n<body>`. The poller strips that line before Claude sees the prompt.
- Refused: unsigned, malformed, a bad signature, a signature for another lane, older or newer than `REPO_JOBS_MAX_AGE_HOURS` (default 72, so a weekend with the machine off still runs), a nonce that already ran (`%TEMP%\bridge-repo-jobs\repo-jobs-nonces.json`), or a lane with no `.pub.pem`.
- Rotating the key: generate a new pair, put the private half in the caller's secret store and replace `<lane>.pub.pem` here; pull and restart the poller.
- Tests: `node --test bridge/repo-jobs/signature.test.mjs`.

## Signed rows in the one-at-a-time queue ("בצע")

bakbukim's "בצע" button (source `bakbukim-manager-execute`, workspace `bakbukim`) asks for a full run in the ordinary queue, in the project's main folder. From 2026-07-23, when this poller became fail-closed, until 2026-10-03, the hub stored no mode for it, so every "בצע" quietly ran read-only: Claude wrote a plan and changed nothing. Now the hub stores `'full'` for that pair, and the poller runs it full ONLY with a valid signature, lane name = the workspace (`bakbukim`), key `repo-jobs/bakbukim.pub.pem` (bakbukim signs both lanes with the same private key; the lane line in the signed message keeps a signature for one lane from being replayed in the other). Unsigned or bad: the row is answered and failed, never downgraded to a silent read-only run.

## Refusals are answered

The hub fires the caller's `callback_url` only on an answer, never on a bare `failed` status. So a repo job that is refused (signature, missing repo folder) or fails before it answers, and a refused signed row, now post a short answer, ```` ```json {"status":"failed","summary":"המחשב בסטודיו לא הריץ את המשימה: <why>"} ``` ```` and then the `failed` status. Without it the caller's screen showed "waiting" forever.

## On the bridge machine, once

1. Pull claude-bridge (`dev`) and restart the poller. The startup line now ends with `repo-jobs=[bakbukim-tasks→bakbukim@dev:240m from [bakbukim-owner-task]] signed-full=[bakbukim:bakbukim-manager-execute]`.
2. If `.env` sets `WORKSPACE_ALLOWLIST` or `SOURCE_ALLOWLIST`, add `bakbukim-tasks`, `bakbukim-owner-task` and `bakbukim-manager-execute` to them.
3. The bakbukim checkout under `PROJECT_DIRS` must be a git clone with `node_modules` installed and a GitHub login that can push to it (`gh auth status`).
4. Check that a print run may use full permissions: `claude -p --permission-mode bypassPermissions "reply with the word ok"`.
