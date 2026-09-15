# Jobs lane — setup

The owner's voice assistant (פינגו, MASK `features/claude_jobs`) sends Claude on long jobs through the hub route `/api/copilot/pingo/jobs`: research, or building a new app or site. The poller runs those rows in its jobs lane (`ccgram-poller.mjs`, the `JOBS_*` settings), beside its one-at-a-time queue, so a browser request never waits behind a long job.

## On the bridge machine, once

1. Pull claude-bridge (`dev`) and restart the poller: the lane is poller code. Its startup line now ends with `jobs=[pingo-research:30m,pingo-build:90m]×1 from [pingo-jobs]`.
2. Create the two workspace folders under `PROJECT_DIRS`: `C:\websites\pingo-research` and `C:\websites\pingo-build`. They need no git. Every job gets its own subfolder, named `<date>-<first 8 characters of the outbox id>`.
3. For builds, `gh auth status` and `netlify status` must both show a login: a build creates a private GitHub repo and a Netlify site.
4. Check that a print run may use full permissions: `claude -p --permission-mode bypassPermissions "reply with the word ok"`. If a setting disables bypass mode, every job fails with that message.
5. For research pages: a print run can publish a claude.ai artifact only if this machine's Claude login offers the Artifact tool. Without it, the report goes in the mail instead.

## What a job gets

- פינגו's prompt, with the time limit appended.
- `--permission-mode bypassPermissions`, every built-in tool, no MCP servers (`--strict-mcp-config`), and `jobs/rules.md` appended to the system prompt.
- A hard time limit per workspace (`JOBS_WORKSPACES`; defaults: research 30 minutes, build 90). On timeout the whole process tree is killed, and the job folder's `RESULT.md` is posted as the answer: `{"timed_out": true, "minutes": N, "report": "..."}`.

## Safety

These runs have full permissions on this machine. The only ways in:

- the hub route, with its own secret;
- the checks here, which fail closed: a job workspace runs only `full` rows from `JOBS_SOURCES`, and a job source is refused in every other workspace.

The hub's external API refuses the job workspaces.
