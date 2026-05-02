import { AdminShell } from "@/components/admin/AdminShell";

export const dynamic = "force-dynamic";

const SUBMIT_MODULE = `// lib/claude-remote.ts
const BASE = process.env.CLAUDE_BRIDGE_URL!;
const SECRET = process.env.CLAUDE_BRIDGE_SECRET!;  // = EXTERNAL_API_SECRET on this server

export async function submitPrompt(opts: {
  workspace: string;
  prompt: string;
  externalRef?: string;
  callbackUrl?: string;
  title?: string;
}) {
  const externalRef = opts.externalRef ?? crypto.randomUUID();
  const res = await fetch(\`\${BASE}/api/external/prompt\`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-external-secret": SECRET },
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
  return res.json() as Promise<{ thread_id: string; external_ref: string }>;
}`;

const CALLBACK_ROUTE = `// app/api/claude-callback/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  if (req.headers.get("x-external-secret") !== process.env.CLAUDE_BRIDGE_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { external_ref, response } = await req.json();
  // persist \`response\` keyed on \`external_ref\`, notify the user, etc.
  return NextResponse.json({ ok: true });
}`;

export default function GuidePage() {
  return (
    <AdminShell
      title="Integration guide"
      subtitle="Copy-paste integration for another app."
      back={{ href: "/admin/claude-bot", label: "Back to Claude bridge" }}
    >
      <div className="max-w-3xl mx-auto px-5 py-6 space-y-6 text-zinc-200">
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-white mb-2">1. Submit</h2>
          <CodeBlock>{SUBMIT_MODULE}</CodeBlock>
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-white mb-2">2. Receive</h2>
          <p className="text-sm text-zinc-300 mb-3">
            Pass <Code>callbackUrl</Code> when you submit and handle the POST below.
            Or skip it and poll <Code>/api/external/messages?external_ref=...</Code>.
          </p>
          <CodeBlock>{CALLBACK_ROUTE}</CodeBlock>
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-white mb-2">Security</h2>
          <ul className="list-disc list-inside text-sm text-zinc-300 space-y-1.5">
            <li>Server-side calls only — never expose the secret to a browser.</li>
            <li>Your callback receiver must verify <Code>x-external-secret</Code>.</li>
            <li>Anyone with the secret can run arbitrary prompts in your Claude session.</li>
          </ul>
        </section>

        <p className="text-sm text-zinc-400">
          Full reference: <Code>INTEGRATE.md</Code> and <Code>PROTOCOL.md</Code> in the repo.
        </p>
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
