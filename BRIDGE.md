# Bridge setup

⚠️ **This doc describes the legacy `server.js` (push-to-`/inject`) setup.**
The machine currently in production runs **[`bridge/ccgram-poller.mjs`](bridge/ccgram-poller.mjs)**
instead — a WebSocket-doorbell client with no open port/tunnel needed at all
(see the file's own header comment for its protocol and env vars). `server.js`
was confirmed killed/unused there 2026-09-04. Everything below (setup,
`/inject`, port 7777, Cloudflare Tunnel) is `server.js`-specific and does NOT
apply to the poller — kept here for reference only. Before touching bridge
infra, check which process is ACTUALLY running on the target machine rather
than assuming from this doc.

The bridge is a ~150-line Node script in [`bridge/`](bridge/) that runs on
your machine, receives prompts from the deployed web app, and pipes them into
`claude --print`.

## Prereqs

- Node 20+ and Claude Code CLI on PATH (`claude --version` must work).
- The web app deployed somewhere reachable, with the DB migrated.

## Setup

```bash
cd bridge
npm install
cp .env.example .env       # edit: BRIDGE_SECRET, WEB_APP_URL, PROJECT_DIRS
node server.js
```

Expected output:

```
[bridge] listening on http://localhost:7777
[bridge] dashboard: https://your-app.example.com
[bridge] catchup: no queued items.
```

## Expose port 7777

The web app's `BRIDGE_PUSH_URL` must reach this process. Cloudflare Tunnel is
the easy choice (free, stable URL):

```bash
cloudflared tunnel --url http://localhost:7777
```

Set the resulting `*.trycloudflare.com` URL as `BRIDGE_PUSH_URL` on the host.
Alternatives: `ngrok http 7777`, Tailscale, anything that proxies HTTP.

If you skip this, the bridge falls back to a startup polling pass — slower,
but still works.

## Test

In `/admin/claude-bot`, send `say hi in 2 words` to any workspace name. The
bridge log should show `inject → ... → done` within ~10 seconds and the
thread should update with Claude's reply.

## Workspaces

`PROJECT_DIRS` is a comma-separated list of base directories. A prompt with
`workspace=my-app` gets resolved to the first existing `<base>/my-app`. If
none exist, `<first-base>/my-app` is created.

## Run as a service

You don't want to babysit a terminal. Pick what fits.

**systemd** (Linux):

```ini
# /etc/systemd/system/claude-bridge.service
[Service]
WorkingDirectory=/home/me/claude-bridge/bridge
ExecStart=/usr/bin/node server.js
EnvironmentFile=/home/me/claude-bridge/bridge/.env
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now claude-bridge
journalctl -u claude-bridge -f
```

**Windows**: install [NSSM](https://nssm.cc), `nssm install ClaudeBridge node.exe server.js`,
set `AppDirectory` and env vars in the GUI, start the service.

**macOS**: `launchd` plist with `KeepAlive=true`. See `man launchd.plist`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `inbox post failed: 401` | `BRIDGE_SECRET` doesn't match between bridge and web app. |
| `claude exited 1: ...` | Claude CLI itself failed — run the same prompt manually in that workspace to debug. |
| Bridge never receives `/inject` | `BRIDGE_PUSH_URL` doesn't reach this machine. `curl https://<tunnel>/health` from elsewhere. |
| Prompts queue but nothing fires | Bridge is down. Catchup runs on next start. |
| Wrong workspace folder | `PROJECT_DIRS` order matters; first match wins. |
| `git pull failed` in the log | Workspace has diverged/uncommitted local changes — the bridge always runs `git pull --ff-only` before invoking Claude (see [`bridge/README.md`](bridge/README.md)) and never force-syncs, so it just warns and runs against the existing checkout. Clean up the workspace by hand, or set `BRIDGE_GIT_SYNC=false` to stop trying. |

## Keeping a workspace checkout fresh

Each `PROJECT_DIRS/<workspace>` folder should be a normal git clone tracking
whatever branch you want Claude to see (usually the repo's active dev
branch). The bridge runs a best-effort `git pull --ff-only` in it before
every prompt (`BRIDGE_GIT_SYNC`, default on) — without this, Claude would
only ever see whatever was last pulled there by hand, and could re-suggest
work that's already shipped (or already deliberately rejected) on your real
dev machine. Set the workspace's upstream once (`git branch --set-upstream-to`)
and the bridge keeps it current automatically from then on.
