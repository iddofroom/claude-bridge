# Self lane — setup (פינגו changes its own code)

The owner asked (2026-09-17) that פינגו be programmed through פינגו: he dictates a task by voice, Claude on this machine writes the code, and the device installs the new version itself. Once a day פינגו also sends a job of its own, grounded in the failures in its logs, and mails him what it built and a few fresh ideas.

The lane is the jobs lane with its own workspace, `pingo-self` (120 minutes), its own rules file (`self/rules.md`) and its own repo. Everything else — the hub route `/api/copilot/pingo/jobs`, the secret, the fail-closed checks — is shared with research and build jobs (`../jobs/README.md`).

## On the bridge machine, once

1. Pull claude-bridge (`dev`) and restart the poller. Its startup line must now end with `jobs=[pingo-research:30m,pingo-build:90m,pingo-self:120m]×1 from [pingo-jobs]`.
2. Create the workspace folder `C:\websites\pingo-self` (under `PROJECT_DIRS`). Each job still runs in its own `<date>-<id>` subfolder of it, which is where `RESULT.md` goes.
3. Clone the assistant's own (private) repo **inside that folder**, as `mask`:
   ```
   gh repo clone <owner>/<assistant repo> C:\websites\pingo-self\mask
   ```
   The repo's name is in the setup prompt the owner hands this machine — this repo is public, so it
   is not written here. `gh auth status` must show a login that can push to it: the runs push a
   branch and `dev`.
4. Give that clone a venv with the gates in it — the gates are what decides whether a change ever reaches the device:
   ```
   cd C:\websites\pingo-self\mask
   py -3.12 -m venv .venv
   .venv\Scripts\python -m pip install -q -e . ruff mypy pytest types-PyYAML tzdata
   ```
   Python 3.12 matters: numpy's stubs abort mypy on older versions.
5. Check the four gates run and only the known platform failures appear (`self/rules.md` lists them: `test_leds_area`, the TTS timing test, and the Linux-only mypy errors).
6. Set `git config user.name` / `user.email` in that clone if they are not set globally, or the commits fail.

Nothing else is needed: the device pulls from GitHub by itself and never lets this machine reach it.

## What a self job gets

- פינגו's prompt: the task in the owner's words (or the day's failure digest), the branch to create, and the exact commit the device is running as its base.
- `--permission-mode bypassPermissions`, the built-in tools, no MCP servers, and `self/rules.md` appended to the system prompt.
- 120 minutes. On timeout the tree is killed and `RESULT.md` is posted, so a half-finished run still reports — but a half-finished commit is simply never installed: the device installs a commit that passes its own guard and gates, or nothing.

## What keeps this safe

The device, not this machine, decides what runs on it (`MASK deploy/self_update.py`, installed outside the repo):

- a denied-path list (`.env`, `data/`, `deploy/`, `.github/`, `pyproject.toml`) — so a job cannot add a dependency, touch a secret or edit the guard;
- size caps, and the owner's explicit word for anything bigger or for what פינגו thought of by itself;
- the full gates again, in a clone of its own, before anything is installed;
- a health check after the restart, and a rollback to the previous commit when the new version does not come up.

So the worst a bad run here can do is waste its own time.
