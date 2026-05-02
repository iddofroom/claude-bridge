import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await requireAdmin();
  if (gate) return gate;

  const url = new URL(req.url);
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "100", 10) || 100,
    500,
  );

  const rows = await sql`
    SELECT
      t.id, t.external_ref, t.workspace, t.title, t.status,
      t.source, t.source_site, t.source_bug_id,
      t.created_at, t.last_at,
      (SELECT prompt FROM claude_outbox
        WHERE thread_id = t.id ORDER BY created_at ASC LIMIT 1) AS first_prompt,
      (SELECT COUNT(*) FROM claude_outbox WHERE thread_id = t.id) AS prompt_count,
      (SELECT COUNT(*) FROM claude_inbox  WHERE thread_id = t.id) AS response_count
    FROM claude_threads t
    ORDER BY t.last_at DESC
    LIMIT ${limit}
  `;

  return NextResponse.json({ threads: rows });
}
