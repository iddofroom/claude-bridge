# Repo lanes — setup

The owner, 2026-10-03: from the phone menu of bakbukim ("משימות לקלוד") he dictates or types a task, and Claude on this machine carries it out in the bakbukim project. Such a task can take an hour, so it must not run in the one-at-a-time queue, where it would hold up the CS drafts and manager triage behind it. It runs in a lane of its own, the same machinery as the jobs lane (`../jobs/README.md`), with one difference: a פינגו job starts from an empty folder, while a repo job has to work inside an existing project.

## What a repo job gets

- A fresh git worktree of the project, cut from `origin/<base>` right before the run, at `<repo>\.claude\worktrees\studio-<date>-<id>`, on branch `task/studio-<date>-<id>`. Running inside the project is what makes its `CLAUDE.md`, `AGENTS.md`, skills and `node_modules` (resolved upward from the worktree) apply.
- `--permission-mode bypassPermissions`, every built-in tool, no MCP servers (`--strict-mcp-config`), and `repo-jobs/rules.md` appended to the system prompt.
- A folder for `RESULT.md` / `RESULT.json` OUTSIDE the worktree (`%TEMP%\bridge-repo-jobs\<date>-<id>`), named at the end of the prompt. Inside the project, a run that stages with `git add -A` would commit them.
- The jobs lane's stop rules: stopped after `JOBS_IDLE_MINUTES` without writing anything in the worktree, or at the lane's minutes as a backstop. A stopped run is still answered from `RESULT.json`, or from `RESULT.md`.
- When the run ends, `git worktree remove` WITHOUT `--force`: a worktree that still holds uncommitted work is kept, and the log says so. Branches are left alone.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `REPO_JOBS` | `bakbukim-tasks:bakbukim:dev:240` | `lane:repo folder:base branch:minutes`, comma-separated |
| `REPO_JOBS_SOURCES` | `bakbukim-tasks=bakbukim-owner-task` | `lane=source[\|source…]`, comma-separated |

Fail-closed, like every job lane: a repo lane runs only rows with `permission_mode='full'` from its own sources; those sources are failed in every other workspace; פינגו's sources cannot reach a repo lane. The hub stores `'full'` only for the workspaces it allows that for (iddofroom `app/api/copilot/external/prompt`); everything else arrives with no mode, which this poller treats as read-only.

## On the bridge machine, once

1. Pull claude-bridge (`dev`) and restart the poller. The startup line now ends with `repo-jobs=[bakbukim-tasks→bakbukim@dev:240m from [bakbukim-owner-task]]`.
2. If `.env` sets `WORKSPACE_ALLOWLIST` or `SOURCE_ALLOWLIST`, add `bakbukim-tasks` and `bakbukim-owner-task` to them.
3. The bakbukim checkout under `PROJECT_DIRS` must be a git clone with `node_modules` installed and a GitHub login that can push to it (`gh auth status`).
4. Check that a print run may use full permissions: `claude -p --permission-mode bypassPermissions "reply with the word ok"`.
