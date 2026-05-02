"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

export function AdminShell({
  title,
  subtitle,
  back,
  extraLinks,
  children,
}: {
  title: string;
  subtitle?: string;
  back?: { href: string; label: string };
  extraLinks?: Array<{ href: string; label: string }>;
  children: ReactNode;
}) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="bg-zinc-950 text-zinc-100 min-h-screen flex flex-col">
      <header className="px-5 pt-5 pb-3 border-b border-zinc-800 shrink-0">
        <div className="flex items-center justify-between gap-3">
          {back ? (
            <Link
              href={back.href}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              ← {back.label}
            </Link>
          ) : (
            <span className="text-xs text-zinc-500">claude-bridge</span>
          )}
          <div className="flex items-center gap-3">
            {extraLinks?.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-xs text-indigo-300 hover:text-indigo-200 underline underline-offset-2"
              >
                {l.label} ↗
              </Link>
            ))}
            <button
              type="button"
              onClick={handleLogout}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              Sign out
            </button>
          </div>
        </div>
        <h1 className="text-2xl font-bold text-white tracking-tight mt-1">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-zinc-300 mt-1">{subtitle}</p>
        )}
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
