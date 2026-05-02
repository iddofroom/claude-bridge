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

type RouteCtx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: RouteCtx) {
  const gate = await requireAdmin();
  if (gate) return gate;

  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const existing = (await sql`
    SELECT frequency, time_of_day, day_of_week, day_of_month, run_date::text AS run_date
    FROM claude_scheduled_tasks WHERE id = ${id} LIMIT 1
  `) as Array<{
    frequency: Frequency;
    time_of_day: string;
    day_of_week: number | null;
    day_of_month: number | null;
    run_date: string | null;
  }>;

  if (existing.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (typeof body.enabled === "boolean") {
    await sql`
      UPDATE claude_scheduled_tasks
      SET enabled = ${body.enabled}, updated_at = NOW()
      WHERE id = ${id}
    `;
    return NextResponse.json({ ok: true });
  }

  const merged = {
    frequency: (body.frequency ?? existing[0].frequency) as Frequency,
    time_of_day: (body.time_of_day ?? existing[0].time_of_day).toString().trim(),
    day_of_week:
      body.day_of_week === undefined
        ? existing[0].day_of_week
        : body.day_of_week === null
          ? null
          : Number(body.day_of_week),
    day_of_month:
      body.day_of_month === undefined
        ? existing[0].day_of_month
        : body.day_of_month === null
          ? null
          : Number(body.day_of_month),
    run_date:
      body.run_date === undefined
        ? existing[0].run_date
        : body.run_date
          ? body.run_date.toString().trim()
          : null,
  };

  const err = validateTaskInput(merged);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const nextRun = computeNextRun(merged);
  if (!nextRun) {
    return NextResponse.json(
      { error: "run_date is in the past" },
      { status: 400 },
    );
  }

  const workspace = body.workspace !== undefined
    ? (body.workspace as string).toString().trim()
    : null;
  const prompt = body.prompt !== undefined ? (body.prompt as string).toString().trim() : null;
  const title = body.title !== undefined
    ? body.title === null
      ? null
      : (body.title as string).toString().trim()
    : undefined;

  await sql`
    UPDATE claude_scheduled_tasks
    SET
      workspace = COALESCE(${workspace}, workspace),
      prompt = COALESCE(${prompt}, prompt),
      title = CASE WHEN ${title === undefined} THEN title ELSE ${title ?? null} END,
      frequency = ${merged.frequency},
      time_of_day = ${merged.time_of_day},
      day_of_week = ${merged.day_of_week},
      day_of_month = ${merged.day_of_month},
      run_date = ${merged.run_date},
      next_run_at = ${nextRun.toISOString()},
      updated_at = NOW()
    WHERE id = ${id}
  `;

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const gate = await requireAdmin();
  if (gate) return gate;

  const { id } = await ctx.params;
  await sql`DELETE FROM claude_scheduled_tasks WHERE id = ${id}`;
  return NextResponse.json({ ok: true });
}
