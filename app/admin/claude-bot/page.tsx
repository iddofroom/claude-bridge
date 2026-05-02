import { sql } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import ClaudeBotApp, {
  type ThreadSummary,
} from "@/components/admin/claude-bot/ClaudeBotApp";

export const dynamic = "force-dynamic";

export default async function ClaudeBotPage() {
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
    LIMIT 200
  `;
  const threads = rows as unknown as ThreadSummary[];

  return (
    <AdminShell
      title="Claude bridge"
      subtitle="Send prompts to a Claude Code session running on your home machine, and see the responses come back through the bridge."
      extraLinks={[
        { href: "/admin/claude-bot/scheduled", label: "Scheduled prompts" },
        { href: "/admin/claude-bot/guide", label: "Integration guide" },
      ]}
    >
      <ClaudeBotApp initialThreads={threads} />
    </AdminShell>
  );
}
