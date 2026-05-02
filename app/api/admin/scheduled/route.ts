import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import {
  computeNextRun,
  validateTaskInput,
  type Frequency,
} from "@/lib/claude-scheduled";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
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
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
};

export async function GET() {
  const gate = await requireAdmin();
  if (gate) return gate;

  const rows = (await sql`
    SELECT id::text, workspace, title, prompt, frequency, time_of_day,
           day_of_week, day_of_month, run_date::text AS run_date, timezone,
           enabled, last_run_at, next_run_at, created_at, updated_at
    FROM claude_scheduled_tasks
    ORDER BY enabled DESC, next_run_at ASC
  `) as Row[];

  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate) return gate;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const workspace = (body.workspace ?? "").toString().trim();
  const prompt = (body.prompt ?? "").toString().trim();
  const title = body.title ? body.title.toString().trim() : null;

  if (!workspace || !prompt) {
    return NextResponse.json(
      { error: "workspace, prompt required" },
      { status: 400 },
    );
  }

  const taskInput = {
    frequency: body.frequency as Frequency,
    time_of_day: (body.time_of_day ?? "").toString().trim(),
    day_of_week:
      body.day_of_week === null || body.day_of_week === undefined
        ? null
        : Number(body.day_of_week),
    day_of_month:
      body.day_of_month === null || body.day_of_month === undefined
        ? null
        : Number(body.day_of_month),
    run_date: body.run_date ? body.run_date.toString().trim() : null,
  };

  const err = validateTaskInput(taskInput);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const nextRun = computeNextRun(taskInput);
  if (!nextRun) {
    return NextResponse.json(
      { error: "run_date is in the past" },
      { status: 400 },
    );
  }

  const created = (await sql`
    INSERT INTO claude_scheduled_tasks (
      workspace, title, prompt, frequency, time_of_day,
      day_of_week, day_of_month, run_date, next_run_at
    )
    VALUES (
      ${workspace}, ${title}, ${prompt}, ${taskInput.frequency}, ${taskInput.time_of_day},
      ${taskInput.day_of_week}, ${taskInput.day_of_month},
      ${taskInput.run_date}, ${nextRun.toISOString()}
    )
    RETURNING id::text
  `) as Array<{ id: string }>;

  return NextResponse.json({ ok: true, id: created[0].id });
}
