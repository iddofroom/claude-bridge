# Integrating other apps with claude-bridge

Use this guide when you have an app — a website, a Slack bot, a CLI, a GitHub
Action — and you want it to push prompts into your home Claude session and
receive the responses.

## What you need

- A running claude-bridge install (web app + bridge).
- The web app's public URL — call it `$BRIDGE_URL`.
- Its `EXTERNAL_API_SECRET` — call it `$BRIDGE_SECRET`.

Both belong on **your server**, never in browser code.

## The shape

There's exactly one outgoing request and two ways to receive the response.

### Submit a prompt

```http
POST $BRIDGE_URL/api/external/prompt
Content-Type: application/json
x-external-secret: $BRIDGE_SECRET

{
  "workspace":     "my-app",                    // folder on the home machine
  "prompt":        "Summarize today's commits.",
  "source":        "my-app",                    // identifier for your app
  "external_ref":  "req-2026-04-30-abcd1234",   // your correlation id (optional)
  "callback_url":  "https://my-app.com/api/claude-callback",  // optional
  "title":         "Daily summary",              // optional
  "source_site":   "my-app",                    // optional
  "source_bug_id": "1428"                        // optional
}
```

Response:

```json
{
  "ok": true,
  "outbox_id":    "8c12...",
  "thread_id":    "9b34...",
  "external_ref": "req-2026-04-30-abcd1234",
  "status":       "queued",
  "created_at":   "2026-04-30T08:15:32.821Z"
}
```

The prompt is now queued. The bridge picks it up within seconds, runs Claude,
posts the answer back.

### Receive the answer

#### Option A — callback (preferred)

Set `callback_url` in the submit request. When the response arrives, the web
app POSTs your URL with header `x-external-secret: $BRIDGE_SECRET` and body:

```json
{
  "inbox_id":          "f1aa...",
  "workspace":         "my-app",
  "source":            "my-app",
  "external_ref":      "req-2026-04-30-abcd1234",
  "response":          "Today: 4 commits, 2 PRs merged. ...",
  "claude_session_id": "abc123",
  "created_at":        "2026-04-30T08:16:11.904Z",
  "conversation_id":   null
}
```

#### Option B — polling

Skip `callback_url` and poll instead:

```http
GET $BRIDGE_URL/api/external/messages?source=my-app&external_ref=req-2026-04-30-abcd1234
x-external-secret: $BRIDGE_SECRET
```

Returns the prompt + response (when it exists) interleaved by timestamp:

```json
{
  "items": [
    { "kind": "prompt",   "content": "Summarize...", "status": "sent",   "created_at": "..." },
    { "kind": "response", "content": "Today: 4 commits...",                "created_at": "..." }
  ]
}
```

Poll every few seconds. Prompts complete in ~2-30 seconds depending on what
you ask Claude to do.

## TypeScript / Next.js

Drop these two files into your app:

```ts
// lib/claude-remote.ts
const BASE = process.env.CLAUDE_BRIDGE_URL!;
const SECRET = process.env.CLAUDE_BRIDGE_SECRET!;
const SOURCE = "my-app";

export type SubmitOpts = {
  workspace: string;
  prompt: string;
  externalRef?: string;
  callbackUrl?: string;
  title?: string;
};

export async function submitPrompt(opts: SubmitOpts) {
  const externalRef = opts.externalRef ?? crypto.randomUUID();
  const res = await fetch(`${BASE}/api/external/prompt`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-external-secret": SECRET,
    },
    body: JSON.stringify({
      workspace:    opts.workspace,
      prompt:       opts.prompt,
      source:       SOURCE,
      external_ref: externalRef,
      callback_url: opts.callbackUrl,
      title:        opts.title,
    }),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{
    ok: true;
    outbox_id: string;
    external_ref: string;
    thread_id: string;
    status: string;
    created_at: string;
  }>;
}

export async function pollMessages(externalRef: string) {
  const url = new URL(`${BASE}/api/external/messages`);
  url.searchParams.set("source", SOURCE);
  url.searchParams.set("external_ref", externalRef);
  const res = await fetch(url, {
    headers: { "x-external-secret": SECRET },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  return res.json() as Promise<{
    items: Array<{
      kind: "prompt" | "response";
      content: string;
      created_at: string;
      status?: string;
    }>;
  }>;
}
```

