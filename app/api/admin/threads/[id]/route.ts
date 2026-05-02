import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx) {
  const gate = await requireAdmin();
  if (gate) return gate;

  const { id } = await ctx.params;

  const threadRows = await sql`
    SELECT id, external_ref, workspace, title, status,
           source, source_site, source_bug_id, created_at, last_at
    FROM claude_threads WHERE id = ${id} LIMIT 1
  `;
  if (threadRows.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const outboxRows = await sql`
    SELECT id, prompt AS content, status, error, created_at, sent_at, attachments
    FROM claude_outbox WHERE thread_id = ${id}
    ORDER BY created_at ASC
  `;
  const inboxRows = await sql`
    SELECT id, response AS content, claude_session_id, created_at
    FROM claude_inbox WHERE thread_id = ${id}
    ORDER BY created_at ASC
  `;

  type OutboxRow = {
    id: string;
    content: string;
    status: string;
    error: string | null;
    created_at: string;
    sent_at: string | null;
    attachments: unknown;
  };
  type InboxRow = {
    id: string;
    content: string;
    claude_session_id: string | null;
    created_at: string;
  };

  const messages = [
    ...(outboxRows as OutboxRow[]).map((r) => ({ kind: "prompt" as const, ...r })),
    ...(inboxRows as InboxRow[]).map((r) => ({ kind: "response" as const, ...r })),
  ].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  return NextResponse.json({ thread: threadRows[0], messages });
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  const gate = await requireAdmin();
  if (gate) return gate;

  const { id } = await ctx.params;
  let body: { title?: unknown; status?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const updates: { title?: string; status?: string } = {};
  if (typeof body.title === "string") updates.title = body.title.trim();
  if (typeof body.status === "string") {
    const s = body.status.trim();
    if (!["pending", "completed", "rejected"].includes(s)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    updates.status = s;
  }

  if (updates.title !== undefined && updates.status !== undefined) {
    await sql`UPDATE claude_threads SET title = ${updates.title}, status = ${updates.status} WHERE id = ${id}`;
  } else if (updates.title !== undefined) {
    await sql`UPDATE claude_threads SET title = ${updates.title} WHERE id = ${id}`;
  } else if (updates.status !== undefined) {
    await sql`UPDATE claude_threads SET status = ${updates.status} WHERE id = ${id}`;
  } else {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
