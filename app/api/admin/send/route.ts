import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { enqueueClaudeBotPrompt } from "@/lib/claude-bot-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE = "admin";

/**
 * Admin entry for /admin/claude-bot. Writes a prompt to claude_outbox and
 * fires the bridge.
 *
 * Body:
 *   {
 *     thread_id?: string,    // continue an existing thread
 *     workspace: string,     // workspace folder name on the home machine, e.g. 'my-app'
 *     prompt: string,
 *     title?: string,        // applied only when creating a new thread
 *   }
 */
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate) return gate;

  let body: {
    workspace?: string;
    prompt?: string;
    thread_id?: string;
    title?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const workspace = (body.workspace ?? "").toString().trim();
  const prompt = (body.prompt ?? "").toString().trim();
  const inputThreadId = body.thread_id ? body.thread_id.toString().trim() : null;
  const title = body.title ? body.title.toString().trim() : null;

  if (!workspace || !prompt) {
    return NextResponse.json(
      { error: "workspace, prompt required" },
      { status: 400 },
    );
  }

  try {
    const result = await enqueueClaudeBotPrompt({
      workspace,
      prompt,
      title,
      threadId: inputThreadId,
      source: SOURCE,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof Error && err.message === "thread_not_found") {
      return NextResponse.json({ error: "thread not found" }, { status: 404 });
    }
    throw err;
  }
}
