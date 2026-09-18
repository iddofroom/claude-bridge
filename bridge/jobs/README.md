# Jobs lane — setup

The owner's voice assistant (פינגו, MASK `features/claude_jobs`) sends Claude on long jobs through the hub route `/api/copilot/pingo/jobs`: research, or building a new app or site. The poller runs those rows in its jobs lane (`ccgram-poller.mjs`, the `JOBS_*` settings), beside its one-at-a-time queue, so a browser request never waits behind a long job.

## On the bridge machine, once

1. Pull claude-bridge (`dev`) and restart the poller: the lane is poller code. Its startup line now ends with `jobs=[pingo-research:30m,pingo-build:90m,pingo-self:120m]×1 each from [pingo-jobs]`.
2. Create the two workspace folders under `PROJECT_DIRS`: `C:\websites\pingo-research` and `C:\websites\pingo-build`. They need no git. Every job gets its own subfolder, named `<date>-<first 8 characters of the outbox id>`.
3. For builds, `gh auth status` and `netlify status` must both show a login: a build creates a private GitHub repo and a Netlify site.
4. Check that a print run may use full permissions: `claude -p --permission-mode bypassPermissions "reply with the word ok"`. If a setting disables bypass mode, every job fails with that message.
5. For research pages: a print run can publish a claude.ai artifact only if this machine's Claude login offers the Artifact tool. Without it, the report goes in the mail instead.

## What a job gets

- פינגו's prompt, with the time limit appended.
- `--permission-mode bypassPermissions`, every built-in tool, no MCP servers (`--strict-mcp-config`), and `jobs/rules.md` appended to the system prompt.
- A time limit per workspace (`JOBS_WORKSPACES`; defaults: research 30 minutes, build 90, self 120) — now only the **absolute backstop**, see below.

## What stops a run, and what it still answers

The owner, 2026-09-18: "צריך להוריד את המגבלה של הזמן - ושהיא תסתיים." A run used to be killed by the clock alone. That day a job pushed its work at 15:44, never exited, and was killed on the 120-minute cap at 17:23 — and פינגו told him his change "did not finish in time" about a change that was already merged into `dev`. Two things changed:

- **The clock is on doing nothing, not on the work.** `JOBS_IDLE_MINUTES` (default 25) stops a run that has written nothing anywhere in its job folder for that long — hung, not slow. A working run touches disk constantly (the files it edits, git's index, pytest's and mypy's caches), so a slow job is left alone however long it takes. `JOBS_WORKSPACES`' minutes remain as a backstop so a wedged lane cannot stay wedged for ever; raise them freely now that they no longer cut work short.
- **A stopped run still answers.** Both rules files tell a job to write its final JSON to `RESULT.json` the moment it has one — right after the push, before it composes its last message. If that file is there and parses, it *is* the answer, killed or not, and the device installs the work normally. Only when it is absent does the poller fall back to `{"timed_out": true, "minutes": N, "stopped": "...", "report": <RESULT.md>}`.

## One lane per workspace

`JOBS_PARALLEL` (default 1) is counted **per workspace**, not across all of them (the owner, 2026-09-18). A 90-minute build and a 120-minute change to the assistant's own code therefore no longer wait on each other; before this, one queue served all three and a build could hold up a dictated change for over half an hour.

Within one workspace the rows still run strictly one after another, and `pingo-self` depends on that: each of its jobs is told to start from the commit the device is running, so two at once would both be written against a version the first of them is about to replace. Raise `JOBS_PARALLEL` only if every lane can take it.

## Safety

These runs have full permissions on this machine. The only ways in:

- the hub route, with its own secret;
- the checks here, which fail closed: a job workspace runs only `full` rows from `JOBS_SOURCES`, and a job source is refused in every other workspace.

The hub's external API refuses the job workspaces.
