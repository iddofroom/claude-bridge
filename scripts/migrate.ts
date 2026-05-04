import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing — set it in .env.local");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  console.log("Running claude-bridge schema migration…");

  // Thread-level metadata. Each thread groups a series of prompts (claude_outbox)
  // and responses (claude_inbox) that share an external_ref UUID. Title and
  // status are settable via the admin UI; source_site / source_bug_id let
  // sister apps tag their requests for cross-referencing.
  await sql`
    CREATE TABLE IF NOT EXISTS claude_threads (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      external_ref   TEXT NOT NULL UNIQUE,
      workspace      TEXT NOT NULL,
      title          TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      source         TEXT,
      source_site    TEXT,
      source_bug_id  TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      last_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  console.log("  ✓ claude_threads");
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_threads_last_at ON claude_threads(last_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_threads_status ON claude_threads(status, last_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_threads_source ON claude_threads(source, last_at DESC)`;

  // Outbox: prompts queued for the bridge to pick up and feed into Claude.
  // status: 'queued' | 'sent' | 'failed'.
  // attachments: JSON for QA-extension page context (url, console_log, screenshot).
  await sql`
    CREATE TABLE IF NOT EXISTS claude_outbox (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace      TEXT NOT NULL,
      prompt         TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'queued',
      error          TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      sent_at        TIMESTAMPTZ,
      thread_id          UUID REFERENCES claude_threads(id) ON DELETE SET NULL,
      source             TEXT,
      external_ref       TEXT,
      callback_url       TEXT,
      attachments        JSONB,
      parent_session_id  TEXT
    )
  `;
  console.log("  ✓ claude_outbox");
  // Idempotent for installs that ran the v0 migration before parent_session_id existed.
  await sql`ALTER TABLE claude_outbox ADD COLUMN IF NOT EXISTS parent_session_id TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_outbox_status ON claude_outbox(status, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_outbox_thread ON claude_outbox(thread_id, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_outbox_external_ref ON claude_outbox(external_ref)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_outbox_source ON claude_outbox(source, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_outbox_workspace ON claude_outbox(workspace, created_at DESC)`;

  // Inbox: Claude's responses, posted by the bridge.
  await sql`
    CREATE TABLE IF NOT EXISTS claude_inbox (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace          TEXT NOT NULL,
      response           TEXT NOT NULL,
      claude_session_id  TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      thread_id          UUID REFERENCES claude_threads(id) ON DELETE SET NULL,
      source             TEXT,
      external_ref       TEXT
    )
  `;
  console.log("  ✓ claude_inbox");
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_inbox_thread ON claude_inbox(thread_id, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_inbox_external_ref ON claude_inbox(external_ref)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claude_inbox_source ON claude_inbox(source, created_at DESC)`;

  // Scheduled tasks: prompts that fire on a daily/weekly/monthly/one-off cadence.
  // Default timezone is UTC; can be overridden per task or via DEFAULT_TIMEZONE env.
  await sql`
    CREATE TABLE IF NOT EXISTS claude_scheduled_tasks (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace    TEXT NOT NULL,
      title        TEXT,
      prompt       TEXT NOT NULL,
      frequency    TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'once')),
      time_of_day  TEXT NOT NULL,
      day_of_week  INT,
      day_of_month INT,
      run_date     DATE,
      timezone     TEXT NOT NULL DEFAULT 'UTC',
      enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      last_run_at  TIMESTAMPTZ,
      next_run_at  TIMESTAMPTZ NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  console.log("  ✓ claude_scheduled_tasks");
  await sql`
    CREATE INDEX IF NOT EXISTS claude_scheduled_tasks_due_idx
    ON claude_scheduled_tasks (next_run_at)
    WHERE enabled = TRUE
  `;

  console.log("Done.");
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
