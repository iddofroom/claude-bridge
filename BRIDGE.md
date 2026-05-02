# Bridge setup

The bridge is the half of the system that lives on **your machine** —
specifically the machine where `claude` (Claude Code CLI) is installed and
authenticated. It's a ~150-line Node script in [`bridge/`](bridge/) that:

1. Listens on `localhost:7777` for `POST /inject` calls from the web app.
2. Spawns `claude --print` in the workspace folder you specified, pipes the
   prompt into stdin, captures stdout.
3. Posts the response back to `${WEB_APP_URL}/api/webhooks/bridge`.
4. Falls back to polling the same endpoint every restart, so anything queued
   while the bridge was offline still gets processed.

## Prerequisites

- **Node.js 20+** on PATH.
- **Claude Code CLI** installed and signed in. Test with `claude --version`.
- The web app deployed somewhere with a public URL, and a Postgres DB it can
  reach.

## Steps

### 1. Install bridge dependencies

```bash
cd bridge
npm install
```

### 2. Configure

Copy the example env file:

```bash
cp .env.example .env
```

Edit `bridge/.env`:

```
BRIDGE_SECRET=<same value you set in the web app>
WEB_APP_URL=https://your-deployed-bridge.example.com
PROJECT_DIRS=C:\projects,/home/me/code   # comma-separated; see "Workspaces" below
BRIDGE_PORT=7777                          # default; override only if 7777 is taken
CLAUDE_CLI_PATH=claude                    # path to the claude binary if not on PATH
```

### 3. Run

```bash
node server.js
```

You should see:

```
[bridge] listening on http://localhost:7777
[bridge] dashboard: https://your-deployed-bridge.example.com
[bridge] project dirs: C:\projects, /home/me/code
[bridge] catchup: no queued items.
```

The startup catchup is intentional — if anything queued up while the bridge
was down, it gets processed before the bridge starts accepting fresh injects.

### 4. Expose port 7777 to the web app

The web app's `BRIDGE_PUSH_URL` env var must point to a URL that reaches your
bridge. Pick one:

- **Cloudflare Tunnel** (recommended; free, stable URL):
  ```bash
  cloudflared tunnel --url http://localhost:7777
  ```
  Copy the `*.trycloudflare.com` URL it prints, set it as `BRIDGE_PUSH_URL`
  in your hosting provider.
- **ngrok**: `ngrok http 7777` → use the resulting URL.
- **Tailscale**: works but only if the web app is also on the tailnet.

If you skip this step entirely, the system still works — the web app can't
do the fast push, and the bridge falls back to its polling loop on startup
+ on demand. Most users want the push path, so do it.

### 5. Test end-to-end

Open the deployed web app, sign in with `ADMIN_TOKEN`, click **+ New thread**,
type any workspace name and a prompt like `say hi in 2 words`, hit **Send**.
Within ~10 seconds:

- The bridge log shows `inject → ... → done`.
- The thread updates with Claude's reply.
- DB rows: `claude_outbox.status = 'sent'`, a new row in `claude_inbox`
  with the same `thread_id`.

### Workspaces

`PROJECT_DIRS` is a comma-separated list of base directories. When the web app
sends a prompt with `workspace: "my-app"`, the bridge looks for `my-app`
inside each base directory in order:

```
PROJECT_DIRS=C:\projects,C:\work
workspace=my-app
→ tries C:\projects\my-app, then C:\work\my-app
→ if neither exists, creates C:\projects\my-app
```

## Running it as a service

You don't want to keep a terminal open forever. Pick the OS-appropriate
option:

### Windows (NSSM)

[Download NSSM](https://nssm.cc/download), then:

```powershell
nssm install ClaudeBridge "C:\Program Files\nodejs\node.exe" "C:\path\to\claude-bridge\bridge\server.js"
nssm set ClaudeBridge AppDirectory "C:\path\to\claude-bridge\bridge"
nssm set ClaudeBridge AppEnvironmentExtra "BRIDGE_SECRET=..." "WEB_APP_URL=..." "PROJECT_DIRS=..."
nssm start ClaudeBridge
```

### macOS (launchd)

Save as `~/Library/LaunchAgents/com.user.claude-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.user.claude-bridge</string>
  <key>WorkingDirectory</key> <string>/Users/me/claude-bridge/bridge</string>
  <key>ProgramArguments</key> <array>
    <string>/usr/local/bin/node</string>
    <string>server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_SECRET</key> <string>...</string>
    <key>WEB_APP_URL</key>   <string>...</string>
    <key>PROJECT_DIRS</key>  <string>/Users/me/code</string>
  </dict>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.user.claude-bridge.plist
```

### Linux (systemd)

Save as `/etc/systemd/system/claude-bridge.service` (or `~/.config/systemd/user/...`):

```ini
[Unit]
Description=claude-bridge
After=network.target

[Service]
WorkingDirectory=/home/me/claude-bridge/bridge
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/me/claude-bridge/bridge/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-bridge
journalctl -u claude-bridge -f
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `[bridge] inbox post failed: 401` | `BRIDGE_SECRET` doesn't match between bridge and web app. |
| `claude exited 1: Error: ...` | The Claude CLI itself failed. Run the same prompt manually in that workspace folder to see why. |
| Bridge never receives `/inject` | `BRIDGE_PUSH_URL` in the web app's env doesn't reach this machine. Try `curl https://<your-tunnel>/health` from elsewhere. |
| Prompts queue but nothing fires | Bridge is down. Once you start it, the catchup pass handles them. |
| Wrong workspace folder used | Adjust `PROJECT_DIRS` order; first match wins. |
