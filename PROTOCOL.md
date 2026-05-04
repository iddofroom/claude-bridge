# Wire protocol

Reference for reimplementing the bridge in another language or debugging
exactly what's on the wire.

## Auth

| Header | Value |
| --- | --- |
| `x-external-secret` | `EXTERNAL_API_SECRET` — external API + callback receivers |
| `Authorization: Bearer <s>` | `EXTERNAL_API_SECRET` (qa-assistant) / `CRON_SECRET` (cron) |
| `x-bridge-secret` | `BRIDGE_SECRET` — bridge ↔ web app |
| Cookie `claude_admin` | Signed session for admin UI; see [`lib/admin-auth.ts`](lib/admin-auth.ts) |

## State machine

```
   POST /api/external/prompt          POST /api/webhooks/bridge
                  │                                  │
                  ▼                                  ▼
        ┌────────────────┐                 ┌──────────────────┐
        │ outbox: queued │  bridge picks → │ outbox: sent     │ ── callback?
        └────────────────┘   it up         │ inbox: <created> │     POST <callback_url>
                                            └──────────────────┘
        On error:  PATCH /api/webhooks/bridge { status: 'failed', error }
```

`thread_id` joins prompts and responses sharing an `external_ref`.

---

## `POST /api/external/prompt`

Submit a prompt. Idempotent on `external_ref`: same value twice → same
`thread_id`, second prompt becomes a follow-up.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workspace` | string | yes | Folder name on the bridge machine. |
| `prompt` | string | yes | |
| `source` | string | yes | Caller identifier. |
| `external_ref` | string | no | Auto-generated UUID if omitted. |
| `callback_url` | string | no | http(s); receives the response. |
| `title` | string | no | Applied on first prompt of a thread only. |
| `source_site`, `source_bug_id` | string | no | Free-form metadata. |

**Response 200**

```json
{ "ok": true, "outbox_id": "uuid", "thread_id": "uuid",
  "external_ref": "...", "status": "queued", "created_at": "ISO8601" }
```

**Errors**: `400` (bad field), `401` (auth), `5xx` (server).

---

## `GET /api/external/messages`

Polling alternative to callbacks.

**Query**: `source` (required), `external_ref`, `workspace`, `since` (ISO),
`limit` (default 100, max 500).

**Response 200**

```json
{ "items": [
  { "kind": "prompt",   "id": "...", "content": "...", "status": "sent", "created_at": "..." },
  { "kind": "response", "id": "...", "content": "...", "created_at": "..." }
] }
```

Sorted by `created_at` ascending across both kinds.

---

## Callback (server → caller)

If the inbound prompt set `callback_url`, fired fire-and-forget after the
response lands.

```
POST <callback_url>
x-external-secret: <EXTERNAL_API_SECRET>
```

```json
{ "inbox_id": "uuid", "workspace": "...", "source": "...",
  "external_ref": "...", "response": "...", "claude_session_id": "...",
  "created_at": "...", "conversation_id": null }
```

Best-effort. The inbox row is the source of truth — clients should also
support `GET /api/external/messages` as a recovery path.

---

## `POST /api/qa-assistant`

Same backend as `/api/external/prompt`, fixed body, `Bearer` auth.

```json
{
  "prompt":     "...",                          // required
  "workspace":  "my-app",                       // optional, falls back to QA_DEFAULT_WORKSPACE
  "url":        "https://...",                  // optional, prepended to prompt
  "screenshot": "data:image/png;base64,...",   // optional, stored as JSON attachment
  "consoleLog": "..."                           // optional, last ~4KB injected into prompt
}
```

Response: `{ "ok": true, "thread_id": "uuid" }`.

---

## Bridge ↔ web app — `/api/webhooks/bridge`

Three operations on one path, by HTTP method. All three: `x-bridge-secret`.

### `POST` — deliver Claude's response

```json
{ "workspace": "my-app", "response": "...",
  "claude_session_id": "...",  // optional
  "conversation_id":   null }   // optional, reserved
```

Side effects: inserts `claude_inbox` row (pulling `thread_id`/`source`/
`external_ref` from the most-recent matching outbox row in the same
workspace), updates `claude_threads.last_at`, fires callback if set.

### `GET ?status=queued` — polling fallback

Returns up to 20 oldest queued outbox rows. Bridge runs this at startup
(catchup). Response: `{ "items": [{ id, workspace, prompt, parent_session_id, created_at }] }`.

`parent_session_id` is the Claude session id from the previous turn on the
same thread (or `null` for a fresh thread). The bridge passes it to
`claude --print --resume <id>` to continue the conversation with memory.

### `PATCH` — mark outbox row sent/failed

```json
{ "id": "uuid", "status": "sent" | "failed", "error": "stderr" }
```

`status: "sent"` also stamps `sent_at`.

---

## Bridge `/inject`

**Exposed by the bridge**, not the web app. Web app pushes here so the bridge
doesn't have to poll.

```
POST <BRIDGE_PUSH_URL>/inject
x-bridge-secret: <BRIDGE_SECRET>
```

```json
{ "id": "uuid", "workspace": "my-app", "prompt": "...",
  "parent_session_id": null,
  "conversation_id":   null }
```

`parent_session_id`, when set, tells the bridge to run
`claude --print --resume <id>` so the new prompt continues the previous
turn's conversation.

Bridge replies `202` immediately and processes async. Best-effort: if the
push fails, the queued outbox row stays put for the next catchup.

---

## Cron — `/api/cron/scheduled-tasks`

`GET` or `POST`. Auth (any one): `?secret=<CRON_SECRET>`,
`Authorization: Bearer <CRON_SECRET>`, or `x-vercel-cron: 1`.

Fires due tasks (`enabled = TRUE AND next_run_at <= NOW()`), reschedules
recurring ones, disables completed one-off tasks. Hit it at least as often
as your shortest interval. Free schedulers: cron-job.org, Cloudflare Workers
cron, GitHub Actions `schedule:`.

Response: `{ "ok": true, "fired": N, "results": [...] }`.

---

## Admin API

`POST /api/auth/login { token }` sets the `claude_admin` cookie. The other
admin routes (`/api/admin/send`, `/api/admin/threads(/:id)`,
`/api/admin/scheduled(/:id)`) are internal to the included UI — see
`app/api/admin/` for shapes.
