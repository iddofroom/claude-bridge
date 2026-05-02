import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns an interleaved chat-style feed of prompts (claude_outbox) and
 * Claude responses (claude_inbox) that originated from a given external
 * `source`. Useful as a fallback for callers that can't receive callbacks.
 *
 * Auth: shared secret in header `x-external-secret` (env: EXTERNAL_API_SECRET).
 *
 * Query params:
 *   source        required — caller identifier set when sending the prompt
 *   workspace     optional — narrow to a single workspace
 *   external_ref  optional — narrow to a single thread
 *   since         optional — ISO timestamp; only items strictly after this
 *   limit         optional — default 100, max 500
 */
export async function GET(req: Request) {
  const secret = req.headers.get("x-external-secret");
  if (!secret || secret !== process.env.EXTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const source = (url.searchParams.get("source") ?? "").trim();
  const workspace = url.searchParams.get("workspace")?.trim() || null;
  const externalRef = url.searchParams.get("external_ref")?.trim() || null;
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "100", 10) || 100,
    500,
  );

  if (!source) {
    return NextResponse.json({ error: "source required" }, { status: 400 });
  }
  if (since && isNaN(since.getTime())) {
    return NextResponse.json(
      { error: "invalid since timestamp" },
      { status: 400 },
    );
  }

  const wsArg = workspace;
  const refArg = externalRef;
  const sinceArg = since;

  const outboxRows = await sql`
    SELECT id, workspace, source, external_ref, prompt, status, error, created_at, sent_at
    FROM claude_outbox
    WHERE source = ${source}
      AND (${wsArg}::text   IS NULL OR workspace    = ${wsArg})
      AND (${refArg}::text  IS NULL OR external_ref = ${refArg})
      AND (${sinceArg}::timestamptz IS NULL OR created_at > ${sinceArg})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  const inboxRows = await sql`
    SELECT id, workspace, source, external_ref, response, claude_session_id, created_at
    FROM claude_inbox
    WHERE source = ${source}
      AND (${wsArg}::text   IS NULL OR workspace    = ${wsArg})
      AND (${refArg}::text  IS NULL OR external_ref = ${refArg})
      AND (${sinceArg}::timestamptz IS NULL OR created_at > ${sinceArg})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  type OutRow = {
    id: string;
    workspace: string;
    source: string;
    external_ref: string;
    prompt: string;
    status: string;
    error: string | null;
    created_at: string;
    sent_at: string | null;
  };
  type InRow = {
    id: string;
    workspace: string;
    source: string;
    external_ref: string;
    response: string;
    claude_session_id: string | null;
    created_at: string;
  };

  const items = [
    ...(outboxRows as OutRow[]).map((r) => ({
      kind: "prompt" as const,
      id: r.id,
      workspace: r.workspace,
      source: r.source,
      external_ref: r.external_ref,
      content: r.prompt,
      status: r.status,
      error: r.error,
      created_at: r.created_at,
      sent_at: r.sent_at,
    })),
    ...(inboxRows as InRow[]).map((r) => ({
      kind: "response" as const,
      id: r.id,
      workspace: r.workspace,
      source: r.source,
      external_ref: r.external_ref,
      content: r.response,
      claude_session_id: r.claude_session_id,
      created_at: r.created_at,
    })),
  ].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  return NextResponse.json({ items });
}
