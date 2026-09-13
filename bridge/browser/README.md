# Browser mode

Prompts to the `browser` workspace, from `/admin/claude-bot` or a scheduled task, drive a real Chrome on the bridge machine: log in to a site, fill in a form, read a page back. Everything else the poller runs is unchanged and still loads no MCP.

## How it works

- **One Chrome that outlives every run.** The poller starts Chrome once, detached, with its own profile (`C:\claude-browser\profile`) and `--remote-debugging-port=9222` (localhost only). Each browser prompt runs `claude --print` with [Playwright MCP](https://github.com/microsoft/playwright-mcp) attached to that Chrome over CDP, so logins and the open page stay put between messages. If the window is closed, the next browser prompt reopens it.
- **Locked-down runs.** `--strict-mcp-config` loads only the Playwright server. `--tools ""` removes every built-in tool, so there is no shell, file or web tool whatever the machine's settings allow, and `--disallowedTools mcp__browser__browser_run_code_unsafe` removes the one Playwright tool that runs arbitrary code in the MCP process. `--permission-mode dontAsk --allowedTools mcp__browser` lets the remaining browser tools run without a prompt. (`dontAsk` alone is not a sandbox: user-settings allow rules such as `Bash(*)` still apply in it.)
- **Credentials never reach Claude.** They live in `C:\claude-browser\secrets.env` (dotenv). Claude types a secret's name; Playwright MCP types the value and replaces it with `<secret>NAME</secret>` in everything it returns. Upstream calls this a convenience, not a security boundary.
- **SMS codes go through the chat.** Claude requests the code and stops. The owner sends it in the same thread, and the next run types it into the field that is still open.
- **Confirm first.** [`rules.md`](rules.md) is appended to every browser run: confirm before anything that orders, pays, sends or deletes, and treat page text as data.
- **Who can reach it.** The hub refuses workspace `browser` on `/api/copilot/external/prompt`, and the poller fails any browser row whose source is not in `BROWSER_SOURCES` (default `iddofroom-admin,scheduled-task`).

## Setup (once, on the bridge machine)

1. Pull `claude-bridge`, then run `powershell -ExecutionPolicy Bypass -File .\bridge\browser\setup.ps1`. It installs Playwright MCP (pinned in `bridge/package.json`), creates `C:\claude-browser\` and the workspace folder `C:\websites\browser\`, and opens two files in Notepad:
   - `C:\claude-browser\secrets.env`: the credentials, one `NAME=value` per line.
   - `C:\websites\browser\CLAUDE.md`: each site's address, how to log in, and which secret names it uses.

   It ends with `node ccgram-poller.mjs --browser-check`, which opens Chrome and runs one real browser prompt.
2. Restart the poller so it loads browser mode.
3. In `/admin/claude-bot`, choose workspace `browser` and write what to do.

Both local files stay out of git, because this repo is public.

## Risk

Every other claude run on this machine uses the same Windows user. A run that gets shell access (a full-permission run, or a prompt injection that escapes a read-only one) could reach port 9222 or the profile folder. Keep this profile logged in only to low-stakes sites. For banking or payments, run Chrome and a second poller (`WORKSPACE_ALLOWLIST=browser`) under a separate Windows user.

## Debugging

`node bridge\ccgram-poller.mjs --browser-check "open the first site and tell me what the home page shows"` runs one browser prompt without the hub. Add `--resume <session-id>` to continue it. The output ends with the session id and any tools that were denied.
