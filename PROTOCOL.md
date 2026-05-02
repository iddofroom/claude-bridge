# Wire protocol

Reference for anyone reimplementing the bridge in another language (Go, Rust,
Python) or building a custom client. This documents every endpoint and the
state machine.

## Headers used everywhere

| Header | Where | Holds |
| --- | --- | --- |
| `x-external-secret` | external API + qa-assistant callbacks | `EXTERNAL_API_SECRET` |
| `Authorization: Bearer <secret>` | qa-assistant inbound + cron | `EXTERNAL_API_SECRET` / `CRON_SECRET` |
| `x-bridge-secret` | bridge ↔ web app | `BRIDGE_SECRET` |
| Cookie `claude_admin` | admin UI + admin API | Signed session, see [`lib/admin-auth.ts`](lib/admin-auth.ts) |

## State machine

Every prompt walks through these states:

```
   POST /api/external/prompt          POST /api/webhooks/bridge
                  │                                  │
                  ▼                                  ▼
        ┌────────────────┐                 ┌──────────────────┐
        │ outbox: queued │  bridge picks → │ outbox: sent     │
        └────────────────┘   it up         │ inbox: <created> │
                                            └──────────────────┘
                                                    │
                                                    │  callback_url set?
                                                    ▼
                                          POST <callback_url>

   On error:
        ┌────────────────┐
        │ outbox: failed │   PATCH /api/webhooks/bridge { id, status: 'failed', error }
        └────────────────┘
```

`thread_id` joins prompts and responses that share an `external_ref`. The
admin UI groups by thread; it doesn't care whether the prompts came from the
admin form or an external app.

---

## External API

### `POST /api/external/prompt`

Submit a prompt. Idempotent on `external_ref`: passing the same value twice
returns the same `thread_id`, so resending a request appends a follow-up
prompt rather than creating a new thread.

**Request**

```http
POST /api/external/prompt
Content-Type: application/json
x-external-secret: <EXTERNAL_API_SECRET>
```

```json
{
  "workspace":     "my-app",        // string, required
  "prompt":        "...",           // string, required
  "source":        "my-app",        // string, required — caller identifier
  "external_ref":  "uuid-or-id",    // string, optional (auto-generated UUID if omitted)
  "callback_url":  "https://...",   // string, optional, http(s) only
  "title":         "...",           // string, optional, applied on first prompt only
  "source_site":   "...",           // string, optional, free-form metadata
  "source_bug_id": "..."            // string, optional, free-form metadata
}
```

**Response 200**

```json
{
  "ok": true,
  "outbox_id":    "uuid",
  "thread_id":    "uuid",
  "external_ref": "...",
  "status":       "queued",
  "created_at":   "2026-04-30T08:15:32.821Z"
}
```

**Errors**

| Status | Body |
| --- | --- |
| 400 | `{"error":"workspace, prompt, source required"}` |
| 400 | `{"error":"callback_url must be http(s)"}` / `"... is not a valid URL"` |
| 401 | `{"error":"Unauthorized"}` |
| 500 | `{"error":"<message>"}` |

### `GET /api/external/messages`

Polling alternative to callbacks. Returns prompts + responses interleaved by
`created_at`.

**Request**

```http
GET /api/external/messages?source=my-app&external_ref=...&since=...&limit=...&workspace=...
x-external-secret: <EXTERNAL_API_SECRET>
```

| Query param | Required | Notes |
| --- | --- | --- |
| `source` | yes | Caller identifier set when submitting. |
| `external_ref` | no | Narrow to a single thread. |
| `workspace` | no | Narrow to a single workspace. |
| `since` | no | ISO timestamp; only items strictly after this. |
| `limit` | no | Default 100, max 500. |

**Response 200**

```json
{
  "items": [
    {
      "kind": "prompt",
      "id": "uuid",
      "workspace": "my-app",
      "source": "my-app",
      "external_ref": "...",
      "content": "...",
      "status": "sent",
      "error": null,
      "created_at": "...",
      "sent_at": "..."
    },
    {
      "kind": "response",
      "id": "uuid",
      "workspace": "my-app",
      "source": "my-app",
      "external_ref": "...",
      "content": "...",
      "claude_session_id": "...",
      "created_at": "..."
    }
  ]
}
```

### Callback (server → caller)

When the inbound prompt included `callback_url`, the web app fires a
fire-and-forget POST to that URL after the response is recorded.

```http
POST <callback_url>
Content-Type: application/json
x-external-secret: <EXTERNAL_API_SECRET>
```

```json
{
  "inbox_id":          "uuid",
  "workspace":         "my-app",
  "source":            "my-app",
  "external_ref":      "...",
  "response":          "...",
  "claude_session_id": "...",
  "created_at":        "...",
  "conversation_id":   null
}
```

The callback is best-effort. If your endpoint is down, the inbox row is still
the source of truth — clients should also support `GET /api/external/messages`
as a recovery path.

---

## QA assistant

### `POST /api/qa-assistant`

Used by a Chrome extension to submit a bug report with page context. Same
underlying queue as `/api/external/prompt`, but auth is `Bearer` and the body
shape is fixed.

