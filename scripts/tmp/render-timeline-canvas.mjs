#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const BASE =
  "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/agent-tools";
const IN = `${BASE}/cohort-timeline.json`;
const CALENDAR_IN = `${BASE}/calendar-usage.json`;
const SESSIONS_IN = `${BASE}/session-contrib.json`;
const CANVAS_ROWS_IN = `${BASE}/canvas-rows.json`;
const OUT =
  "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/canvases/quartz-table-usage-and-pipeline.canvas.tsx";

const { summary, roleByEmail = {}, people } = JSON.parse(readFileSync(IN, "utf8"));
const calendar = JSON.parse(readFileSync(CALENDAR_IN, "utf8"));
const sessions = JSON.parse(readFileSync(SESSIONS_IN, "utf8"));
const canvasRows = JSON.parse(readFileSync(CANVAS_ROWS_IN, "utf8"));

const COHORTS = ["SE", "GTME", "GS", "Other"];
const cohortOf = (email) => roleByEmail[(email || "").toLowerCase()] || "Other";

// Internal / demo workspaces are excluded from the customer-table metrics so
// "tables created" reads as real customer scoping, not POC / test tables.
const INTERNAL_WS = new Set([
  "Clay Team",
  "Clay Demos (GTM)",
  "Clay Solutions",
  "Q's Workspace",
  "Growth Strategy Demos - E",
]);
const INTERNAL_WS_IDS = new Set(["4515", "91642", "1047027", "584238", "1119306"]);
function isInternal(name, id) {
  const n = (name || "").trim();
  if (n && !INTERNAL_WS.has(n)) return false;
  return INTERNAL_WS.has(n) || INTERNAL_WS_IDS.has(String(id || ""));
}

