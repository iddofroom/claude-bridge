export type Frequency = "daily" | "weekly" | "monthly" | "once";

export type ScheduledTaskInput = {
  frequency: Frequency;
  time_of_day: string;
  day_of_week: number | null;
  day_of_month: number | null;
  run_date: string | null;
  timezone?: string;
};

export const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || "UTC";

function partsInTz(date: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const hourStr = get("hour") === "24" ? "00" : get("hour");
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(hourStr),
    minute: Number(get("minute")),
    dow: dowMap[get("weekday")] ?? 0,
  };
}

/**
 * Convert a wall-clock time in `tz` (year/month/day/hour/minute) to a UTC Date.
 * Uses an offset-probe: pretend the wall-clock is UTC, see what tz interprets it as,
 * subtract the difference to get the correct UTC. Handles DST automatically.
 */
function fromTz(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const probeUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const probe = new Date(probeUtc);
  const observed = partsInTz(probe, tz);
  const observedUtc = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hour,
    observed.minute,
    0,
  );
  const offsetMs = observedUtc - probeUtc;
  return new Date(probeUtc - offsetMs);
}

function parseTime(time_of_day: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time_of_day.trim());
  if (!m) throw new Error(`invalid time_of_day: ${time_of_day}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`invalid time_of_day: ${time_of_day}`);
  }
  return { hour, minute };
}

function addDaysInTz(
  ref: { year: number; month: number; day: number },
  days: number,
  tz: string,
): { year: number; month: number; day: number } {
  const refUtc = fromTz(ref.year, ref.month, ref.day, 12, 0, tz);
  const next = new Date(refUtc.getTime() + days * 24 * 60 * 60 * 1000);
  const p = partsInTz(next, tz);
  return { year: p.year, month: p.month, day: p.day };
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Compute the next run instant (as a UTC Date) for a scheduled task,
 * relative to `now`. Returns null only for one-off tasks whose run_date
 * has already passed.
 */
export function computeNextRun(
  task: ScheduledTaskInput,
  now: Date = new Date(),
): Date | null {
  const tz = task.timezone || DEFAULT_TIMEZONE;
  const { hour, minute } = parseTime(task.time_of_day);
  const local = partsInTz(now, tz);

  if (task.frequency === "daily") {
    const todayAt = fromTz(local.year, local.month, local.day, hour, minute, tz);
    if (todayAt.getTime() > now.getTime()) return todayAt;
    const tomorrow = addDaysInTz(local, 1, tz);
    return fromTz(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, tz);
  }

  if (task.frequency === "weekly") {
    if (task.day_of_week === null || task.day_of_week === undefined) {
      throw new Error("weekly task requires day_of_week");
    }
    const targetDow = task.day_of_week;
    let delta = (targetDow - local.dow + 7) % 7;
    if (delta === 0) {
      const todayAt = fromTz(local.year, local.month, local.day, hour, minute, tz);
      if (todayAt.getTime() > now.getTime()) return todayAt;
      delta = 7;
    }
    const target = addDaysInTz(local, delta, tz);
    return fromTz(target.year, target.month, target.day, hour, minute, tz);
  }

  if (task.frequency === "monthly") {
    if (task.day_of_month === null || task.day_of_month === undefined) {
      throw new Error("monthly task requires day_of_month");
    }
    const dom = task.day_of_month;
    const tryMonth = (year: number, month: number): Date | null => {
      const last = lastDayOfMonth(year, month);
      const day = Math.min(dom, last);
      return fromTz(year, month, day, hour, minute, tz);
    };
    const thisMonth = tryMonth(local.year, local.month);
    if (thisMonth && thisMonth.getTime() > now.getTime()) return thisMonth;
    const nextMonthYear = local.month === 12 ? local.year + 1 : local.year;
    const nextMonth = local.month === 12 ? 1 : local.month + 1;
    return tryMonth(nextMonthYear, nextMonth)!;
  }

  if (task.frequency === "once") {
    if (!task.run_date) throw new Error("once task requires run_date");
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(task.run_date);
    if (!m) throw new Error(`invalid run_date: ${task.run_date}`);
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const target = fromTz(year, month, day, hour, minute, tz);
    if (target.getTime() <= now.getTime()) return null;
    return target;
  }

  throw new Error(`unknown frequency: ${task.frequency}`);
}

export function describeSchedule(task: ScheduledTaskInput): string {
  const time = task.time_of_day;
  if (task.frequency === "daily") return `Every day at ${time}`;
  if (task.frequency === "weekly") {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return `Every ${days[task.day_of_week ?? 0]} at ${time}`;
  }
  if (task.frequency === "monthly") {
    const dom = task.day_of_month ?? 1;
    const suffix = dom === 1 ? "st" : dom === 2 ? "nd" : dom === 3 ? "rd" : "th";
    return `On the ${dom}${suffix} of each month at ${time}`;
  }
  if (task.frequency === "once") {
    return `Once on ${task.run_date} at ${time}`;
  }
  return "";
}

export function validateTaskInput(input: Partial<ScheduledTaskInput>): string | null {
  if (!input.frequency) return "frequency required";
  if (!["daily", "weekly", "monthly", "once"].includes(input.frequency)) {
    return "invalid frequency";
  }
  if (!input.time_of_day || !/^\d{1,2}:\d{2}$/.test(input.time_of_day)) {
    return "time_of_day must be HH:MM";
  }
  const { hour, minute } = parseTime(input.time_of_day);
  if (hour > 23 || minute > 59) return "time_of_day out of range";
  if (input.frequency === "weekly") {
    if (
      input.day_of_week === null ||
      input.day_of_week === undefined ||
      input.day_of_week < 0 ||
      input.day_of_week > 6
    ) {
      return "day_of_week (0-6) required for weekly";
    }
  }
  if (input.frequency === "monthly") {
    if (
      input.day_of_month === null ||
      input.day_of_month === undefined ||
      input.day_of_month < 1 ||
      input.day_of_month > 31
    ) {
      return "day_of_month (1-31) required for monthly";
    }
  }
  if (input.frequency === "once") {
    if (!input.run_date || !/^\d{4}-\d{2}-\d{2}$/.test(input.run_date)) {
      return "run_date (YYYY-MM-DD) required for once";
    }
  }
  return null;
}
