import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { enqueueClaudeBotPrompt } from "@/lib/claude-bot-send";
import {
  computeNextRun,
  type Frequency,
} from "@/lib/claude-scheduled";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE = "scheduled-task";

type DueRow = {
  id: string;
  workspace: string;
  title: string | null;
  prompt: string;
  frequency: Frequency;
  time_of_day: string;
  day_of_week: number | null;
  day_of_month: number | null;
  run_date: string | null;
  timezone: string;
};

function authOk(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization") || "";
  const vercelCron = req.headers.get("x-vercel-cron");
  const urlSecret = new URL(req.url).searchParams.get("secret");
  return (
    auth === `Bearer ${secret}` || urlSecret === secret || vercelCron === "1"
  );
}

async function run(req: Request) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const due = (await sql`
    SELECT id::text, workspace, title, prompt, frequency, time_of_day,
           day_of_week, day_of_month, run_date::text AS run_date, timezone
    FROM claude_scheduled_tasks
    WHERE enabled = TRUE AND next_run_at <= NOW()
    ORDER BY next_run_at ASC
    LIMIT 50
  `) as DueRow[];

  const results: Array<{
    id: string;
    ok: boolean;
    outbox_id?: string;
    next_run_at?: string | null;
    error?: string;
  }> = [];

  for (const t of due) {
    try {
      const enq = await enqueueClaudeBotPrompt({
        workspace: t.workspace,
        prompt: t.prompt,
        title: t.title,
        source: SOURCE,
      });

      const next = computeNextRun({
        frequency: t.frequency,
        time_of_day: t.time_of_day,
        day_of_week: t.day_of_week,
        day_of_month: t.day_of_month,
        run_date: t.run_date,
        timezone: t.timezone,
      });

      if (next) {
        await sql`
          UPDATE claude_scheduled_tasks
          SET last_run_at = NOW(),
              next_run_at = ${next.toISOString()},
              updated_at = NOW()
          WHERE id = ${t.id}
        `;
      } else {
        await sql`
          UPDATE claude_scheduled_tasks
          SET last_run_at = NOW(),
              enabled = FALSE,
              updated_at = NOW()
          WHERE id = ${t.id}
        `;
      }

      results.push({
        id: t.id,
        ok: true,
        outbox_id: enq.outbox_id,
        next_run_at: next ? next.toISOString() : null,
      });
    } catch (err) {
      results.push({
        id: t.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ ok: true, fired: results.length, results });
}

export async function GET(req: Request) {
  return run(req);
}

export async function POST(req: Request) {
  return run(req);
}
