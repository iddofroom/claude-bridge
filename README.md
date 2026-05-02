# claude-bridge

Remote-control your Claude Code session through a deployed Next.js admin UI.
Compose prompts in a browser, schedule them, or let other apps push them in
through an HTTP API — they all hit a `claude --print` running on your
machine.

```
  external app ──► Next.js + Postgres ──► bridge (your machine) ──► claude --print
                       │  ▲                       ▲   │
                       │  └─── response ──────────┘   ▼
                       └──── callback ────────► your URL
```

## Quickstart

```bash
git clone https://github.com/iddofroom/claude-bridge.git
cd claude-bridge && npm install

# Provision a Postgres DB (e.g. neon.tech). Generate three secrets:
openssl rand -hex 32   # ADMIN_TOKEN, BRIDGE_SECRET, EXTERNAL_API_SECRET

cp .env.example .env.local   # fill in DATABASE_URL + the three secrets + CRON_SECRET
npm run db:migrate
npm run dev                  # localhost:3000 → /login
```

Then bring up the bridge on the machine where `claude` is installed —
see **[BRIDGE.md](BRIDGE.md)**. ~5 minutes.

## Endpoints

| Path | Auth |
| --- | --- |
| `/admin/claude-bot`, `/admin/claude-bot/scheduled` | `ADMIN_TOKEN` cookie |
| `POST /api/external/prompt`, `GET /api/external/messages` | `x-external-secret` |
| `POST /api/qa-assistant` | `Bearer EXTERNAL_API_SECRET` |
| `*/api/webhooks/bridge` | `x-bridge-secret` |
| `GET /api/cron/scheduled-tasks` | `CRON_SECRET` |

## Docs

- **[BRIDGE.md](BRIDGE.md)** — set up the bridge process.
- **[INTEGRATE.md](INTEGRATE.md)** — wire another app to send prompts.
- **[PROTOCOL.md](PROTOCOL.md)** — full wire spec.

## Deploy

`netlify.toml` ships ready. Works on any Next.js host. Set every env var from
`.env.example`, run `npm run db:migrate` against prod, point an external cron
service at `/api/cron/scheduled-tasks?secret=$CRON_SECRET` (the repo doesn't
ship `vercel.json` — bring your own scheduler).

## Security

- Three independent secrets. Rotate any one without touching the others.
- The bridge binds to `127.0.0.1`. Expose it only through a tunnel
  (Cloudflare Tunnel / ngrok / Tailscale). Never `0.0.0.0`.
- Anyone with `EXTERNAL_API_SECRET` can run arbitrary prompts in your Claude
  session. Treat it like an SSH key.

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution.
