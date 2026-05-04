import { sql } from "@/lib/db";
import { pushToBridge } from "@/lib/push-bridge";

export type EnqueueOptions = {
  workspace: string;
  prompt: string;
  title?: string | null;
  threadId?: string | null;
  source: string;
};

export type EnqueueResult = {
  thread_id: string;
  external_ref: string;
  outbox_id: string;
  created_at: string;
};

export async function enqueueClaudeBotPrompt(
  opts: EnqueueOptions,
): Promise<EnqueueResult> {
  const { prompt, title, threadId, source } = opts;

  let resolvedThreadId: string;
  let externalRef: string;
  // A thread is bound to a single workspace for its lifetime. When continuing
  // an existing thread the caller's workspace is ignored — we use whatever
  // the thread was created with — so a stale UI state can never silently
  // re-route the conversation to a different folder on the bridge machine.
  let resolvedWorkspace: string;
  // session_id of the previous turn on this thread, if any. The bridge passes
  // this to `claude --resume <id>` so the conversation continues with memory
  // of what was said before.
  let parentSessionId: string | null = null;

  if (threadId) {
    const rows = (await sql`
      SELECT id, external_ref, workspace
      FROM claude_threads WHERE id = ${threadId} LIMIT 1
    `) as Array<{ id: string; external_ref: string; workspace: string }>;
    if (rows.length === 0) {
      throw new Error("thread_not_found");
    }
    resolvedThreadId = rows[0].id;
    externalRef = rows[0].external_ref;
    resolvedWorkspace = rows[0].workspace;
    const sessionRows = (await sql`
      SELECT claude_session_id FROM claude_inbox
      WHERE thread_id = ${resolvedThreadId} AND claude_session_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `) as Array<{ claude_session_id: string | null }>;
    parentSessionId = sessionRows[0]?.claude_session_id ?? null;
    await sql`
      UPDATE claude_threads
      SET last_at = NOW(),
          status = CASE WHEN status = 'completed' THEN 'pending' ELSE status END
      WHERE id = ${resolvedThreadId}
    `;
  } else {
    externalRef = crypto.randomUUID();
    resolvedWorkspace = opts.workspace;
    const created = (await sql`
      INSERT INTO claude_threads (external_ref, workspace, title, status, source)
      VALUES (${externalRef}, ${resolvedWorkspace}, ${title ?? null}, 'pending', ${source})
      RETURNING id
    `) as Array<{ id: string }>;
    resolvedThreadId = created[0].id;
  }

  const outRows = (await sql`
    INSERT INTO claude_outbox (
      workspace, prompt, status, source, external_ref, thread_id, parent_session_id
    )
    VALUES (
      ${resolvedWorkspace}, ${prompt}, 'queued',
      ${source}, ${externalRef}, ${resolvedThreadId}, ${parentSessionId}
    )
    RETURNING id, created_at
  `) as Array<{ id: string; created_at: string }>;
  const outboxId = outRows[0].id;

  pushToBridge({
    outboxId,
    workspace: resolvedWorkspace,
    prompt,
    conversationId: null,
    parentSessionId,
  });

  return {
    thread_id: resolvedThreadId,
    external_ref: externalRef,
    outbox_id: outboxId,
    created_at: outRows[0].created_at,
  };
}