```ts
// app/api/claude-callback/route.ts
import { NextResponse } from "next/server";
// import { sql } from "@/lib/your-db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = req.headers.get("x-external-secret");
  if (secret !== process.env.CLAUDE_BRIDGE_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  // body.external_ref is your correlation id; persist body.response to your DB.
  // await sql`UPDATE my_requests SET response = ${body.response}, responded_at = NOW() WHERE external_ref = ${body.external_ref}`;
  return NextResponse.json({ ok: true });
}
```

## Python / Flask

```python
# claude_remote.py
import os, uuid, requests

BASE = os.environ["CLAUDE_BRIDGE_URL"]
SECRET = os.environ["CLAUDE_BRIDGE_SECRET"]
SOURCE = "my-app"

def submit_prompt(workspace, prompt, *, external_ref=None, callback_url=None, title=None):
    external_ref = external_ref or str(uuid.uuid4())
    r = requests.post(
        f"{BASE}/api/external/prompt",
        json={
            "workspace":    workspace,
            "prompt":       prompt,
            "source":       SOURCE,
            "external_ref": external_ref,
            "callback_url": callback_url,
            "title":        title,
        },
        headers={"x-external-secret": SECRET},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()

def poll_messages(external_ref):
    r = requests.get(
        f"{BASE}/api/external/messages",
        params={"source": SOURCE, "external_ref": external_ref},
        headers={"x-external-secret": SECRET},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()["items"]
```

```python
# app.py — minimal Flask callback
from flask import Flask, request, abort, jsonify
import os

app = Flask(__name__)

@app.post("/api/claude-callback")
def claude_callback():
    if request.headers.get("x-external-secret") != os.environ["CLAUDE_BRIDGE_SECRET"]:
        abort(401)
    body = request.get_json()
    # persist body["response"] keyed on body["external_ref"]
    return jsonify(ok=True)
```

## Common patterns

### Prompt envelopes

When the same app sends many prompts to Claude, wrap the user input with a
prefix that gives Claude the context Claude Code expects:

```ts
function envelope(userText: string, projectName: string): string {
  return [
    `You are running in the workspace "${projectName}".`,
    "",
    "User wrote:",
    "---",
    userText,
    "---",
    "",
    "Do this:",
    "1. Understand what the user wants.",
    "2. If it's a question, answer briefly.",
    "3. If it's a bug report or feature request, find the relevant code, fix or implement it, and verify nothing else broke.",
    "4. If you made code changes, push to a branch (not main).",
    "5. Reply in 1-2 sentences: what was wrong and what you did.",
  ].join("\n");
}
```

### Continuing a thread

Pass the same `external_ref` as a previous prompt. The web app re-uses the
existing `thread_id` and Claude's session continues — you can ask follow-up
questions on the same context.

### Bug reports with screenshots

The QA-extension endpoint (`POST /api/qa-assistant`) handles this for the
included Chrome extension pattern: prompt + URL + console log + base64 PNG.
You can submit the same shape if your app captures page context.

## Security checklist

- [ ] `EXTERNAL_API_SECRET` is set in `BRIDGE_SECRET` env var of every app
      that integrates — never hardcoded, never committed.
- [ ] Server-side fetches only. The browser must never see the secret.
- [ ] Your callback receiver verifies the same `x-external-secret` header.
- [ ] `external_ref` is something you control and validate (UUID is the
      easy choice). Treat it as a primary key in your own DB.
- [ ] Rotate `EXTERNAL_API_SECRET` like any production secret. Doing so does
      not invalidate `BRIDGE_SECRET` or `ADMIN_TOKEN` — they're independent.
- [ ] Anyone with the secret can run arbitrary prompts in your Claude
      session. Treat it like an SSH key.

## Errors

| Status | Meaning |
| --- | --- |
| `400 workspace, prompt, source required` | Missing field. |
| `400 callback_url is not a valid URL` | Self-explanatory. |
| `401 Unauthorized` | Wrong or missing `x-external-secret`. |
| `5xx` | The web app or DB is down. Retry with exponential backoff. |
