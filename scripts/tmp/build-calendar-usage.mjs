#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SESSION_PATH =
  "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/agent-tools/session-contrib.json";
const EVENTS_PATH =
  "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/agent-tools/activity-events.json";
const OUT =
  "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/agent-tools/calendar-usage.json";
const SUPABASE_URL = "https://hqlrnipieyeyikdyzeqt.supabase.co";

const MONTHS = [
  { year: 2026, month: 4, label: "April 2026" },
  { year: 2026, month: 5, label: "May 2026" },
  { year: 2026, month: 6, label: "June 2026" },
];

const HEARTBEAT_MS = 5 * 60 * 1000;
const SESSION_GAP_MS = 10 * 60 * 1000;

function serviceRoleKey() {
  const key = execSync("supabase projects api-keys --project-ref hqlrnipieyeyikdyzeqt -o json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const serviceRole = JSON.parse(key).find((k) => k.name === "service_role")?.api_key;
  if (!serviceRole) throw new Error("service_role key not found");
  return serviceRole;
}

async function fetchPaged(path, serviceRole) {
  const rows = [];
  let offset = 0;
  const pageSize = 500;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${path}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
    });
    const batch = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(batch));
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

// ethan.huang and chris.viglietta are excluded: their historical activity was
// the maintainer impersonating them, not genuine usage. Keep this in sync with
// the ROSTER_EMAILS removal in build-cohort-canvas-data.mjs.
const EXCLUDED_EMAILS = new Set([
  "ethan.huang@clay.com",
  "chris.viglietta@clay.com",
]);

function cohortFilter(row) {
  const email = (row.email || "").toLowerCase();
  return (
    email.endsWith("@clay.com") &&
    !email.includes("quentin.renaud") &&
    !EXCLUDED_EMAILS.has(email)
  );
}

async function loadSessions(serviceRole) {
  if (existsSync(SESSION_PATH) && !process.env.REFRESH_SESSIONS) {
    return JSON.parse(readFileSync(SESSION_PATH, "utf8"));
  }
  const rows = await fetchPaged(
    "canvas_contributors?select=workbook_id,first_accessed_at,last_accessed_at,users!inner(email,name)&order=last_accessed_at.asc",
    serviceRole,
  );
  const sessions = rows
    .map((r) => ({
      email: r.users?.email || "",
      name: r.users?.name || "",
      workbook_id: r.workbook_id,
      first_accessed_at: r.first_accessed_at,
      last_accessed_at: r.last_accessed_at,
    }))
    .filter(cohortFilter);
  writeFileSync(SESSION_PATH, JSON.stringify(sessions));
  return sessions;
}

async function loadActivityEvents(serviceRole) {
  try {
    const rows = await fetchPaged(
      "canvas_activity_events?select=workbook_id,seen_at,users!inner(email,name)&order=seen_at.asc",
      serviceRole,
    );
    const events = rows
      .map((r) => ({
        email: r.users?.email || "",
        name: r.users?.name || "",
        workbook_id: r.workbook_id,
        seen_at: r.seen_at,
      }))
      .filter(cohortFilter);
    writeFileSync(EVENTS_PATH, JSON.stringify(events));
    return events;
  } catch (err) {
    if (existsSync(EVENTS_PATH)) {
      console.warn("activity events fetch failed, using cache:", err.message);
      return JSON.parse(readFileSync(EVENTS_PATH, "utf8"));
    }
    console.warn("activity events unavailable (migration not applied yet?):", err.message);
    return [];
  }
}

function dayKey(iso) {
  return iso.slice(0, 10);
}