// Monday-anchored ISO week start (UTC).
function isoWeekStart(d) {
  const dt = new Date(d);
  const day = dt.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.toISOString().slice(0, 10);
}
function weekLabel(mon) {
  return new Date(mon + "T12:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
function eachWeek(minWk, maxWk) {
  const out = [];
  const cur = new Date(minWk + "T00:00:00Z");
  const end = new Date(maxWk + "T00:00:00Z");
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}
const zeroCohorts = () => Object.fromEntries(COHORTS.map((c) => [c, 0]));

const SNAPSHOT = new Date().toISOString().slice(0, 10);
const currentWeek = isoWeekStart(SNAPSHOT);

// --- Weekly active users (distinct emails per week, split by cohort) --------
const wauWeek = new Map();
for (const [day, info] of Object.entries(calendar.dayDetails || {})) {
  const wk = isoWeekStart(day);
  if (!wauWeek.has(wk)) {
    wauWeek.set(wk, {
      all: new Set(),
      byCohort: Object.fromEntries(COHORTS.map((c) => [c, new Set()])),
      heartbeat: false,
    });
  }
  const b = wauWeek.get(wk);
  for (const s of info.sessions || []) {
    b.all.add(s.email);
    b.byCohort[cohortOf(s.email)].add(s.email);
    if (s.signal === "heartbeats") b.heartbeat = true;
  }
}

// --- Creation proxy: earliest first_accessed_at per workbook ----------------
const firstByWb = new Map();
for (const r of sessions) {
  const ts = new Date(r.first_accessed_at).getTime();
  const cur = firstByWb.get(r.workbook_id);
  if (!cur || ts < cur.ts) firstByWb.set(r.workbook_id, { email: r.email, ts, iso: r.first_accessed_at });
}

// --- Tables created per week + SFDC linkage (customer tables only) ----------
const createdWeek = new Map();
let createdFallback = 0;
let createdTotal = 0;
let tablesTotal = 0;
let linkedTotal = 0;
const linkedByCohort = zeroCohorts();
const createdByCohort = zeroCohorts();
for (const c of canvasRows) {
  if (isInternal(c.workspace_name, c.workspace_id)) continue;
  tablesTotal++;
  const first = firstByWb.get(c.workbook_id);
  const cohort = first ? cohortOf(first.email) : "Other";
  if (c.sfdc_opportunity_id) {
    linkedTotal++;
    linkedByCohort[cohort]++;
  }
  const createdIso = first ? first.iso : c.updated ? c.updated + "T12:00:00Z" : null;
  if (!first && c.updated) createdFallback++;
  if (!createdIso) continue;
  const wk = isoWeekStart(createdIso);
  if (!createdWeek.has(wk)) createdWeek.set(wk, zeroCohorts());
  createdWeek.get(wk)[cohort]++;
  createdByCohort[cohort]++;
  createdTotal++;
}

// --- Assemble aligned weekly series -----------------------------------------
const dataWeekKeys = [...new Set([...wauWeek.keys(), ...createdWeek.keys()])].sort();
const minWk = dataWeekKeys[0] || currentWeek;
const maxData = dataWeekKeys[dataWeekKeys.length - 1] || currentWeek;
const maxWk = currentWeek > maxData ? currentWeek : maxData;
const weeks = eachWeek(minWk, maxWk);

const wauSeries = { total: [], ...Object.fromEntries(COHORTS.map((c) => [c, []])) };
const createdSeries = { total: [], ...Object.fromEntries(COHORTS.map((c) => [c, []])) };
const weekMeta = [];
let measuredFrom = null;
for (const wk of weeks) {
  const w = wauWeek.get(wk);
  for (const c of COHORTS) wauSeries[c].push(w ? w.byCohort[c].size : 0);
  wauSeries.total.push(w ? w.all.size : 0);
  const cr = createdWeek.get(wk);
  let ctot = 0;
  for (const c of COHORTS) {
    const v = cr ? cr[c] : 0;
    createdSeries[c].push(v);
    ctot += v;
  }
  createdSeries.total.push(ctot);
  const measured = !!(w && w.heartbeat);
  if (measured && !measuredFrom) measuredFrom = wk;
  weekMeta.push({ week: wk, label: weekLabel(wk), inferred: !measured, current: wk === currentWeek });
}

// Headline = most recent COMPLETE week with activity (skip the in-progress
// current week so the KPI is representative, not a partial-week dip). Fall back
// to the current week only if it's the only week with data.
let headlineWeek = null;
for (let i = weeks.length - 1; i >= 0; i--) {
  if (weeks[i] === currentWeek) continue;
  if ((wauWeek.get(weeks[i])?.all.size || 0) > 0) {
    headlineWeek = weeks[i];
    break;
  }
}
if (!headlineWeek) headlineWeek = currentWeek;
const hi = weeks.indexOf(headlineWeek);
const headline = {
  week: headlineWeek,
  label: weekLabel(headlineWeek),
  inProgress: headlineWeek === currentWeek,
  wau: {
    total: wauSeries.total[hi] || 0,
    ...Object.fromEntries(COHORTS.map((c) => [c, wauSeries[c][hi] || 0])),
  },
  created: {
    total: createdSeries.total[hi] || 0,
    ...Object.fromEntries(COHORTS.map((c) => [c, createdSeries[c][hi] || 0])),
  },
};

const WEEKLY = {
  weeks: weekMeta,
  wau: wauSeries,
  created: createdSeries,
  headline,
  linked: {
    total: linkedTotal,
    byCohort: linkedByCohort,
    tablesTotal,
    rate: tablesTotal ? linkedTotal / tablesTotal : 0,
  },
  createdAllTime: { total: createdTotal, byCohort: createdByCohort, fallback: createdFallback },
  wauPeak: Math.max(1, ...wauSeries.total),
  createdPeak: Math.max(1, ...createdSeries.total),
  inferredWeeks: weekMeta.filter((w) => w.inferred).length,
  measuredFromLabel: measuredFrom ? weekLabel(measuredFrom) : null,
};

// --- People (deal timeline detail) ------------------------------------------
function esc(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const peopleTs = people.map((p) => {
  const inQ = p.inQuartz.map((t) => ({
    deal: t.deal,
    workbook: t.workbook,
    rows: t.rows,
    last: t.last,
    quartzUrl: t.quartzUrl,
    sfUrl: t.sfUrl,
    linked: t.linked,
    inferred: t.inferred,
    opp: t.opp,
  }));
  const notQ = p.notInQuartz.map((o) => ({
    account: o.account,
    stage: o.stage,
    amount: o.amount,
    poc: o.poc,
    sfUrl: o.sfUrl,
    opp: o.opp,
  }));
  return `  { name: "${esc(p.name)}", email: "${esc(p.email)}", cohort: "${esc(p.cohort || "Other")}", title: "${esc(p.title || "")}", used: ${p.used}, totalRows: ${p.totalRows}, tableCount: ${p.tableCount}, pipelineCount: ${p.pipelineCount}, inQuartz: ${JSON.stringify(inQ)}, notInQuartz: ${JSON.stringify(notQ)} }`;
});

const fallbackNote = WEEKLY.createdAllTime.fallback
  ? " (" + WEEKLY.createdAllTime.fallback + " tables with no contributor fell back to last-updated)"
  : "";

const weeklyJson = JSON.stringify(WEEKLY);
const calendarJson = JSON.stringify(calendar);
const cohortCountsJson = JSON.stringify(summary.cohortCounts || {});

const src = `import {
  Grid,
  Link,
  Row,
  Stack,
  useCanvasState,
  useHostTheme,
} from "cursor/canvas";

const SNAPSHOT = "${SNAPSHOT}";

// Clay (Glaze) design tokens — blueberry accent, nightshade neutrals, matcha /
// tangerine / pomegranate semantics, Inter type, 8px card radius. Mirrored from
// apps/frontend/tokens so the canvas reads as Clay's UI and flips light/dark.
type Palette = {
  bg: string; raised: string; bgSecondary: string; bgTertiary: string;
  text: string; secondary: string; tertiary: string;
  border: string; borderSecondary: string; stripe: string;
  accent: string; accentText: string; selected: string;
  success: string; successBg: string;
  warning: string; warningBg: string;
  danger: string;
};
const CLAY_LIGHT: Palette = {
  bg: "#FFFFFF", raised: "#FFFFFF", bgSecondary: "#F7F8F9", bgTertiary: "#E6E8EC",
  text: "#16181F", secondary: "#3C414D", tertiary: "#697283",
  border: "#D6D9DF", borderSecondary: "#E6E8EC", stripe: "rgba(20,22,31,0.025)",
  accent: "#0382F7", accentText: "#0667D9", selected: "#D7EBFE",
  success: "#02693E", successBg: "#EEFFF1",
  warning: "#C34E1B", warningBg: "#FFF3ED",
  danger: "#DD2C53",
};
const CLAY_DARK: Palette = {
  bg: "#16181F", raised: "#282C35", bgSecondary: "#1F222A", bgTertiary: "#3C414D",
  text: "#FFFFFF", secondary: "#EFF1F3", tertiary: "#A9AFBA",
  border: "rgba(255,255,255,0.2)", borderSecondary: "rgba(255,255,255,0.12)", stripe: "rgba(255,255,255,0.03)",
  accent: "#3EA2FD", accentText: "#B8DDFF", selected: "#001F4B",
  success: "#5BD08A", successBg: "#0C2A1C",
  warning: "#F0A06B", warningBg: "#2E1A0E",
  danger: "#FE6E86",
};

type Cohort = "SE" | "GTME" | "GS" | "Other";
const COHORTS: Cohort[] = ["SE", "GTME", "GS", "Other"];
const COHORT_LABEL: Record<Cohort, string> = {
  SE: "Solutions Engineers",
  GTME: "GTM Engineers",
  GS: "Growth Strategists",
  Other: "Other / non-roster",
};
const COHORT_SHORT: Record<Cohort, string> = { SE: "SE", GTME: "GTME", GS: "GS", Other: "Other" };
const COHORT_COLORS_LIGHT: Record<Cohort, string> = {
  SE: "#0382F7", GTME: "#02693E", GS: "#C34E1B", Other: "#8A91A0",
};
const COHORT_COLORS_DARK: Record<Cohort, string> = {
  SE: "#3EA2FD", GTME: "#5BD08A", GS: "#F0A06B", Other: "#9AA1AD",
};

const FONT = "'Inter var', Inter, ui-sans-serif, system-ui, -apple-system, sans-serif";

type WeekMeta = { week: string; label: string; inferred: boolean; current: boolean };
type CohortNums = { total: number } & Record<Cohort, number>;
type WeeklyData = {
  weeks: WeekMeta[];
  wau: Record<string, number[]>;
  created: Record<string, number[]>;
  headline: { week: string; label: string; inProgress: boolean; wau: CohortNums; created: CohortNums };
  linked: { total: number; byCohort: Record<Cohort, number>; tablesTotal: number; rate: number };
  createdAllTime: { total: number; byCohort: Record<Cohort, number>; fallback: number };
  wauPeak: number;
  createdPeak: number;
  inferredWeeks: number;
  measuredFromLabel: string | null;
};
const WEEKLY: WeeklyData = ${weeklyJson};

const COHORT_COUNTS: Record<string, { people: number; used: number }> = ${cohortCountsJson};

type DaySession = {
  name: string; email: string; signal: string; signalLabel: string;
  durationMs: number; duration: string; start: string; end: string;
  workbooks: number; pings: number;
};
type DayCell = { date: string; users: number } | null;
type CalendarMonth = { label: string; year: number; month: number; weeks: DayCell[][] };
type CalendarData = {
  maxUsers: number; months: CalendarMonth[];
  dayDetails: Record<string, { users: number; sessions: DaySession[] }>;
  weekdayLabels: string[]; heartbeatEvents: number; heartbeatDays: number; dataSource: string;
};
const CALENDAR: CalendarData = ${calendarJson};

type OppInfo = { stage: string; amount: number; closed: boolean; won: boolean | null; closeDate: string | null };
type QuartzTable = {
  deal: string; workbook: string; rows: number; last: string;
  quartzUrl: string; sfUrl: string | null; linked: boolean; inferred: boolean; opp: OppInfo | null;
};
type PipelineDeal = { account: string; stage: string; amount: number; poc: boolean; sfUrl: string; opp: OppInfo | null };
type Person = {
  name: string; email: string; cohort: Cohort; title: string; used: boolean;
  totalRows: number; tableCount: number; pipelineCount: number;
  inQuartz: QuartzTable[]; notInQuartz: PipelineDeal[];
};

const SUMMARY = {
  people: ${summary.people}, used: ${summary.used}, tables: ${summary.tables}, rows: ${summary.rows},
  pipelineDeals: ${summary.pipelineDeals}, inQuartzTables: ${summary.inQuartzDeals}, notInQuartzDeals: ${summary.notInQuartzDeals},
};

const PEOPLE: Person[] = [
${peopleTs.join(",\n")}
];

type DealFilter = "all" | "inQuartz" | "notInQuartz";
type CohortFilter = "all" | Cohort;
type DetailView = "owner" | "calendar";

function money(n: number): string {
  if (!n) return "-";
  if (n >= 1000) return "$" + Math.round(n / 1000) + "k";
  return "$" + n;
}
function stageLabel(o: OppInfo | null, fallback = "-"): string {
  if (!o) return fallback;
  if (o.closed) return o.won ? "Closed Won" : "Closed Lost";
  return o.stage.replace(/^\\d+\\.\\s*/, "") || o.stage;
}
function amountLabel(o: OppInfo | null, fallback = "-"): string {
  if (!o || !o.amount) return fallback;
  if (o.closed) return money(o.amount);
  return money(o.amount) + " potential";
}
function oppNotes(o: OppInfo | null, poc = false): string {
  const parts: string[] = [];
  if (o?.closed && o.closeDate) parts.push("Closed " + o.closeDate);
  if (poc) parts.push("POC doc");
  return parts.join(" · ");
}
function pct(n: number): string {
  return Math.round(n * 100) + "%";
}
function dayLabel(date: string): string {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: "UTC",
  });
}

export default function QuartzAdoption() {
  const theme = useHostTheme();
  const light = theme.kind === "light" || theme.kind === "hc-light";
  const c: Palette = light ? CLAY_LIGHT : CLAY_DARK;
  const cohortColors = light ? COHORT_COLORS_LIGHT : COHORT_COLORS_DARK;

  const [detail, setDetail] = useCanvasState<DetailView>("detailView", "owner");
  const [dealFilter, setDealFilter] = useCanvasState<DealFilter>("dealFilter", "all");
  const [cohortFilter, setCohortFilter] = useCanvasState<CohortFilter>("cohortFilter", "all");
  const [selectedDay, setSelectedDay] = useCanvasState<string | null>("selectedDay", null);
  const [openRows, setOpenRows] = useCanvasState<Record<string, boolean>>("openRows", {});

  const selectedDetail = selectedDay ? CALENDAR.dayDetails[selectedDay] : null;
  const usedRate = Math.round((SUMMARY.used / SUMMARY.people) * 100);

  // --- Clay UI kit (hand-rolled to match Glaze) ------------------------------
  const dot = (color: string, size = 8) => (
    <span style={{ width: size, height: size, borderRadius: 9999, background: color, display: "inline-block", flexShrink: 0 }} />
  );

  const cohortDot = (k: Cohort) => dot(cohortColors[k]);

  const breakdown = (nums: Record<Cohort, number>) => (
    <Row gap={12} wrap style={{ rowGap: 4 }}>
      {COHORTS.map((k) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          {cohortDot(k)}
          <span style={{ fontSize: 12, color: c.secondary }}>{COHORT_SHORT[k]} {nums[k]}</span>
        </span>
      ))}
    </Row>
  );

  const legend = () => (
    <Row gap={16} wrap style={{ rowGap: 6 }}>
      {COHORTS.map((k) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {dot(cohortColors[k], 10)}
          <span style={{ fontSize: 12, color: c.secondary }}>{COHORT_LABEL[k]}</span>
        </span>
      ))}
    </Row>
  );

  const heading = (text: string, size = 20) => (
    <div style={{ fontSize: size, fontWeight: 700, color: c.text, letterSpacing: "-0.01em", fontFamily: FONT }}>{text}</div>
  );
  const caption = (node: any) => (
    <div style={{ fontSize: 12, lineHeight: "17px", color: c.tertiary }}>{node}</div>
  );

  const tile = (label: string, value: any, sub: string, footer: any) => (
    <div style={{
      background: c.raised, border: "1px solid " + c.border, borderRadius: 8,
      padding: 16, display: "flex", flexDirection: "column", gap: 10, minHeight: 120,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: c.secondary }}>{label}</div>
      <Row gap={8} align="center" style={{ flexWrap: "wrap" }}>
        <div style={{ fontSize: 30, lineHeight: "32px", fontWeight: 700, color: c.text, letterSpacing: "-0.02em" }}>{value}</div>
        <div style={{ fontSize: 12, color: c.tertiary }}>{sub}</div>
      </Row>
      {footer}
    </div>
  );

  const chip = (label: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        border: "1px solid " + (active ? c.accent : c.border),
        background: active ? c.selected : "transparent",
        color: active ? c.accentText : c.secondary,
        borderRadius: 9999, padding: "4px 12px", fontSize: 12, fontWeight: 500,
        cursor: "pointer", fontFamily: FONT,
      }}
    >
      {label}
    </button>
  );

  const segmented = (options: { id: string; label: string }[], value: string, onChange: (id: any) => void) => (
    <div style={{ display: "inline-flex", background: c.bgSecondary, border: "1px solid " + c.borderSecondary, borderRadius: 6, padding: 2, gap: 2 }}>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            style={{
              border: on ? "1px solid " + c.border : "1px solid transparent",
              background: on ? c.raised : "transparent",
              color: on ? c.text : c.tertiary,
              borderRadius: 4, padding: "5px 14px", fontSize: 13, fontWeight: on ? 600 : 500,
              cursor: "pointer", fontFamily: FONT,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );

  const dataTable = (headers: string[], align: string[], rows: any[][], accentRows?: (string | null)[]) => (
    <div style={{ border: "1px solid " + c.border, borderRadius: 8, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{
                textAlign: (align[i] as any) || "left", padding: "8px 12px",
                fontSize: 11, fontWeight: 600, color: c.secondary,
                background: c.bgSecondary, borderBottom: "1px solid " + c.borderSecondary, whiteSpace: "nowrap",
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} style={{ background: ri % 2 ? c.stripe : "transparent" }}>
              {r.map((cell, ci) => (
                <td key={ci} style={{
                  textAlign: (align[ci] as any) || "left", padding: "9px 12px", fontSize: 13,
                  color: c.text, borderTop: ri ? "1px solid " + c.borderSecondary : "none", verticalAlign: "top",
                }}>
                  {ci === 0 && accentRows && accentRows[ri] ? (
                    <Row gap={7} align="center">{dot(accentRows[ri] as string, 7)}<span>{cell}</span></Row>
                  ) : (
                    cell
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const alert = (tone: "warning" | "info", title: string, body: any) => {
    const bg = tone === "warning" ? c.warningBg : c.selected;
    const fg = tone === "warning" ? c.warning : c.accentText;
    return (
      <div style={{ background: bg, border: "1px solid " + fg + "55", borderRadius: 8, padding: "12px 14px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: fg, marginBottom: 6, fontFamily: FONT }}>{title}</div>
        <div style={{ fontSize: 13, lineHeight: "19px", color: c.text, fontFamily: FONT }}>{body}</div>
      </div>
    );
  };

  const link = (href: string, label: string) => (
    <Link href={href} style={{ color: c.accentText, fontFamily: FONT }}>{label}</Link>
  );

  const chevron = (open: boolean) => (
    <svg width="11" height="11" viewBox="0 0 16 16" style={{ transform: open ? "rotate(90deg)" : "none", flexShrink: 0 }}>
      <path d="M6 4l4 4-4 4" fill="none" stroke={c.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  // --- Hand-rolled stacked bar chart (Clay cohort colors) --------------------
  const bars = (cats: WeekMeta[], series: Record<string, number[]>, unit: string, peak: number) => {
    const H = 196;
    return (
      <Stack gap={8}>
        <Row gap={8} align="stretch">
          <div style={{ width: 26, height: H, display: "flex", flexDirection: "column", justifyContent: "space-between", alignItems: "flex-end", fontSize: 9, color: c.tertiary, paddingRight: 2 }}>
            <span>{peak}</span>
            <span>0</span>
          </div>
          <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 5, height: H, borderBottom: "1px solid " + c.border, borderTop: "1px solid " + c.borderSecondary }}>
            {cats.map((wk, i) => {
              const total = COHORTS.reduce((s, k) => s + series[k][i], 0);
              return (
                <div
                  key={wk.week}
                  title={"Week of " + wk.label + ": " + total + unit + (wk.inferred ? " (inferred)" : "")}
                  style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}
                >
                  <div style={{ borderRadius: 3, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "flex-end", opacity: wk.inferred ? 0.55 : 1 }}>
                    {COHORTS.map((k) => {
                      const v = series[k][i];
                      if (!v) return null;
                      return <div key={k} style={{ height: Math.max(2, (v / peak) * H), background: cohortColors[k] }} />;
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Row>
        <Row gap={5} style={{ paddingLeft: 34 }}>
          {cats.map((wk) => (
            <div key={wk.week} style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 9, color: wk.current ? c.accentText : c.tertiary, fontWeight: wk.current ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{wk.label}</div>
          ))}
        </Row>
      </Stack>
    );
  };

  const visible = PEOPLE.filter((p) => {
    if (cohortFilter !== "all" && p.cohort !== cohortFilter) return false;
    if (dealFilter === "inQuartz") return p.inQuartz.length > 0;
    if (dealFilter === "notInQuartz") return p.notInQuartz.length > 0;
    return p.inQuartz.length > 0 || p.notInQuartz.length > 0;
  });

  const unlinked = WEEKLY.linked.tablesTotal - WEEKLY.linked.total;

  return (
    <div style={{ background: c.bg, fontFamily: FONT, padding: 28, minHeight: "100%" }}>
      <Stack gap={24} style={{ maxWidth: 1080, margin: "0 auto", color: c.text }}>
        <Stack gap={6}>
          {heading("Quartz adoption", 30)}
          <div style={{ fontSize: 14, lineHeight: "20px", color: c.secondary }}>
            Weekly active users, customer tables, and Salesforce coverage for the GTM scoping cohort,
            split by role. Snapshot {SNAPSHOT}. Excludes the maintainer and two impersonation accounts.
          </div>
        </Stack>

        <Grid columns={4} gap={12}>
          {tile(
            "Weekly active users",
            WEEKLY.headline.wau.total,
            "wk of " + WEEKLY.headline.label + (WEEKLY.headline.inProgress ? " (in progress)" : ""),
            breakdown(WEEKLY.headline.wau),
          )}
          {tile(
            "Customer tables created",
            WEEKLY.headline.created.total,
            "wk of " + WEEKLY.headline.label,
            breakdown(WEEKLY.headline.created),
          )}
          {tile(
            "Linked to a Salesforce opp",
            WEEKLY.linked.total,
            pct(WEEKLY.linked.rate) + " of " + WEEKLY.linked.tablesTotal,
            breakdown(WEEKLY.linked.byCohort),
          )}
          {tile(
            "Built at least one table",
            SUMMARY.used + " / " + SUMMARY.people,
            usedRate + "% of roster",
            <Row gap={12} wrap style={{ rowGap: 4 }}>
              {COHORTS.filter((k) => COHORT_COUNTS[k]?.people).map((k) => (
                <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  {cohortDot(k)}
                  <span style={{ fontSize: 12, color: c.secondary }}>{COHORT_SHORT[k]} {COHORT_COUNTS[k].used}/{COHORT_COUNTS[k].people}</span>
                </span>
              ))}
            </Row>,
          )}
        </Grid>

        <Stack gap={12}>
          <Stack gap={4}>
            {heading("Weekly active users")}
            {caption(
              "Distinct users active per ISO week (Mon–Sun), stacked by role. Peak " + WEEKLY.wauPeak + " users/week. " +
              (WEEKLY.measuredFromLabel
                ? "Faded weeks before " + WEEKLY.measuredFromLabel + " are inferred from contributor first/last windows (over-count); from " + WEEKLY.measuredFromLabel + " on they are measured from 5-min heartbeats."
                : "All weeks are inferred from contributor windows — heartbeats are not yet accumulating, so these over-count actives.") +
              " Source: Supabase · " + SNAPSHOT,
            )}
          </Stack>
          {legend()}
          {bars(WEEKLY.weeks, WEEKLY.wau, " users", WEEKLY.wauPeak)}
        </Stack>

        <Stack gap={12}>
          <Stack gap={4}>
            {heading("Customer tables created per week")}
            {caption(
              "New Quartz tables by creation week (earliest contributor touch), stacked by creator role. Excludes internal / demo workspaces. " +
              WEEKLY.createdAllTime.total + " customer tables to date. Source: Supabase canvases + contributors · " + SNAPSHOT,
            )}
          </Stack>
          {legend()}
          {bars(WEEKLY.weeks, WEEKLY.created, " tables", WEEKLY.createdPeak)}
        </Stack>

        <Stack gap={12}>
          {heading("Salesforce linkage")}
          <div>
            <Row justify="space-between" align="center" style={{ marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: c.secondary }}>{pct(WEEKLY.linked.rate)} linked to an opportunity</span>
              <span style={{ fontSize: 12, color: c.tertiary }}>{WEEKLY.linked.total} linked · {unlinked} unlinked</span>
            </Row>
            <div style={{ display: "flex", height: 10, borderRadius: 9999, overflow: "hidden", background: c.bgTertiary }}>
              <div style={{ width: pct(WEEKLY.linked.rate), background: c.accent }} />
            </div>
          </div>
          {dataTable(
            ["Role", "Customer tables", "Explicitly linked", "Link rate"],
            ["left", "right", "right", "right"],
            COHORTS.map((k) => {
              const created = WEEKLY.createdAllTime.byCohort[k] || 0;
              const linked = WEEKLY.linked.byCohort[k] || 0;
              return [COHORT_LABEL[k], String(created), String(linked), created ? pct(linked / created) : "-"];
            }),
            COHORTS.map((k) => cohortColors[k]),
          )}
          {caption(
            "\\"Linked\\" counts tables with an explicit SFDC opportunity link. Many more are matched to a deal by workspace / name inference in the timeline below, so true deal coverage is higher than the explicit-link rate.",
          )}
        </Stack>

        {alert(
          "warning",
          "How usage is recognized — read before trusting the numbers",
          <Stack gap={6}>
            <span>
              "Active" means the Quartz canvas was open or saved by a rep running the extension (v7.74+),
              heartbeating every ~5 min — not Clay usage in general. A rep who scopes entirely in the Clay
              grid without opening the canvas is invisible here.
            </span>
            <span>
              Heartbeats are not yet accumulating, so all {WEEKLY.inferredWeeks} weeks fall back to contributor
              first/last windows, which mark a user active on every day in between and therefore over-count
              weekly actives. "Created" uses the earliest contributor touch as a proxy — there is no real
              created_at on the canvas row${fallbackNote}.
              Internal / demo workspaces are excluded from table counts but not from active users.
            </span>
          </Stack>,
        )}

        {alert(
          "info",
          "Proposal to improve the metrics",
          <Stack gap={6}>
            <span>1. Add a real created_at column to the canvases row (DB default now()) so creation is authoritative instead of the first-touch proxy.</span>
            <span>2. Make canvas_activity_events the sole basis for weekly actives with an explicit "metrics start" date, and drop inferred contributor windows so WAU stops over-counting.</span>
            <span>3. Track explicit Salesforce link rate as a first-class KPI and auto-link on workspace match (the extension already auto-links when an opp is picked), so coverage is measured, not inferred.</span>
            <span>4. Define "table" precisely (workbook vs Clay tab) and persist the SFDC Title-based cohort in the pipeline so role splits stay stable.</span>
          </Stack>,
        )}

        <div style={{ borderTop: "1px solid " + c.borderSecondary }} />

        <Stack gap={14}>
          <Row justify="space-between" align="center" style={{ flexWrap: "wrap", gap: 10 }}>
            {heading("Detail")}
            {segmented(
              [{ id: "owner", label: "By owner" }, { id: "calendar", label: "Usage calendar" }],
              detail,
              (v) => setDetail(v as DetailView),
            )}
          </Row>

          {detail === "owner" && (
            <Stack gap={14}>
              <Row gap={16} wrap align="center">
                <Row gap={6}>
                  {(["all", "SE", "GTME", "GS"] as const).map((k) => (
                    <span key={k} style={{ display: "inline-flex" }}>
                      {chip(k === "all" ? "All roles" : COHORT_SHORT[k as Cohort], cohortFilter === k, () => setCohortFilter(k))}
                    </span>
                  ))}
                </Row>
                <Row gap={6}>
                  {(["all", "inQuartz", "notInQuartz"] as const).map((f) => (
                    <span key={f} style={{ display: "inline-flex" }}>
                      {chip(
                        f === "all" ? "All deals" : f === "inQuartz" ? "In Quartz" : "Pipeline only",
                        dealFilter === f,
                        () => setDealFilter(f),
                      )}
                    </span>
                  ))}
                </Row>
              </Row>

              <Stack gap={0}>
                {visible.map((p) => {
                  const showIn = dealFilter !== "notInQuartz" && p.inQuartz.length > 0;
                  const showOut = dealFilter !== "inQuartz" && p.notInQuartz.length > 0;
                  if (!showIn && !showOut) return null;
                  const open = openRows[p.email] ?? (p.inQuartz.some((t) => t.linked) || p.totalRows > 100);
                  return (
                    <div key={p.email}>
                      <div
                        onClick={() => setOpenRows({ ...openRows, [p.email]: !open })}
                        style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 0", cursor: "pointer", borderTop: "1px solid " + c.borderSecondary }}
                      >
                        {chevron(open)}
                        {cohortDot(p.cohort)}
                        <span style={{ fontSize: 14, fontWeight: 600, color: c.text }}>{p.name}</span>
                        {!p.used && <span style={{ fontSize: 12, color: c.tertiary }}>— never used Quartz</span>}
                        <span style={{ marginLeft: "auto", fontSize: 12, color: c.tertiary }}>
                          {COHORT_SHORT[p.cohort]} · {p.inQuartz.length} in Quartz · {p.notInQuartz.length} pipeline-only
                        </span>
                      </div>
                      {open && (
                        <Stack gap={12} style={{ padding: "4px 0 16px 24px" }}>
                          {showIn && (
                            <Stack gap={6}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: c.secondary }}>In Quartz ({p.inQuartz.length})</div>
                              {dataTable(
                                ["Deal", "Stage", "Amount", "Workbook", "Rows", "Last active", "Quartz", "Salesforce"],
                                ["left", "left", "right", "left", "right", "right", "left", "left"],
                                p.inQuartz.map((t) => [
                                  t.deal,
                                  stageLabel(t.opp),
                                  amountLabel(t.opp),
                                  t.workbook,
                                  t.rows ? t.rows.toLocaleString() : "-",
                                  t.last,
                                  link(t.quartzUrl, "Open"),
                                  t.sfUrl ? link(t.sfUrl, t.linked ? "Linked" : t.inferred ? "Inferred" : "Open") : "-",
                                ]),
                                p.inQuartz.map((t) => (t.linked ? c.success : null)),
                              )}
                            </Stack>
                          )}
                          {showOut && (
                            <Stack gap={6}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: c.secondary }}>Pipeline — not in Quartz ({p.notInQuartz.length})</div>
                              {dataTable(
                                ["Account", "Stage", "Amount", "Salesforce", "Notes"],
                                ["left", "left", "right", "left", "left"],
                                p.notInQuartz.map((d) => [
                                  d.account,
                                  stageLabel(d.opp, d.stage),
                                  amountLabel(d.opp, money(d.amount)),
                                  link(d.sfUrl, "Open"),
                                  oppNotes(d.opp, d.poc),
                                ]),
                              )}
                            </Stack>
                          )}
                        </Stack>
                      )}
                    </div>
                  );
                })}
              </Stack>
            </Stack>
          )}

          {detail === "calendar" && (
            <Stack gap={16}>
              {caption("Daily usage heatmap. Peak " + CALENDAR.maxUsers + " users/day. Click a shaded day for session detail.")}
              <Row gap={8} style={{ flexWrap: "wrap" }}>
                {CALENDAR.weekdayLabels.map((label) => (
                  <div key={label} style={{ width: 52, textAlign: "center", fontSize: 11, color: c.tertiary }}>{label}</div>
                ))}
              </Row>
              {CALENDAR.months.map((month) => (
                <div key={month.label} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: c.secondary }}>{month.label}</div>
                  <Stack gap={6}>
                    {month.weeks.map((week, wi) => (
                      <div key={month.label + "-" + wi} style={{ display: "flex", gap: 8, flexWrap: "nowrap" }}>
                        {week.map((cell, ci) =>
                          cell ? (
                            <div
                              key={cell.date}
                              role={cell.users ? "button" : undefined}
                              onClick={cell.users ? () => setSelectedDay(cell.date) : undefined}
                              style={{
                                width: 52, minHeight: 52, padding: 6, borderRadius: 6,
                                display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 2,
                                cursor: cell.users ? "pointer" : "default",
                                background: cell.users ? "color-mix(in srgb, " + c.accent + " " + Math.round(18 + (cell.users / CALENDAR.maxUsers) * 72) + "%, " + c.bgSecondary + ")" : c.bgSecondary,
                                border: selectedDay === cell.date ? "2px solid " + c.accent : "1px solid " + c.borderSecondary,
                              }}
                            >
                              <span style={{ fontSize: 11, color: cell.users ? c.text : c.tertiary }}>{Number(cell.date.slice(8, 10))}</span>
                              {cell.users > 0 ? (
                                <span style={{ fontSize: 11, fontWeight: 600, color: c.text }}>{cell.users} {cell.users === 1 ? "user" : "users"}</span>
                              ) : (
                                <span />
                              )}
                            </div>
                          ) : (
                            <div key={month.label + "-pad-" + wi + "-" + ci} style={{ width: 52, minHeight: 52 }} />
                          ),
                        )}
                      </div>
                    ))}
                  </Stack>
                </div>
              ))}
              {selectedDay && selectedDetail && (
                <Stack gap={8}>
                  <Row justify="space-between" align="center" style={{ flexWrap: "wrap", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: c.text }}>{dayLabel(selectedDay)}</span>
                    {chip("Clear", true, () => setSelectedDay(null))}
                  </Row>
                  {dataTable(
                    ["User", "Signal", "Duration", "Time (UTC)", "Pings", "Workbooks"],
                    ["left", "left", "right", "right", "right", "right"],
                    selectedDetail.sessions.map((s) => [
                      s.name, s.signalLabel, s.duration,
                      s.start === s.end ? s.start : s.start + " → " + s.end,
                      s.pings ? String(s.pings) : "—", String(s.workbooks),
                    ]),
                  )}
                </Stack>
              )}
            </Stack>
          )}
        </Stack>

        {caption(
          "Sources: Supabase canvases + contributors" + (CALENDAR.heartbeatEvents ? " + activity heartbeats" : "") +
          " · Salesforce open opps (stages 2–4) · " + SUMMARY.pipelineDeals + " pipeline deals · cohort from SFDC User.Title",
        )}
      </Stack>
    </div>
  );
}
`;

writeFileSync(OUT, src);
console.log("Wrote", OUT, "—", people.length, "people,", WEEKLY.weeks.length, "weeks");
