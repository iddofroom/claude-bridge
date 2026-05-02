import { AdminShell } from "@/components/admin/AdminShell";

export const dynamic = "force-dynamic";

const SUBMIT_MODULE = `// lib/claude-remote.ts
const BASE = process.env.CLAUDE_BRIDGE_URL!;       // e.g. https://claude-bridge.example.com
const SECRET = process.env.CLAUDE_BRIDGE_SECRET!;  // EXTERNAL_API_SECRET on the bridge

export async function submitPromptToClaude(opts: {
  workspace: string;        // workspace folder name on the home machine
  prompt: string;
  externalRef?: string;     // your correlation id; auto-generated if omitted
  callbackUrl?: string;     // we POST the response here when Claude replies
  title?: string;           // shown in the dashboard sidebar
}) {
  const externalRef = opts.externalRef ?? crypto.randomUUID();
  const res = await fetch(\`\${BASE}/api/external/prompt\`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-external-secret": SECRET,
    },
    body: JSON.stringify({
      workspace: opts.workspace,
      prompt: opts.prompt,
      source: "my-app",
      external_ref: externalRef,
      callback_url: opts.callbackUrl,
      title: opts.title,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{
    ok: true;
    outbox_id: string;
    external_ref: string;
    thread_id: string;
    status: string;
    created_at: string;
  }>;
}

export async function pollMessages(externalRef: string) {
  const url = new URL(\`\${BASE}/api/external/messages\`);
  url.searchParams.set("source", "my-app");
  url.searchParams.set("external_ref", externalRef);
  const res = await fetch(url, {
    headers: { "x-external-secret": SECRET },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(\`bridge \${res.status}\`);
  return res.json() as Promise<{
    items: Array<{
      kind: "prompt" | "response";
      content: string;
      created_at: string;
      status?: string;
    }>;
  }>;
}`;

const CALLBACK_ROUTE = `// app/api/claude-callback/route.ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = req.headers.get("x-external-secret");
  if (secret !== process.env.CLAUDE_BRIDGE_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  // body: { inbox_id, workspace, source, external_ref, response, claude_session_id, created_at }

  // ... persist body.response to your DB, notify the user, etc.

  return NextResponse.json({ ok: true });
}`;

export default function GuidePage() {
  return (
    <AdminShell
      title="Integration guide"
      subtitle="How to wire another app into this bridge."
      back={{ href: "/admin/claude-bot", label: "Back to Claude bridge" }}
    >
      <div className="max-w-3xl mx-auto px-5 py-6 space-y-6 text-zinc-200">
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-white mb-2">How it works</h2>
          <ol className="list-decimal list-inside text-sm text-zinc-300 space-y-1.5">
            <li>Your app POSTs a prompt to <Code>/api/external/prompt</Code> with a shared secret.</li>
            <li>This server queues it in the database and pushes it to a bridge process running on a machine where Claude Code is installed.</li>
            <li>The bridge spawns <Code>claude --print</Code> in the chosen workspace folder, captures the response, and posts it back to <Code>/api/webhooks/bridge</Code>.</li>
            <li>If your call included a <Code>callback_url</Code>, this server POSTs the response there. Otherwise your app polls <Code>/api/external/messages</Code>.</li>
          </ol>
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-white mb-2">1. Send a prompt</h2>
          <p className="text-sm text-zinc-400 mb-3">
            Drop this module into your app. Set <Code>CLAUDE_BRIDGE_URL</Code> to this server&apos;s public URL and <Code>CLAUDE_BRIDGE_SECRET</Code> to the same value as <Code>EXTERNAL_API_SECRET</Code> here.
          </p>
          <CodeBlock>{SUBMIT_MODULE}</CodeBlock>
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-white mb-2">2. Receive the response</h2>
          <p className="text-sm text-zinc-400 mb-3">
            Two options:
          </p>
          <p className="text-sm text-zinc-300 mb-3">
            <strong>Callback (preferred).</strong> Pass <Code>callback_url</Code> when you submit. We POST the response to that URL with header <Code>x-external-secret</Code> set to your shared secret.
          </p>
          <CodeBlock>{CALLBACK_ROUTE}</CodeBlock>
          <p className="text-sm text-zinc-300 mt-3">
            <strong>Polling.</strong> Or call <Code>pollMessages(externalRef)</Code> every few seconds — useful when your app doesn&apos;t have a public URL.
          </p>
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-white mb-2">Security</h2>
          <ul className="list-disc list-inside text-sm text-zinc-300 space-y-1.5">
            <li>Never expose <Code>EXTERNAL_API_SECRET</Code> to a browser. Make calls from a server route.</li>
            <li>Rotate the secret when you rotate any other production credentials.</li>
            <li>Validate <Code>external_ref</Code> on your side — it&apos;s a string you control.</li>
            <li>The callback receiver must verify the same <Code>x-external-secret</Code> header.</li>
          </ul>
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-white mb-2">Full reference</h2>
          <p className="text-sm text-zinc-300">
            See <Code>INTEGRATE.md</Code> and <Code>PROTOCOL.md</Code> at the repo root for endpoint shapes, error codes, and the bridge protocol.
          </p>
        </section>
      </div>
    </AdminShell>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-zinc-800 text-indigo-300 text-[0.85em] font-mono">
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 overflow-x-auto text-xs text-zinc-200 font-mono whitespace-pre">
      {children}
    </pre>
  );
}