function daysBetween(firstIso, lastIso) {
  const out = [];
  const cur = new Date(`${dayKey(firstIso)}T00:00:00.000Z`);
  const end = new Date(`${dayKey(lastIso)}T00:00:00.000Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function formatClock(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(11, 16) + " UTC";
}

function formatDuration(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function durationFromPings(pings) {
  if (!pings.length) return { durationMs: 0, duration: "—" };
  if (pings.length === 1) {
    return { durationMs: HEARTBEAT_MS, duration: formatDuration(HEARTBEAT_MS) };
  }
  let totalMs = 0;
  let segStart = pings[0];
  let segEnd = pings[0];
  for (let i = 1; i < pings.length; i++) {
    if (pings[i] - segEnd <= SESSION_GAP_MS) {
      segEnd = pings[i];
    } else {
      totalMs += segEnd - segStart + HEARTBEAT_MS;
      segStart = segEnd = pings[i];
    }
  }
  totalMs += segEnd - segStart + HEARTBEAT_MS;
  return { durationMs: totalMs, duration: formatDuration(totalMs) };
}

function sessionFromEvents(dayEvents) {
  const pings = dayEvents.map((e) => new Date(e.seen_at).getTime()).sort((a, b) => a - b);
  const workbooks = new Set(dayEvents.map((e) => e.workbook_id)).size;
  const { durationMs, duration } = durationFromPings(pings);
  const startMs = pings[0];
  const endMs = pings[pings.length - 1];
  return {
    signal: "heartbeats",
    signalLabel: pings.length === 1 ? "Single ping" : "Heartbeats",
    durationMs,
    duration,
    start: formatClock(startMs),
    end: formatClock(endMs),
    workbooks,
    pings: pings.length,
  };
}

function activeOnDay(row, day) {
  const firstDay = dayKey(row.first_accessed_at);
  const lastDay = dayKey(row.last_accessed_at);
  return day >= firstDay && day <= lastDay;
}

function sessionFromContributors(rows, day) {
  const explicitTs = [];
  let rangeWorkbooks = 0;
  let explicitWorkbooks = 0;

  for (const row of rows) {
    if (!activeOnDay(row, day)) continue;
    const firstDay = dayKey(row.first_accessed_at);
    const lastDay = dayKey(row.last_accessed_at);
    const firstOnDay = firstDay === day;
    const lastOnDay = lastDay === day;

    if (firstOnDay || lastOnDay) {
      explicitWorkbooks += 1;
      if (firstOnDay) explicitTs.push(new Date(row.first_accessed_at).getTime());
      if (lastOnDay) explicitTs.push(new Date(row.last_accessed_at).getTime());
    } else {
      rangeWorkbooks += 1;
    }
  }

  if (!explicitTs.length && !rangeWorkbooks) return null;

  const workbooks = explicitWorkbooks + rangeWorkbooks;
  if (explicitTs.length >= 2) {
    const startMs = Math.min(...explicitTs);
    const endMs = Math.max(...explicitTs);
    const durationMs = Math.max(0, endMs - startMs);
    return {
      signal: durationMs > 0 ? "session" : "last_touch",
      signalLabel: durationMs > 0 ? "Same-day span" : "Last touch",
      durationMs,
      duration: durationMs > 0 ? formatDuration(durationMs) : "—",
      start: formatClock(startMs),
      end: formatClock(endMs),
      workbooks,
      pings: 0,
    };
  }

  if (explicitTs.length === 1) {
    const t = explicitTs[0];
    const onlyFirst = rows.some(
      (row) => activeOnDay(row, day) && dayKey(row.first_accessed_at) === day && dayKey(row.last_accessed_at) !== day,
    );
    const onlyLast = rows.some(
      (row) => activeOnDay(row, day) && dayKey(row.last_accessed_at) === day && dayKey(row.first_accessed_at) !== day,
    );
    const signal = onlyFirst && !onlyLast ? "first_use" : onlyLast && !onlyFirst ? "last_touch" : "last_touch";
    const signalLabel =
      signal === "first_use" ? "First use" : signal === "last_touch" ? "Last touch" : "Touch";
    return {
      signal,
      signalLabel,
      durationMs: 0,
      duration: "—",
      start: formatClock(t),
      end: formatClock(t),
      workbooks,
      pings: 0,
    };
  }

  return {
    signal: "active_window",
    signalLabel: "Active window (inferred)",
    durationMs: 0,
    duration: "—",
    start: "—",
    end: "—",
    workbooks,
    pings: 0,
  };
}

function buildMonthGrid(year, month, dayMap) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const info = dayMap[date];
    cells.push(info ? { date, users: info.users } : { date, users: 0 });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

async function main() {
  const serviceRole = serviceRoleKey();
  const [sessions, events] = await Promise.all([
    loadSessions(serviceRole),
    loadActivityEvents(serviceRole),
  ]);

  const namesByEmail = new Map();
  for (const row of sessions) namesByEmail.set(row.email, row.name);
  for (const row of events) namesByEmail.set(row.email, row.name);

  const contribByEmail = new Map();
  for (const row of sessions) {
    if (!contribByEmail.has(row.email)) contribByEmail.set(row.email, []);
    contribByEmail.get(row.email).push(row);
  }

  const eventsByDayEmail = new Map();
  for (const ev of events) {
    const day = dayKey(ev.seen_at);
    const key = `${day}|${ev.email}`;
    if (!eventsByDayEmail.has(key)) eventsByDayEmail.set(key, []);
    eventsByDayEmail.get(key).push(ev);
  }

  const daySet = new Set();
  for (const row of sessions) {
    for (const day of daysBetween(row.first_accessed_at, row.last_accessed_at)) {
      daySet.add(day);
    }
  }
  for (const ev of events) daySet.add(dayKey(ev.seen_at));

  const dayDetails = {};
  let maxUsers = 0;
  let heartbeatDays = 0;

  for (const day of [...daySet].sort()) {
    const users = [];
    const emailsOnDay = new Set();

    for (const [key, dayEvents] of eventsByDayEmail.entries()) {
      const [eventDay, email] = key.split("|");
      if (eventDay !== day) continue;
      emailsOnDay.add(email);
      users.push({
        name: namesByEmail.get(email) || email,
        email,
        ...sessionFromEvents(dayEvents),
      });
    }

    for (const [email, rows] of contribByEmail.entries()) {
      if (emailsOnDay.has(email)) continue;
      const sess = sessionFromContributors(rows, day);
      if (!sess) continue;
      users.push({
        name: namesByEmail.get(email) || email,
        email,
        ...sess,
      });
    }

    if (!users.length) continue;
    if (users.some((u) => u.signal === "heartbeats")) heartbeatDays += 1;

    users.sort((a, b) => {
      const rank = { heartbeats: 0, session: 1, first_use: 2, last_touch: 3, active_window: 4 };
      const dr = (rank[a.signal] ?? 9) - (rank[b.signal] ?? 9);
      if (dr !== 0) return dr;
      return b.durationMs - a.durationMs;
    });

    maxUsers = Math.max(maxUsers, users.length);
    dayDetails[day] = { users: users.length, sessions: users };
  }

  const months = MONTHS.map(({ year, month, label }) => ({
    label,
    year,
    month,
    weeks: buildMonthGrid(
      year,
      month,
      Object.fromEntries(Object.entries(dayDetails).map(([d, v]) => [d, { users: v.users }])),
    ),
  }));

  const payload = {
    maxUsers: maxUsers || 1,
    months,
    dayDetails,
    weekdayLabels: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    heartbeatEvents: events.length,
    heartbeatDays,
    dataSource:
      events.length > 0
        ? "canvas_activity_events with contributor fallback for older days"
        : "canvas_contributors only (apply phase-12 migration + ship extension for heartbeats)",
  };

  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(
    JSON.stringify(
      {
        days: Object.keys(dayDetails).length,
        maxUsers,
        contributorRows: sessions.length,
        heartbeatEvents: events.length,
        heartbeatDays,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
