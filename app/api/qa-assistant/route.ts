import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { pushToBridge } from "@/lib/push-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE = "qa-extension";

/**
 * Entry point for a QA Chrome extension. Receives a prompt + page context
 * (URL, console buffer, screenshot) and queues it as an outbox message that
 * the home-machine bridge picks up and feeds into a Claude Code session.
 *
 * Auth: Authorization: Bearer <EXTERNAL_API_SECRET> (the same shared secret
 * the extension stores in its options page).
 *
 * Body shape:
 *   {
 *     prompt:      string,
 *     workspace?:  string,         // optional override; falls back to QA_DEFAULT_WORKSPACE env
 *     url:         string | null,
 *     screenshot:  string | null,  // base64 PNG data URL
 *     consoleLog:  string | null,
 *   }
 *
 * The extension only displays whether the send succeeded — it does not wait
 * for Claude's reply. Replies arrive asynchronously through the existing
 * webhook pipeline (/api/webhooks/bridge → claude_inbox) and surface in
 * /admin/claude-bot, where the QA-extension threads carry a ribbon and
 * the captured page context.
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.EXTERNAL_API_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "EXTERNAL_API_SECRET not configured" },
      { status: 500 },
    );
  }
  const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!presented || presented !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    prompt?: unknown;
    workspace?: unknown;
    url?: unknown;
    screenshot?: unknown;
    consoleLog?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const userPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!userPrompt) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }
  const workspace =
    (typeof body.workspace === "string" && body.workspace.trim()) ||
    process.env.QA_DEFAULT_WORKSPACE ||
    "default";
  const url = typeof body.url === "string" ? body.url : null;
  const screenshot =
    typeof body.screenshot === "string" ? body.screenshot : null;
  const consoleLog =
    typeof body.consoleLog === "string" ? body.consoleLog : null;

  const formattedPrompt = formatPrompt({
    userPrompt,
    url,
    consoleLog,
    hasScreenshot: !!screenshot,
  });
  const title = userPrompt.slice(0, 60);
  const externalRef = crypto.randomUUID();

  const created = await sql`
    INSERT INTO claude_threads (
      external_ref, workspace, title, status, source
    )
    VALUES (
      ${externalRef}, ${workspace}, ${title}, 'pending', ${SOURCE}
    )
    RETURNING id
  `;
  const threadId = (created[0] as { id: string }).id;

  const attachments = {
    url,
    console_log: consoleLog,
    screenshot, // base64 data URL; rendered in /admin/claude-bot
  };

  const outRows = await sql`
    INSERT INTO claude_outbox (
      workspace, prompt, status, source, external_ref, thread_id, attachments
    )
    VALUES (
      ${workspace}, ${formattedPrompt}, 'queued',
      ${SOURCE}, ${externalRef}, ${threadId}, ${JSON.stringify(attachments)}::jsonb
    )
    RETURNING id
  `;
  const outboxId = (outRows[0] as { id: string }).id;

  pushToBridge({
    outboxId,
    workspace,
    prompt: formattedPrompt,
    conversationId: null,
  });

  return NextResponse.json({
    ok: true,
    response: "Sent. You'll be notified once Claude replies.",
    thread_id: threadId,
  });
}

function formatPrompt(args: {
  userPrompt: string;
  url: string | null;
  consoleLog: string | null;
  hasScreenshot: boolean;
}): string {
  const parts: string[] = ["[QA report — via Chrome extension]"];
  if (args.url) parts.push(`URL: ${args.url}`);
  if (args.hasScreenshot) {
    parts.push("Screenshot: attached (view in /admin/claude-bot)");
  }
  if (args.consoleLog) {
    const trimmed = args.consoleLog.length > 4000
      ? args.consoleLog.slice(-4000) + "\n…(truncated, latest 4KB shown)"
      : args.consoleLog;
    parts.push("Console log:\n" + trimmed);
  }
  parts.push("\nUser request:\n" + args.userPrompt);
  return parts.join("\n\n");
}
