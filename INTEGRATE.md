# Integrate

Wire your app — a website, Slack bot, CLI, GitHub Action — to push prompts
into your Claude session and receive the responses.

You need the deployed web app's URL and its `EXTERNAL_API_SECRET`. Both
belong on **your server**, never in browser code.

## Flow

1. POST a prompt to `/api/external/prompt`.
2. Either set `callback_url` (we POST you back when Claude replies), or poll
   `/api/external/messages?external_ref=...` every few seconds.

Replies typically arrive in 2–30 seconds.

## TypeScript

Drop into your app:

```ts
// lib/claude-remote.ts
const BASE = process.env.CLAUDE_BRIDGE_URL!;
const SECRET = process.env.CLAUDE_BRIDGE_SECRET!;
const SOURCE = "my-app";

export async function submitPrompt(opts: {
  workspace: string;
  prompt: string;
  externalRef?: string;
  callbackUrl?: string;
  title?: string;
}) {
  const externalRef = opts.externalRef ?? crypto.randomUUID();
  const res = await fetch(`${BASE}/api/external/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-external-secret": SECRET },
    body: JSON.stringify({
      workspace: opts.workspace,
      prompt: opts.prompt,
      source: SOURCE,
      external_ref: externalRef,
      callback_url: opts.callbackUrl,
      title: opts.title,
    }),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ thread_id: string; external_ref: string }>;
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
    items: Array<{ kind: "prompt" | "response"; content: string; created_at: string }>;
  }>;
}
```

Callback receiver:

```ts
// app/api/claude-callback/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  if (req.headers.get("x-external-secret") !== process.env.CLAUDE_BRIDGE_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { external_ref, response } = await req.json();
  // persist `response` keyed on `external_ref`, notify your user, etc.
  return NextResponse.json({ ok: true });
}
```

## Python

```python
import os, uuid, requests
BASE, SECRET = os.environ["CLAUDE_BRIDGE_URL"], os.environ["CLAUDE_BRIDGE_SECRET"]

def submit(workspace, prompt, callback_url=None):
    r = requests.post(f"{BASE}/api/external/prompt",
        json={"workspace": workspace, "prompt": prompt, "source": "my-app",
              "external_ref": str(uuid.uuid4()), "callback_url": callback_url},
        headers={"x-external-secret": SECRET}, timeout=10)
    r.raise_for_status()
    return r.json()
```

## Tips

- **Continue a thread**: pass the same `external_ref` again. Same `thread_id`,
  Claude sees the conversation history.
- **Prompt envelopes**: when sending many prompts, prefix with the workspace
  + instructions Claude should follow ("answer in 1-2 sentences", "push to a
  branch, not main", etc).
- **Page-context bug reports**: see the QA-extension shape in
  [PROTOCOL.md](PROTOCOL.md#post-apiqa-assistant) — same backend, different
  body.

## Security

- Secret is server-side only. The browser must never see it.
- Your callback receiver must verify `x-external-secret` itself.
- `external_ref` is yours — UUID is the easy choice; treat it as a primary key.
- Anyone with the secret can run arbitrary prompts in your Claude session.

## Errors

| Status | Meaning |
| --- | --- |
| 400 | Missing field or bad `callback_url`. Body has details. |
| 401 | Wrong or missing `x-external-secret`. |
| 5xx | Web app or DB is down. Retry with backoff. |

Full endpoint reference in **[PROTOCOL.md](PROTOCOL.md)**.
