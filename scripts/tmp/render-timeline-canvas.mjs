#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const IN = "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/agent-tools/cohort-timeline.json";
const CALENDAR_IN = "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/agent-tools/calendar-usage.json";
const OUT = "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/canvases/quartz-table-usage-and-pipeline.canvas.tsx";

const { summary, people } = JSON.parse(readFileSync(IN, "utf8"));
const calendar = JSON.parse(readFileSync(CALENDAR_IN, "utf8"));

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
    workspace: t.workspace,
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
  return `  { name: "${esc(p.name)}", email: "${esc(p.email)}", role: "${esc(p.role || "")}", used: ${p.used}, totalRows: ${p.totalRows}, tableCount: ${p.tableCount}, pipelineCount: ${p.pipelineCount}, inQuartz: ${JSON.stringify(inQ)}, notInQuartz: ${JSON.stringify(notQ)} }`;
});

const linkedTables = people.reduce((s, p) => s + p.inQuartz.filter((t) => t.linked).length, 0);
const calendarJson = JSON.stringify(calendar);

const src = `import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  CollapsibleSection,
  Grid,
  H1,
  H3,
  Link,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  UsageBar,
  useCanvasState,
  useHostTheme,
} from "cursor/canvas";

const SNAPSHOT = "2026-06-25";

type DaySession = {
  name: string;
  email: string;
  signal: string;
  signalLabel: string;
  durationMs: number;
  duration: string;
  start: string;
  end: string;
  workbooks: number;
  pings: number;
};

type DayCell = { date: string; users: number } | null;

type CalendarMonth = {
  label: string;
  year: number;
  month: number;
  weeks: DayCell[][];
};

type CalendarData = {
  maxUsers: number;
  months: CalendarMonth[];
  dayDetails: Record<string, { users: number; sessions: DaySession[] }>;
  weekdayLabels: string[];
  heartbeatEvents: number;
  heartbeatDays: number;
  dataSource: string;
};

const CALENDAR: CalendarData = ${calendarJson};

type OppInfo = {
  stage: string;
  amount: number;
  closed: boolean;
  won: boolean | null;
  closeDate: string | null;
};

type QuartzTable = {
  deal: string;
  workbook: string;
  workspace: string;
  rows: number;
  last: string;
  quartzUrl: string;
  sfUrl: string | null;
  linked: boolean;
  inferred: boolean;
  opp: OppInfo | null;
};

type PipelineDeal = {
  account: string;
  stage: string;
  amount: number;
  poc: boolean;
  sfUrl: string;
  opp: OppInfo | null;
};

type Person = {
  name: string;
  email: string;
  role: string;
  used: boolean;
  totalRows: number;
  tableCount: number;
  pipelineCount: number;
  inQuartz: QuartzTable[];
  notInQuartz: PipelineDeal[];
};

const SUMMARY = {
  people: ${summary.people},
  used: ${summary.used},
  tables: ${summary.tables},
  rows: ${summary.rows},
  pipelineDeals: ${summary.pipelineDeals},
  inQuartzTables: ${summary.inQuartzDeals},
  notInQuartzDeals: ${summary.notInQuartzDeals},
  linkedTables: ${linkedTables},
};

const PEOPLE: Person[] = [
${peopleTs.join(",\n")}
];

type Filter = "all" | "inQuartz" | "notInQuartz";
type MainView = "timeline" | "calendar";

function segmentTrack(theme: ReturnType<typeof useHostTheme>) {
  return {
    display: "inline-flex",
    border: \`1px solid \${theme.stroke.secondary}\`,
    borderRadius: 8,
    padding: 2,
    gap: 2,
  } as const;
}

function segmentItem(active: boolean, theme: ReturnType<typeof useHostTheme>) {
  return {
    padding: "6px 14px",
    borderRadius: 6,
    cursor: "pointer",
    background: active ? theme.fill.secondary : "transparent",
  } as const;
}

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
  if (o.closed && o.won) return money(o.amount);
  if (o.closed) return money(o.amount);
  return money(o.amount) + " potential";
}

function oppNotes(o: OppInfo | null, poc = false): string {
  const parts: string[] = [];
  if (o?.closed && o.closeDate) parts.push("Closed " + o.closeDate);
  if (poc) parts.push("POC doc");
  return parts.join(" · ");
}

function heatStyle(users: number, max: number, accent: string, fillEmpty: string, selected: boolean, focused: string) {
  const ratio = max > 0 ? users / max : 0;
  const mix = users ? Math.round(18 + ratio * 72) : 0;
  return {
    background: users ? \`color-mix(in srgb, \${accent} \${mix}%, \${fillEmpty})\` : fillEmpty,
    border: selected ? \`2px solid \${focused}\` : "1px solid transparent",
    cursor: users ? "pointer" : "default",
    borderRadius: 6,
    minHeight: 52,
    width: 52,
    padding: 6,
    display: "flex",
    flexDirection: "column" as const,
    justifyContent: "space-between",
    gap: 2,
  };
}

function dayLabel(date: string): string {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function QuartzDealTimeline() {
  const theme = useHostTheme();
  const [mainView, setMainView] = useCanvasState<MainView>("mainView", "timeline");
  const [filter, setFilter] = useCanvasState<Filter>("filter", "all");
  const [selectedDay, setSelectedDay] = useCanvasState<string | null>("selectedDay", null);

  const selectedDetail = selectedDay ? CALENDAR.dayDetails[selectedDay] : null;

  const inQuartzDealCount = PEOPLE.reduce((s, p) => s + p.inQuartz.length, 0);
  const notInQuartzDealCount = PEOPLE.reduce((s, p) => s + p.notInQuartz.length, 0);
  const usedRate = Math.round((SUMMARY.used / SUMMARY.people) * 100);

  const visible = PEOPLE.filter((p) => {
    if (filter === "inQuartz") return p.inQuartz.length > 0;
    if (filter === "notInQuartz") return p.notInQuartz.length > 0;
    return p.inQuartz.length > 0 || p.notInQuartz.length > 0;
  });

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1080, color: theme.text.primary }}>
      <Stack gap={10}>
        <H1>Quartz adoption & deal coverage</H1>
        <div style={segmentTrack(theme)}>
          {(["timeline", "calendar"] as const).map((view) => (
            <div
              key={view}
              role="button"
              tabIndex={0}
              onClick={() => setMainView(view)}
              style={segmentItem(mainView === view, theme)}
            >
              <Text size="small" weight={mainView === view ? "semibold" : "regular"}>
                {view === "timeline" ? "Deal timeline" : "Usage calendar"}
              </Text>
            </div>
          ))}
        </div>
        <Text style={{ color: theme.text.secondary }}>
          {mainView === "timeline"
            ? \`Per-person deal coverage with SFDC stage and amount. Snapshot \${SNAPSHOT}. Excludes Quentin.\`
            : \`Daily usage heatmap from canvas heartbeats (5 min pings while open). \${CALENDAR.heartbeatEvents.toLocaleString()} events logged across \${CALENDAR.heartbeatDays} days. Older days fall back to inferred contributor windows. Snapshot \${SNAPSHOT}.\`}
        </Text>
      </Stack>

      {mainView === "calendar" && (
      <Card>
        <CardHeader trailing={<Text size="small" tone="tertiary">Peak {CALENDAR.maxUsers} users/day</Text>}>
          Usage calendar
        </CardHeader>
        <CardBody>
          <Stack gap={20}>
            <Row gap={8} style={{ flexWrap: "wrap" }}>
              {CALENDAR.weekdayLabels.map((label) => (
                <div key={label} style={{ width: 52, textAlign: "center" }}>
                  <Text size="small" tone="tertiary">{label}</Text>
                </div>
              ))}
            </Row>

            {CALENDAR.months.map((month) => (
              <Stack key={month.label} gap={8}>
                <H3>{month.label}</H3>
                <Stack gap={6}>
                  {month.weeks.map((week, wi) => (
                    <Row key={month.label + "-" + wi} gap={8} style={{ flexWrap: "nowrap" }}>
                      {week.map((cell, ci) =>
                        cell ? (
                          <div
                            key={cell.date}
                            role={cell.users ? "button" : undefined}
                            tabIndex={cell.users ? 0 : undefined}
                            onClick={cell.users ? () => setSelectedDay(cell.date) : undefined}
                            style={heatStyle(
                              cell.users,
                              CALENDAR.maxUsers,
                              theme.accent,
                              theme.fill.quaternary,
                              selectedDay === cell.date,
                              theme.stroke.focused,
                            )}
                          >
                            <Text size="small" style={{ color: theme.text.secondary }}>
                              {Number(cell.date.slice(8, 10))}
                            </Text>
                            {cell.users > 0 ? (
                              <Text size="small" weight="semibold">
                                {cell.users} {cell.users === 1 ? "user" : "users"}
                              </Text>
                            ) : (
                              <span />
                            )}
                          </div>
                        ) : (
                          <div key={month.label + "-pad-" + wi + "-" + ci} style={{ width: 52, minHeight: 52 }} />
                        ),
                      )}
                    </Row>
                  ))}
                </Stack>
              </Stack>
            ))}

            {selectedDay && selectedDetail && (
              <Stack gap={8}>
                <Row justify="space-between" align="center" style={{ flexWrap: "wrap", gap: 8 }}>
                  <Text weight="semibold">{dayLabel(selectedDay)}</Text>
                  <Pill active onClick={() => setSelectedDay(null)}>Clear</Pill>
                </Row>
                <Table
                  headers={["User", "Signal", "Duration", "Time (UTC)", "Pings", "Workbooks"]}
                  columnAlign={["left", "left", "right", "right", "right", "right"]}
                  rows={selectedDetail.sessions.map((s) => [
                    s.name,
                    s.signalLabel,
                    s.duration,
                    s.start === s.end ? s.start : \`\${s.start} → \${s.end}\`,
                    s.pings ? String(s.pings) : "—",
                    String(s.workbooks),
                  ])}
                />
                <Text size="small" tone="tertiary">
                  {CALENDAR.dataSource}. Duration sums heartbeat segments (10 min gap splits sessions; each ping
                  counts ~5 min of active time).
                </Text>
              </Stack>
            )}

            {!selectedDay && (
              <Text size="small" tone="tertiary">
                Click a shaded day to see who used Quartz and estimated session time from heartbeats.
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>
      )}

      {mainView === "timeline" && (
      <>
      <Grid columns={4} gap={12}>
        <Stat value={\`\${SUMMARY.used}/\${SUMMARY.people}\`} label="Built tables" tone="success" />
        <Stat value={String(inQuartzDealCount)} label="Tables in Quartz" />
        <Stat value={String(notInQuartzDealCount)} label="Pipeline not in Quartz" tone="warning" />
        <Stat value={String(SUMMARY.linkedTables)} label="SFDC-linked tables" />
      </Grid>

      <UsageBar
        total={inQuartzDealCount + notInQuartzDealCount}
        topLeftLabel="Pipeline coverage"
        topRightLabel={\`\${inQuartzDealCount} in Quartz · \${notInQuartzDealCount} pipeline-only\`}
        segments={[
          { id: "in", value: inQuartzDealCount, color: "green" },
          { id: "out", value: notInQuartzDealCount, color: "orange" },
        ]}
      />

      <Card>
        <CardHeader trailing={<Text size="small" tone="tertiary">{usedRate}% adoption</Text>}>
          Deal timeline by owner
        </CardHeader>
        <CardBody>
          <Stack gap={16}>
            <Row gap={8} style={{ flexWrap: "wrap" }}>
              {(["all", "inQuartz", "notInQuartz"] as const).map((f) => (
                <Pill key={f} active={filter === f} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "inQuartz" ? "In Quartz" : "Not in Quartz"}
                </Pill>
              ))}
            </Row>

            {visible.map((p) => {
              const showIn = filter !== "notInQuartz" && p.inQuartz.length > 0;
              const showOut = filter !== "inQuartz" && p.notInQuartz.length > 0;
              if (!showIn && !showOut) return null;

              const defaultOpen = p.inQuartz.some((t) => t.linked) || p.totalRows > 100 || p.notInQuartz.length >= 8;

              return (
                <CollapsibleSection
                  key={p.email}
                  title={p.name + (p.used ? "" : " — never used Quartz")}
                  count={p.inQuartz.length + p.notInQuartz.length}
                  defaultOpen={defaultOpen}
                  trailing={
                    <Text size="small" tone="tertiary">
                      {p.role || "-"} · {p.inQuartz.length} in Quartz · {p.notInQuartz.length} pipeline-only
                    </Text>
                  }
                >
                  <Stack gap={12}>
                    {showIn && (
                      <Stack gap={6}>
                        <H3>In Quartz ({p.inQuartz.length})</H3>
                        <Table
                          headers={["Deal", "Stage", "Amount", "Workbook", "Rows", "Last active", "Quartz", "Salesforce"]}
                          columnAlign={["left", "left", "right", "left", "right", "right", "left", "left"]}
                          rowTone={p.inQuartz.map((t) => (t.opp?.closed && t.opp.won ? "success" : t.linked ? "success" : undefined))}
                          rows={p.inQuartz.map((t) => [
                            t.deal,
                            stageLabel(t.opp),
                            amountLabel(t.opp),
                            t.workbook,
                            t.rows ? t.rows.toLocaleString() : "-",
                            t.last,
                            <Link href={t.quartzUrl}>Open table</Link>,
                            t.sfUrl ? (
                              <Link href={t.sfUrl}>{t.linked ? "Linked" : t.inferred ? "Inferred" : "Open"}</Link>
                            ) : (
                              "-"
                            ),
                          ])}
                        />
                      </Stack>
                    )}

                    {showIn && showOut && <Row style={{ borderTop: \`1px solid \${theme.stroke.tertiary}\` }} />}

                    {showOut && (
                      <Stack gap={6}>
                        <H3>Pipeline — not in Quartz ({p.notInQuartz.length})</H3>
                        <Table
                          headers={["Account", "Stage", "Amount", "Salesforce", "Notes"]}
                          columnAlign={["left", "left", "right", "left", "left"]}
                          rows={p.notInQuartz.map((d) => [
                            d.account,
                            stageLabel(d.opp, d.stage),
                            amountLabel(d.opp, money(d.amount)),
                            <Link href={d.sfUrl}>Open</Link>,
                            oppNotes(d.opp, d.poc),
                          ])}
                        />
                      </Stack>
                    )}
                  </Stack>
                </CollapsibleSection>
              );
            })}
          </Stack>
        </CardBody>
      </Card>

      <Callout tone="info" title="How deal labels are derived">
        <Text>
          Deal = customer name from the Clay breadcrumb workspace when it is not an internal workspace (Clay Team,
          Clay Demos, etc.). Generic workbook names (POC, List Enrichment, Scoping) fall back to SFDC account
          matching on workspace + workbook + tab names. Explicit SFDC links on the canvas always win. Opening Quartz
          from the customer workspace syncs workspace metadata automatically. {SUMMARY.used} of {SUMMARY.people} people
          have built at least one table; only {SUMMARY.linkedTables} tables have an explicit SFDC link.
        </Text>
      </Callout>
      </>
      )}

      <Text style={{ color: theme.text.tertiary, fontSize: 12 }}>
        Sources: Supabase canvases + contributors{CALENDAR.heartbeatEvents ? " + activity heartbeats" : ""} · Salesforce open opps (stages 2–4) · {SUMMARY.pipelineDeals} pipeline deals
      </Text>
    </Stack>
  );
}
`;

writeFileSync(OUT, src);
console.log("Wrote", OUT, "—", people.length, "people");
