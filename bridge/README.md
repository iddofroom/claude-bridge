# claude-bridge — bridge process

Tiny Node script that ferries prompts from the deployed web app to your local
Claude Code installation.

See [../BRIDGE.md](../BRIDGE.md) at the repo root for the full setup guide,
including running this as a Windows / macOS / Linux service and exposing it
through a Cloudflare Tunnel.

## Quick start

```bash
npm install
cp .env.example .env
# edit .env — fill BRIDGE_SECRET, WEB_APP_URL, PROJECT_DIRS
node server.js
```

Listens on `http://localhost:7777`. Bind is hard-coded to `127.0.0.1` — never
exposes itself directly to the network. Use a tunnel.

## What it does

1. `POST /inject` — receives a queued prompt from the web app.
2. Runs `claude --print` in the matching workspace folder (resolved by
   walking `PROJECT_DIRS`).
3. POSTs Claude's reply back to `${WEB_APP_URL}/api/webhooks/bridge`.
4. PATCHes the outbox row to `sent` (or `failed`).
5. On startup: runs a one-shot catchup pass against any queued rows so
   nothing is lost if the bridge was offline.

Endpoints exposed by this server:

- `GET  /health` — liveness check, returns `{ "ok": true }`.
- `POST /inject` — entry point from the web app, requires `x-bridge-secret`.

## Environment

See `.env.example`. Required: `BRIDGE_SECRET`, `WEB_APP_URL`. Optional:
`BRIDGE_PORT` (default 7777), `CLAUDE_CLI_PATH` (default `claude`),
`PROJECT_DIRS` (default `process.cwd()`), `BRIDGE_CATCHUP` (default `true`).
