"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 p-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/admin/claude-bot";

  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm space-y-4 bg-zinc-900 border border-zinc-800 rounded-xl p-6"
    >
      <div>
        <h1 className="text-xl font-bold text-white">claude-bridge</h1>
        <p className="text-sm text-zinc-400 mt-1">Enter the admin token.</p>
      </div>

      <div>
        <label htmlFor="token" className="block text-xs text-zinc-400 mb-1">
          ADMIN_TOKEN
        </label>
        <input
          id="token"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white"
        />
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || !token}
        className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-sm font-semibold rounded-lg py-2 transition"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
