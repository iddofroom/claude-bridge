"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Frequency = "daily" | "weekly" | "monthly" | "once";

type Task = {
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

const RECENT_KEY = "claude-bridge-recent-workspaces";
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function describe(t: Task): string {
  if (t.frequency === "daily") return `Daily at ${t.time_of_day}`;
  if (t.frequency === "weekly")
    return `Every ${DAY_NAMES[t.day_of_week ?? 0]} at ${t.time_of_day}`;
  if (t.frequency === "monthly") {
    const dom = t.day_of_month ?? 1;
    const suffix = dom === 1 ? "st" : dom === 2 ? "nd" : dom === 3 ? "rd" : "th";
    return `On the ${dom}${suffix} of each month at ${t.time_of_day}`;
  }
  if (t.frequency === "once") return `Once on ${t.run_date} at ${t.time_of_day}`;
  return "";
}

export default function ScheduledTasksApp() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [workspace, setWorkspace] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [runDate, setRunDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/scheduled", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTasks(data.rows || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const workspaceOptions = useMemo(() => loadRecent(), []);

  const handleCreate = useCallback(async () => {
    if (!workspace.trim() || !prompt.trim()) {
      setErr("workspace and prompt are required");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        workspace: workspace.trim(),
        title: title.trim() || null,
        prompt: prompt.trim(),
        frequency,
        time_of_day: timeOfDay,
      };
      if (frequency === "weekly") body.day_of_week = dayOfWeek;
      if (frequency === "monthly") body.day_of_month = dayOfMonth;
      if (frequency === "once") body.run_date = runDate;

      const res = await fetch("/api/admin/scheduled", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      setTitle("");
      setPrompt("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [workspace, title, prompt, frequency, timeOfDay, dayOfWeek, dayOfMonth, runDate, load]);

  const toggleEnabled = useCallback(
    async (t: Task) => {
      try {
        const res = await fetch(`/api/admin/scheduled/${t.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: !t.enabled }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        await load();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [load],
  );

  const removeTask = useCallback(
    async (t: Task) => {
      if (!confirm(`Delete this task?\n\n${t.title || t.prompt.slice(0, 50)}`)) {
        return;
      }
      try {
        const res = await fetch(`/api/admin/scheduled/${t.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        await load();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [load],
  );

  return (
    <div className="bg-zinc-950 text-zinc-100">
      <div className="max-w-4xl mx-auto px-5 py-6 space-y-6">
        {err && (
          <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
            {err}
          </div>
        )}

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          <h2 className="text-lg font-semibold text-white">New scheduled task</h2>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">workspace</label>
              <input
                list="ws-options"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                placeholder="my-app"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white"
              />
              <datalist id="ws-options">
                {workspaceOptions.map((w) => (
                  <option key={w} value={w} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">title (optional)</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Weekly summary"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="What to send to Claude…"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white resize-y"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">frequency</label>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as Frequency)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="once">Once</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">time of day</label>
              <input
                type="time"
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white"
              />
            </div>
          </div>

          {frequency === "weekly" && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">day of week</label>
              <select
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white"
              >
                {DAY_NAMES.map((name, i) => (
                  <option key={i} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {frequency === "monthly" && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                day of month (1-31; falls back to last day in shorter months)
              </label>
              <input
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(Number(e.target.value))}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white"
              />
            </div>
          )}

          {frequency === "once" && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">date</label>
              <input
                type="date"
                value={runDate}
                onChange={(e) => setRunDate(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white"
              />
            </div>
          )}

          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting || !workspace.trim() || !prompt.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-semibold rounded-lg px-4 py-2 transition"
          >
            {submitting ? "Creating…" : "Create task"}
          </button>
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-white">Existing tasks</h2>
            <button
              type="button"
              onClick={load}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              Refresh
            </button>
          </div>
          {loading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-zinc-500">No scheduled tasks yet.</p>
          ) : (
            <ul className="space-y-2">
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className={`border rounded-lg p-3 ${
                    t.enabled
                      ? "border-zinc-700 bg-zinc-800/50"
                      : "border-zinc-800 bg-zinc-900/50 opacity-60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-white">
                          {t.title || "(untitled)"}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-300">
                          {t.workspace}
                        </span>
                        {!t.enabled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                            disabled
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-400 mt-1">{describe(t)}</div>
                      <div className="text-sm text-zinc-300 mt-1.5 whitespace-pre-wrap">
                        {t.prompt.length > 200 ? t.prompt.slice(0, 200) + "…" : t.prompt}
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-1.5 flex gap-3 flex-wrap">
                        <span>Next run: {formatDateTime(t.next_run_at)}</span>
                        <span>Last run: {formatDateTime(t.last_run_at)}</span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleEnabled(t)}
                        className="text-xs px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-700 text-zinc-200"
                      >
                        {t.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeTask(t)}
                        className="text-xs px-2.5 py-1 rounded border border-rose-900 text-rose-300 hover:bg-rose-950/50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