```http
POST /api/qa-assistant
Content-Type: application/json
Authorization: Bearer <EXTERNAL_API_SECRET>
```

```json
{
  "prompt":     "Login button doesn't work on Safari iOS.",
  "workspace":  "my-app",          // optional; falls back to QA_DEFAULT_WORKSPACE env
  "url":        "https://...",     // optional, included in the formatted prompt
  "screenshot": "data:image/png;base64,...",  // optional, stored as JSON attachment
  "consoleLog": "..."              // optional, last ~4KB injected into the prompt
}
```

Response: `{"ok": true, "response": "Sent. ...", "thread_id": "uuid"}`.

---

## Bridge ↔ web app

Three operations on a single endpoint, distinguished by HTTP method.

### `POST /api/webhooks/bridge`

The bridge calls this to deliver Claude's response. Matches it to the most
recent outbox row in the same workspace.

```http
POST /api/webhooks/bridge
Content-Type: application/json
x-bridge-secret: <BRIDGE_SECRET>
```

```json
{
  "workspace":         "my-app",   // required, routes the response
  "response":          "...",      // required
  "claude_session_id": "...",      // optional
  "conversation_id":   null         // optional, reserved for clients that track sessions
}
```

Response: `{"ok": true, "id": "<inbox-row-uuid>"}`.

Side effects:
- Inserts a `claude_inbox` row pulling `thread_id`, `source`, `external_ref`
  from the matched outbox row.
- Updates the matching `claude_threads` row's `last_at`; if status was
  `pending`, flips to `completed`.
- If the outbox row had a `callback_url`, fires the callback.

### `GET /api/webhooks/bridge?status=queued`

Polling fallback for the bridge. Returns up to 20 oldest queued outbox rows.

```http
GET /api/webhooks/bridge?status=queued
x-bridge-secret: <BRIDGE_SECRET>
```

Response:

```json
{
  "items": [
    { "id": "uuid", "workspace": "my-app", "prompt": "...", "created_at": "..." }
  ]
}
```

The bridge runs this once at startup (catchup), then relies on the fast push
to `/inject` for new items. Optional: poll periodically as a heartbeat.

### `PATCH /api/webhooks/bridge`

Updates an outbox row's status. The bridge sends this after `claude --print`
returns (success or failure).

```http
PATCH /api/webhooks/bridge
Content-Type: application/json
x-bridge-secret: <BRIDGE_SECRET>
```

```json
{
  "id":     "uuid",            // outbox row id
  "status": "sent" | "failed", // required
  "error":  "stderr message"   // optional, recorded only on failure
}
```

`status: "sent"` also sets `sent_at = NOW()`.

---

## Bridge `/inject`

Endpoint exposed **by the bridge**, not the web app. Used by the web app to
push fresh prompts to the bridge so it doesn't have to poll.

```http
POST <BRIDGE_PUSH_URL>/inject
Content-Type: application/json
x-bridge-secret: <BRIDGE_SECRET>
```

```json
{
  "id":              "uuid",       // outbox row id, optional but recommended
  "workspace":       "my-app",     // required
  "prompt":          "...",        // required
  "conversation_id": null           // optional
}
```

The bridge replies `202` immediately and processes asynchronously (spawn
Claude → POST inbox → PATCH outbox). If the bridge is unreachable, the web
app still inserted the outbox row, so the bridge's next catchup or polling
pass picks it up. Best-effort, no retries from the web side.

---

## Admin API (web UI internals)

Auth: `claude_admin` cookie, set by `POST /api/auth/login` with the
`ADMIN_TOKEN`.

| Method + path | Purpose |
| --- | --- |
| `POST /api/admin/send` | Submit a new admin-side prompt. |
| `GET /api/admin/threads` | List threads (most recent first). |
| `GET /api/admin/threads/:id` | Thread detail with interleaved messages. |
| `PATCH /api/admin/threads/:id` | Update title/status. |
| `GET /api/admin/scheduled` | List scheduled tasks. |
| `POST /api/admin/scheduled` | Create a scheduled task. |
| `PATCH /api/admin/scheduled/:id` | Update / toggle enabled. |
| `DELETE /api/admin/scheduled/:id` | Delete a scheduled task. |

Admin endpoints are not part of the public protocol — they're for the
included UI. Browse `app/api/admin/` for shapes.

---

## Cron

### `GET|POST /api/cron/scheduled-tasks`

Fires any scheduled tasks whose `next_run_at` has passed and reschedules
them. Auth via any of:

- `?secret=<CRON_SECRET>`
- `Authorization: Bearer <CRON_SECRET>`
- `x-vercel-cron: 1` (legacy compatibility)

External cron services that work:
- [cron-job.org](https://cron-job.org) — free, simple, hits a URL on a schedule.
- Cloudflare Workers cron triggers.
- GitHub Actions on a `schedule:` trigger.

Resolution is `cron interval`. If you want minute-level firing, hit this
route once a minute.

Response: `{"ok": true, "fired": <count>, "results": [{ id, ok, outbox_id, next_run_at }]}`.
