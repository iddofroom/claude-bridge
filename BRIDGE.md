# Bridge setup

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
