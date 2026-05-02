# claude-bridge

Remote-control your Claude Code session from anywhere.

You run **Claude Code** on one machine (a desktop, a home server, anything that
keeps a long-lived shell). You deploy this Next.js app somewhere with a public
URL. The two halves talk through a Postgres outbox + a tiny bridge process,
so:

- You can compose prompts in a web dashboard and they show up in Claude as if
  you had typed them locally.
- You can schedule prompts to fire daily / weekly / monthly / once.
- Other apps you own can POST a prompt through a shared-secret API and get the
  response back via webhook callback or polling.
- A QA Chrome extension can submit a bug report (with screenshot + console
  log) and watch Claude work on it.

## Architecture

```
  ┌──────────────┐   POST prompt    ┌──────────────────┐   spawn        ┌──────────────┐
  │ external app │ ───────────────► │  Next.js +       │ ─ inject ────► │ bridge       │ ─► claude --print
  │  /  admin UI │ ◄─── callback ── │  Postgres outbox │ ◄─ catchup ─── │ (your home)  │ ◄─ stdout
  └──────────────┘                  └──────────────────┘                └──────────────┘
```

Three independent pieces:

1. **Web app** (this repo's root) — Next.js admin UI + REST endpoints, auth
   gated by a single `ADMIN_TOKEN`. Runs on Netlify, Vercel, or anywhere that
   speaks Node.
2. **Postgres** — Neon works out of the box. Four tables (threads / outbox /
   inbox / scheduled\_tasks).
3. **Bridge** ([`bridge/`](bridge/)) — tiny Node script that runs on the
   machine where Claude Code is installed. Receives prompts, runs
   `claude --print` in the right workspace folder, posts the answer back.

## Quickstart (~15 minutes)

```bash
git clone https://github.com/iddofroom/claude-bridge.git
cd claude-bridge
npm install

# 1. Provision a Postgres DB (e.g. on neon.tech) and grab the connection string.
# 2. Generate three random secrets:
openssl rand -hex 32   # ADMIN_TOKEN
openssl rand -hex 32   # BRIDGE_SECRET
openssl rand -hex 32   # EXTERNAL_API_SECRET (and CRON_SECRET — can be the same value)

cp .env.example .env.local
# Fill in DATABASE_URL, ADMIN_TOKEN, BRIDGE_SECRET, EXTERNAL_API_SECRET, CRON_SECRET.

npm run db:migrate
npm run dev          # http://localhost:3000 → /login → enter ADMIN_TOKEN
```

Then set up the bridge — see [BRIDGE.md](BRIDGE.md). Five-minute job: install
deps, copy the same `BRIDGE_SECRET`, run `node server.js`, expose port 7777
through a Cloudflare Tunnel.

## Documentation

| File | What it covers |
| --- | --- |
| [BRIDGE.md](BRIDGE.md) | Setting up the home-machine bridge, including running it as a service. |
| [INTEGRATE.md](INTEGRATE.md) | How to wire your other apps into this one — TypeScript + Python examples. |
| [PROTOCOL.md](PROTOCOL.md) | Full wire-protocol spec for anyone reimplementing the bridge in another language. |
| `/admin/claude-bot/guide` | A condensed in-app version of the integration guide. |

## What's running on each side?

Web app endpoints:

| Path | Purpose | Auth |
| --- | --- | --- |
| `/admin/claude-bot` | Web UI — compose prompts, see threads. | `ADMIN_TOKEN` cookie |
| `/admin/claude-bot/scheduled` | CRUD for scheduled prompts. | `ADMIN_TOKEN` cookie |
| `POST /api/external/prompt` | Submit a prompt from another app. | `EXTERNAL_API_SECRET` |
| `GET /api/external/messages` | Poll the prompt + response feed. | `EXTERNAL_API_SECRET` |
| `POST /api/qa-assistant` | Bug-report intake from a QA browser extension. | `Bearer EXTERNAL_API_SECRET` |
| `*/api/webhooks/bridge` | Bridge ↔ web app — POST inbox, GET queued, PATCH status. | `BRIDGE_SECRET` |
| `GET /api/cron/scheduled-tasks` | Fire any scheduled tasks whose time has come. | `CRON_SECRET` |

## Deployment

Default target is **Netlify** (`netlify.toml` is included; auto-detected
`@netlify/plugin-nextjs`). It works on Vercel, Render, Fly, etc. — anywhere
that runs Next.js. There's no `vercel.json` because scheduled tasks are
triggered by an **external** cron service hitting `/api/cron/scheduled-tasks`,
not Vercel cron.

Set every env var from `.env.example` in your hosting provider's panel. Run
`npm run db:migrate` once against the production DB.

## Security

- The web app **only** authenticates via three secrets. Lose one, rotate it.
- The bridge listens on `127.0.0.1` by default. Expose it to the internet only
  through a tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel) — never bind
  to `0.0.0.0`.
- Anyone with `EXTERNAL_API_SECRET` can run arbitrary prompts in your Claude
  session. Treat it like an SSH key.
- `claude --print` runs with the bridge process's permissions. Don't run the
  bridge as root.

## License

MIT — see [LICENSE](LICENSE). Attribution to upstream projects in [NOTICE](NOTICE).
