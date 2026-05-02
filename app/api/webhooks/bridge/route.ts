import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { fireExternalCallback } from "@/lib/external-callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wire protocol the bridge running on the home machine speaks.
 *
 *   POST   /api/webhooks/bridge          — bridge → web app: deliver Claude's response
 *   GET    /api/webhooks/bridge?status=queued
 *                                        — bridge polls for queued prompts (slow safety net)
 *   PATCH  /api/webhooks/bridge          — bridge updates an outbox row's status (sent/failed)
 *
 * All three authenticate with header `x-bridge-secret` (env: BRIDGE_SECRET).
 */
export async function POST(req: Request) {
  const secret = req.headers.get("x-bridge-secret");
  if (!secret || secret !== process.env.BRIDGE_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const workspace = (body.workspace ?? "").trim();
    const response = (body.response ?? "").trim();
    if (!workspace || !response) {
      return NextResponse.json(
        { error: "workspace and response required" },
        { status: 400 },
      );
    }

    // Match the response to the most recent prompt in the same workspace.
    // Pull thread + external metadata so the inbox row is paired with its
    // prompt and any callbacks can fire.
    let conversationId: string | null = body.conversation_id ?? null;
    let threadId: string | null = null;
    let source: string | null = null;
    let externalRef: string | null = null;
    let callbackUrl: string | null = null;

    const matchRows = await sql`
      SELECT thread_id, source, external_ref, callback_url
      FROM claude_outbox
      WHERE workspace = ${workspace}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (matchRows.length > 0) {
      const m = matchRows[0] as {
        thread_id: string | null;
        source: string | null;
        external_ref: string | null;
        callback_url: string | null;
      };
      threadId = m.thread_id;
      source = m.source;
      externalRef = m.external_ref;
      callbackUrl = m.callback_url;
    }

    const inserted = await sql`
      INSERT INTO claude_inbox (
        workspace, response, claude_session_id,
        thread_id, source, external_ref
      )
      VALUES (
        ${workspace}, ${response}, ${body.claude_session_id ?? null},
        ${threadId}, ${source}, ${externalRef}
      )
      RETURNING id, created_at
    `;

    if (threadId) {
      await sql`
        UPDATE claude_threads
        SET last_at = NOW(),
            status = CASE WHEN status = 'pending' THEN 'completed' ELSE status END
        WHERE id = ${threadId}
      `;
    }

    if (callbackUrl) {
      fireExternalCallback(callbackUrl, {
        inbox_id: (inserted[0] as { id: string }).id,
        workspace,
        source,
        external_ref: externalRef,
        response,
        claude_session_id: body.claude_session_id ?? null,
        created_at: (inserted[0] as { created_at: string }).created_at,
        conversation_id: conversationId,
      });
    }

    return NextResponse.json({
      ok: true,
      id: (inserted[0] as { id: string }).id,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const secret = req.headers.get("x-bridge-secret");
  if (!secret || secret !== process.env.BRIDGE_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await sql`
    SELECT id, workspace, prompt, created_at
    FROM claude_outbox
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 20
  `;
  return NextResponse.json({ items: rows });
}

export async function PATCH(req: Request) {
  const secret = req.headers.get("x-bridge-secret");
  if (!secret || secret !== process.env.BRIDGE_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  if (!body.id || !body.status) {
    return NextResponse.json(
      { error: "id and status required" },
      { status: 400 },
    );
  }
  await sql`
    UPDATE claude_outbox
    SET status = ${body.status},
        sent_at = CASE WHEN ${body.status} = 'sent' THEN NOW() ELSE sent_at END,
        error = ${body.error ?? null}
    WHERE id = ${body.id}
  `;
  return NextResponse.json({ ok: true });
}
