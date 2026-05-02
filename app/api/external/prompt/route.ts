import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { pushToBridge } from "@/lib/push-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-to-server entry point for external tools (e.g. another app on a sister
 * site, a Slack bot, a Chrome extension) to send a prompt to a Claude Code
 * session via the home-machine bridge.
 *
 * Auth: shared secret in header `x-external-secret` (env: EXTERNAL_API_SECRET).
 *
 * Body:
 *   {
 *     workspace: string,         // workspace folder name on the home machine
 *     prompt: string,            // text to inject into the Claude session
 *     source: string,            // identifier for the calling tool, e.g. 'acme-portal'
 *     external_ref?: string,     // caller's correlation id; used as thread key. New UUID if absent.
 *     callback_url?: string,     // if set, /api/webhooks/bridge fires the response here
 *     title?: string,            // thread title (only used on first prompt of a new thread)
 *     source_site?: string,      // optional: which sister site reported the request
 *     source_bug_id?: string,    // optional: id within that site
 *   }
 *
 * Returns: { ok, outbox_id, status, created_at, external_ref, thread_id }
 */
export async function POST(req: Request) {
  const secret = req.headers.get("x-external-secret");
  if (!secret || secret !== process.env.EXTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const workspace = (body.workspace ?? "").toString().trim();
    const prompt = (body.prompt ?? "").toString().trim();
    const source = (body.source ?? "").toString().trim();
    const externalRefIn = body.external_ref
      ? body.external_ref.toString().trim()
      : null;
    const callbackUrl = body.callback_url
      ? body.callback_url.toString().trim()
      : null;
    const title = body.title ? body.title.toString().trim() : null;
    const sourceSite = body.source_site
      ? body.source_site.toString().trim()
      : null;
    const sourceBugId = body.source_bug_id
      ? body.source_bug_id.toString().trim()
      : null;

    if (!workspace || !prompt || !source) {
      return NextResponse.json(
        { error: "workspace, prompt, source required" },
        { status: 400 },
      );
    }
    if (callbackUrl) {
      try {
        const u = new URL(callbackUrl);
        if (u.protocol !== "https:" && u.protocol !== "http:") {
          return NextResponse.json(
            { error: "callback_url must be http(s)" },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "callback_url is not a valid URL" },
          { status: 400 },
        );
      }
    }

    const externalRef = externalRefIn ?? crypto.randomUUID();

    // Find or create the thread. external_ref is UNIQUE, so collisions return
    // the existing row and we treat the new prompt as a continuation.
    const existing = await sql`
      SELECT id FROM claude_threads WHERE external_ref = ${externalRef} LIMIT 1
    `;
    let threadId: string;
    if (existing.length > 0) {
      threadId = (existing[0] as { id: string }).id;
      await sql`
        UPDATE claude_threads
        SET last_at = NOW(),
            status = CASE WHEN status = 'completed' THEN 'pending' ELSE status END
        WHERE id = ${threadId}
      `;
    } else {
      const created = await sql`
        INSERT INTO claude_threads (
          external_ref, workspace, title, status, source, source_site, source_bug_id
        )
        VALUES (
          ${externalRef}, ${workspace}, ${title}, 'pending',
          ${source}, ${sourceSite}, ${sourceBugId}
        )
        RETURNING id
      `;
      threadId = (created[0] as { id: string }).id;
    }

    const rows = await sql`
      INSERT INTO claude_outbox (
        workspace, prompt, status, source, external_ref, callback_url, thread_id
      )
      VALUES (
        ${workspace}, ${prompt}, 'queued',
        ${source}, ${externalRef}, ${callbackUrl}, ${threadId}
      )
      RETURNING id, status, created_at
    `;

    pushToBridge({
      outboxId: (rows[0] as { id: string }).id,
      workspace,
      prompt,
      conversationId: null,
    });

    return NextResponse.json({
      ok: true,
      outbox_id: rows[0].id,
      status: rows[0].status,
      created_at: rows[0].created_at,
      external_ref: externalRef,
      thread_id: threadId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
