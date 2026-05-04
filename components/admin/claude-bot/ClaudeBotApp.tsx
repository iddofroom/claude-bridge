"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ThreadSummary = {
  id: string;
  external_ref: string;
  workspace: string;
  title: string | null;
  status: string;
  source: string | null;
  source_site: string | null;
  source_bug_id: string | null;
  created_at: string;
  last_at: string;
  first_prompt: string | null;
  prompt_count: number;
  response_count: number;
};

type Attachments = {
  url?: string | null;
  console_log?: string | null;
  screenshot?: string | null;
} | null;

type Message = {
  kind: "prompt" | "response";
  id: string;
  content: string;
  status?: string;
  error?: string | null;
  created_at: string;
  claude_session_id?: string | null;
  attachments?: Attachments;
};

type ThreadDetail = {
  thread: ThreadSummary;
  messages: Message[];
};

const RECENT_KEY = "claude-bridge-recent-workspaces";
const LAST_WORKSPACE_KEY = "claude-bridge-last-workspace";

function loadRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(workspace: string) {
  if (typeof window === "undefined") return;
  const list = loadRecent();
  const next = [workspace, ...list.filter((w) => w !== workspace)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  localStorage.setItem(LAST_WORKSPACE_KEY, workspace);
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

export default function ClaudeBotApp({
  initialThreads,
}: {
  initialThreads: ThreadSummary[];
}) {
  const [threads, setThreads] = useState<ThreadSummary[]>(initialThreads);
  const [activeId, setActiveId] = useState<string | null>(
    initialThreads[0]?.id ?? null,
  );
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState<string>("");
  const [recent, setRecent] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notifPermission, setNotifPermission] =
    useState<NotificationPermissionState>("default");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Snapshot of response_count per thread on the previous poll. When the next
  // poll shows a higher count, that thread just received a new Claude reply
  // and we fire a desktop notification (if granted).
  const prevResponseCountsRef = useRef<Map<string, number>>(
    new Map(initialThreads.map((t) => [t.id, Number(t.response_count) || 0])),
  );

  useEffect(() => {
    setRecent(loadRecent());
    const last = localStorage.getItem(LAST_WORKSPACE_KEY);
    if (last) setWorkspace(last);
    if (typeof window === "undefined" || !("Notification" in window)) {
      setNotifPermission("unsupported");
    } else {
      setNotifPermission(Notification.permission as NotificationPermissionState);
    }
  }, []);

  const requestNotifications = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    try {
      const result = await Notification.requestPermission();
      setNotifPermission(result as NotificationPermissionState);
    } catch {
      // browsers that throw rather than reject: ignore.
    }
  }, []);

  const fireNewResponseNotifications = useCallback(
    (next: ThreadSummary[]) => {
      if (typeof window === "undefined" || !("Notification" in window)) return;
      if (Notification.permission !== "granted") return;
      const prev = prevResponseCountsRef.current;
      const nextMap = new Map<string, number>();
      for (const t of next) {
        const count = Number(t.response_count) || 0;
        nextMap.set(t.id, count);
        const before = prev.get(t.id) ?? 0;
        if (count > before) {
          const titleText = t.title || t.first_prompt?.slice(0, 60) || "Claude";
          const tag = `claude-thread-${t.id}`;
          const fromExtension = t.source === "qa-extension";
          const body = fromExtension
            ? "New reply to a QA extension report"
            : `New reply in ${t.workspace}`;
          try {
            const n = new Notification(titleText, { body, tag });
            n.onclick = () => {
              window.focus();
              setActiveId(t.id);
              n.close();
            };
          } catch {
            // some browsers throw on Notification() in non-secure contexts; ignore.
          }
        }
      }
      prevResponseCountsRef.current = nextMap;
    },
    [],
  );

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/admin/threads/${id}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ThreadDetail;
      setDetail(data);
      setWorkspace(data.thread.workspace);
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/threads?limit=200`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { threads: ThreadSummary[] };
      setThreads(data.threads);
      fireNewResponseNotifications(data.threads);
    } catch {
      // ignore
    }
  }, [fireNewResponseNotifications]);

  useEffect(() => {
    if (activeId) loadDetail(activeId);
  }, [activeId, loadDetail]);

  // Auto-scroll to the newest message whenever the active thread or its
  // message count changes.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeId, detail?.messages.length]);

  // Poll the active thread for new responses + thread list for cross-thread
  // updates. Cheap because it only hits our local DB.
  useEffect(() => {
    if (!activeId) return;
    const id = setInterval(() => {
      loadDetail(activeId);
      refreshThreads();
    }, 5000);
    return () => clearInterval(id);
  }, [activeId, loadDetail, refreshThreads]);

  const handleSend = useCallback(async () => {
    if (!prompt.trim()) return;
    if (!workspace.trim()) {
      setError("Pick a workspace first");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        workspace: workspace.trim(),
      };
      if (activeId) body.thread_id = activeId;

      const res = await fetch("/api/admin/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      pushRecent(workspace.trim());
      setRecent(loadRecent());
      setPrompt("");
      const newId = data.thread_id as string;
      setActiveId(newId);
      await refreshThreads();
      await loadDetail(newId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }, [prompt, workspace, activeId, refreshThreads, loadDetail]);

  const handleNewThread = useCallback(() => {
    setActiveId(null);
    setDetail(null);
    setPrompt("");
    const last = localStorage.getItem(LAST_WORKSPACE_KEY) || "";
    setWorkspace(last);
    composerRef.current?.focus();
  }, []);

  const workspaceOptions = useMemo(() => recent, [recent]);

  return (
    <div className="flex h-[calc(100vh-110px)]">
      <aside className="w-72 shrink-0 border-l border-zinc-800 bg-zinc-900 flex flex-col">
        <div className="p-3 border-b border-zinc-800 space-y-2">
          <button
            type="button"
            onClick={handleNewThread}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg py-2 transition"
          >
            + New thread
          </button>
          {notifPermission === "default" && (
            <button
              type="button"
              onClick={requestNotifications}
              className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded-lg py-1.5 border border-zinc-700 transition"
            >
              Enable browser notifications
            </button>
          )}
          {notifPermission === "denied" && (
            <div className="text-[10px] text-zinc-500 px-1">
              Notifications blocked in browser settings.
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {threads.length === 0 ? (
            <div className="p-4 text-xs text-zinc-500">No threads yet.</div>
          ) : (
            <ul>
              {threads.map((t) => {
                const active = activeId === t.id;
                const subtitle = t.first_prompt
                  ? t.first_prompt.slice(0, 80)
                  : "(empty)";
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(t.id)}
                      className={`w-full text-left px-3 py-2.5 border-b border-zinc-800 transition ${
                        active
                          ? "bg-zinc-800"
                          : "hover:bg-zinc-800/50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-white truncate flex-1">
                          {t.title || subtitle}
                        </span>
                        <StatusBadge status={t.status} />
                      </div>
                      <div className="flex items-center justify-between mt-1 text-xs text-zinc-400 gap-2">
                        <span className="flex items-center gap-1.5 min-w-0">
                          {t.source === "qa-extension" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300 shrink-0">
                              QA ext
                            </span>
                          )}
                          <span className="truncate">{t.workspace}</span>
                        </span>
                        <span className="shrink-0">{formatTime(t.last_at)}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {!activeId ? (
            <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
              New thread — pick a workspace and type a prompt below.
            </div>
          ) : loadingDetail && !detail ? (
            <div className="text-zinc-500 text-sm">Loading…</div>
          ) : detail ? (
            <>
              <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2 flex-wrap">
                {detail.thread.source === "qa-extension" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300">
                    via QA extension
                  </span>
                )}
                <span>workspace: {detail.thread.workspace}</span>
                <span>·</span>
                <span>
                  external_ref:
                  <span className="font-mono"> {detail.thread.external_ref}</span>
                </span>
              </div>
              {detail.messages.length === 0 ? (
                <div className="text-zinc-500 text-sm">No messages yet.</div>
              ) : (
                detail.messages.map((m) => <MessageBubble key={`${m.kind}-${m.id}`} m={m} />)
              )}
              {detail.thread.status === "pending" &&
                detail.messages.length > 0 &&
                detail.messages[detail.messages.length - 1]?.kind ===
                  "prompt" && (
                  <div className="text-xs text-zinc-500 italic">
                    Waiting for Claude…
                  </div>
                )}
            </>
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-zinc-800 bg-zinc-900 p-3 space-y-2">
          {error && (
            <div className="text-xs text-rose-400 bg-rose-950/50 border border-rose-900 rounded px-2 py-1">
              {error}
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-400 shrink-0">workspace</label>
            <input
              list="workspace-options"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="my-app"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-white"
              disabled={!!activeId && !!detail}
            />
            <datalist id="workspace-options">
              {workspaceOptions.map((w) => (
                <option key={w} value={w} />
              ))}
            </datalist>
          </div>
          <div className="flex items-end gap-2">
            <textarea
              ref={composerRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={3}
              placeholder="Prompt… (Ctrl/Cmd+Enter to send)"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white resize-y"
              disabled={sending}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !prompt.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-semibold rounded-lg px-4 py-2 transition"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "pending", cls: "bg-amber-500/20 text-amber-300" },
    completed: { label: "done", cls: "bg-emerald-500/20 text-emerald-300" },
    rejected: { label: "rejected", cls: "bg-rose-500/20 text-rose-300" },
  };
  const v = map[status] ?? {
    label: status,
    cls: "bg-zinc-700 text-zinc-300",
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${v.cls}`}>
      {v.label}
    </span>
  );
}

// Splits message text into plain strings and <a> tags for any http(s) URL.
// Trailing punctuation like ).,;! is excluded from the link so a URL at the
// end of a sentence still produces a clean target.
const URL_REGEX = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function linkify(text: string): ReactNode {
  if (!text) return text;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Fragment key={`t-${key++}`}>{text.slice(lastIndex, match.index)}</Fragment>,
      );
    }
    const url = match[0];
    parts.push(
      <a
        key={`l-${key++}`}
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="underline break-all hover:opacity-80"
      >
        {url}
      </a>,
    );
    lastIndex = URL_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(<Fragment key={`t-${key++}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return parts;
}

function MessageBubble({ m }: { m: Message }) {
  const isPrompt = m.kind === "prompt";
  const attachments = m.attachments;
  const hasScreenshot =
    !!attachments &&
    typeof attachments.screenshot === "string" &&
    attachments.screenshot.length > 0;
  return (
    <div className={`flex ${isPrompt ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
          isPrompt
            ? "bg-indigo-600 text-white"
            : "bg-zinc-800 text-zinc-100"
        }`}
      >
        <div>{linkify(m.content)}</div>
        {hasScreenshot && (
          <a
            href={attachments!.screenshot!}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block rounded-lg overflow-hidden border border-indigo-300/30"
            title="Open full-size"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={attachments!.screenshot!}
              alt="Screenshot from QA extension"
              className="w-full max-h-64 object-contain bg-zinc-950/30"
            />
          </a>
        )}
        <div
          className={`text-[10px] mt-1 ${
            isPrompt ? "text-indigo-200" : "text-zinc-400"
          }`}
        >
          {formatTime(m.created_at)}
          {isPrompt && m.status && m.status !== "sent" ? ` · ${m.status}` : ""}
          {m.error ? ` · ${m.error}` : ""}
        </div>
      </div>
    </div>
  );
}
