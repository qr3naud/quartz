#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/agent-tools/cohort-timeline.json";
const SUPABASE_URL = "https://hqlrnipieyeyikdyzeqt.supabase.co";
const CANVAS_ROWS_CACHE =
  "/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/agent-tools/canvas-rows.json";

const INTERNAL_WS = new Set([
  "Clay Team",
  "Clay Demos (GTM)",
  "Clay Solutions",
  "Q's Workspace",
  "Growth Strategy Demos - E",
]);
const INTERNAL_WS_IDS = new Set(["4515", "91642", "1047027", "584238", "1119306"]);

// chris.viglietta@clay.com and ethan.huang@clay.com were removed: their past
// "usage" was the maintainer impersonating them, not real adoption. They are
// also filtered out of the usage feeds in build-calendar-usage.mjs.
const ROSTER_EMAILS = [
  "greyson.lampley@clay.com", "nick.vandenberg@clay.com", "ryan.spychalski@clay.com",
  "ramin.parvin@clay.com", "shenez.ahmed@clay.com", "nick.goel@clay.com",
  "arturo.orozco@clay.com", "noah.scafati@clay.com",
  "jason.chapman@clay.com", "clayton.miller@clay.com",
  "liam.goldfarb@clay.com", "lara.garrido@clay.com", "tom.reha@clay.com",
  "lorcan.orourke@clay.com", "marat@clay.com", "mopi@clay.com",
  "julia.govberg@clay.com", "sachit.bhat@clay.com", "jeremie.cabling@clay.com",
  "tyler.cruver@clay.com", "quinn.igram@clay.com", "addison.ku@clay.com",
  "mohak.desai@clay.com", "arturo.mendoza@clay.com",
  "nate.segal@clay.com", "david.madding@clay.com", "travers.nammack@clay.com",
  "sab.glaser@clay.com", "alex.lindahl@clay.com", "jake.rainess@clay.com",
];

// Cohort comes from the SFDC User.Title (authoritative — User_Role_Type__c is
// null for every SE). "Solutions Engineer" / "GTM Solutions Engineer" -> SE;
// "GTM Engineer" or User_Role_Type__c GTME -> GTME; "Growth Strategist" / GS ->
// GS; anything else (e.g. Chief of Staff, no title) -> Other.
function classifyCohort(u) {
  const title = (u?.Title || "").toLowerCase();
  const roleType = (u?.User_Role_Type__c || "").toUpperCase();
  if (title.includes("solutions engineer")) return "SE";
  if (title.includes("gtm engineer") || roleType === "GTME") return "GTME";
  if (title.includes("growth strategist") || roleType === "GS") return "GS";
  return "Other";
}

function quartzUrl(ws, wb) {
  return `https://app.clay.com/workspaces/${ws}/workbooks/${wb}/#cb-open`;
}
function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function isInternal(wsName, wsId) {
  const name = (wsName || "").trim();
  // Customer workspace name from the Clay breadcrumb wins over workspace_id
  // (workbooks opened in a customer context can still carry an internal id).
  if (name && !INTERNAL_WS.has(name)) return false;
  return INTERNAL_WS.has(name) || INTERNAL_WS_IDS.has(String(wsId || ""));
}
function stripOppSuffix(name) {
  return (name || "").replace(/ -- .*/, "").trim();
}

const GENERIC_WORKBOOK = new Set([
  "poc",
  "scoping",
  "list enrichment",
  "custom table",
  "quartz test",
  "quartz_test",
  "clay poc",
  "poc workbook",
  "scoping workbook",
  "imported table",
  "new workbook",
  "untitled",
]);

function isGenericWorkbook(name) {
  const n = norm(name);
  if (!n || n.length < 3) return true;
  return GENERIC_WORKBOOK.has(n);
}

function isGenericTab(name) {
  const n = norm(name);
  return !n || n === "scoping" || n === "tab 1" || n === "tab 2";
}

function deriveDealLabel(c) {
  if (c.sfdc_opportunity_name) {
    return stripOppSuffix(c.sfdc_opportunity_name);
  }
  if (c.workspace_name && !isInternal(c.workspace_name, c.workspace_id)) {
    return c.workspace_name;
  }
  if (!isGenericWorkbook(c.workbook_name)) {
    return c.workbook_name;
  }
  return c.workbook_name;
}

function customerCandidates(table, tabNames = []) {
  const out = [];
  if (table.sfdcName) out.push(stripOppSuffix(table.sfdcName));
  if (table.workspaceName && !isInternal(table.workspaceName, table.workspaceId)) {
    out.push(table.workspaceName);
  }
  if (table.workbookName && !isGenericWorkbook(table.workbookName)) {
    out.push(table.workbookName);
  }
  for (const tab of tabNames) {
    if (!isGenericTab(tab)) out.push(tab);
  }
  return [...new Set(out.filter(Boolean))];
}

function scoreOppMatch(opp, candidates, table) {
  let score = 0;
  const oppName = opp.name || "";
  for (const cand of candidates) {
    if (fuzzyMatch(cand, opp.account)) score += 120;
    if (fuzzyMatch(cand, oppName)) score += 100;
  }
  if (table.workbookName && !isGenericWorkbook(table.workbookName)) {
    if (fuzzyMatch(table.workbookName, opp.account) || fuzzyMatch(table.workbookName, oppName)) {
      score += 70;
    }
  }
  if (table.workspaceName && !isInternal(table.workspaceName, table.workspaceId)) {
    if (fuzzyMatch(table.workspaceName, opp.account) || fuzzyMatch(table.workspaceName, oppName)) {
      score += 140;
    }
  }
  return score;
}

function pickBestOpp(ownerOpps, table, candidates) {
  let best = null;
  let bestScore = 0;
  for (const opp of ownerOpps) {
    const score = scoreOppMatch(opp, candidates, table);
    if (score > bestScore) {
      bestScore = score;
      best = opp;
    }
  }
  return bestScore >= 70 ? best : null;
}

function resolveCustomerLabel(table, matchedOpp) {
  if (table.sfdcName) return stripOppSuffix(table.sfdcName);
  if (matchedOpp?.account) return matchedOpp.account;
  if (table.workspaceName && !isInternal(table.workspaceName, table.workspaceId)) {
    return table.workspaceName;
  }
  if (!isGenericWorkbook(table.workbookName)) return table.workbookName;
  return table.workbookName;
}
function fuzzyMatch(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const aw = na.split(" ").filter((w) => w.length > 3);
  const bw = nb.split(" ").filter((w) => w.length > 3);
  return aw.some((w) => nb.includes(w)) || bw.some((w) => na.includes(w));
}
function money(n) {
  if (!n) return "-";
  if (n >= 1000) return "$" + Math.round(n / 1000) + "k";
  return "$" + n;
}

function mapOpp(o) {
  return {
    id: o.Id,
    name: o.Name || "",
    account: o.Account?.Name || "",
    stageFull: o.StageName || "",
    stageShort: (o.StageName || "").replace(/^\d+\.\s*/, ""),
    amount: o.Amount || 0,
    isClosed: !!o.IsClosed,
    isWon: o.IsWon == null ? null : !!o.IsWon,
    closeDate: o.CloseDate || null,
    poc: !!o.POC_Doc_Link__c,
    sfUrl: `https://clay.my.salesforce.com/lightning/r/Opportunity/${o.Id}/view`,
  };
}

function oppPayload(o) {
  if (!o) return null;
  return {
    stage: o.stageFull,
    amount: o.amount,
    closed: o.isClosed,
    won: o.isWon,
    closeDate: o.closeDate,
  };
}

async function sfdcAuth() {
  for (const line of readFileSync(resolve(REPO_ROOT, ".env.sfdc.prod"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
  const key = readFileSync(resolve(REPO_ROOT, process.env.SFDC_PRIVATE_KEY_PATH), "utf8");
  const b64u = (s) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const input = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64u(JSON.stringify({
    iss: process.env.SFDC_CLIENT_ID,
    sub: process.env.SFDC_USERNAME,
    aud: process.env.SFDC_LOGIN_URL,
    exp: now + 180,
  }));
  const sig = createSign("RSA-SHA256").update(input).sign(key).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const tok = await (await fetch(process.env.SFDC_LOGIN_URL.replace(/\/$/, "") + "/services/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: input + "." + sig }),
  })).json();
  const q = async (soql) => {
    const r = await fetch(tok.instance_url + "/services/data/v60.0/query?q=" + encodeURIComponent(soql), {
      headers: { Authorization: "Bearer " + tok.access_token },
    });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    let recs = j.records || [];
    let nr = j.nextRecordsUrl;
    while (nr) {
      const rr = await fetch(tok.instance_url + nr, { headers: { Authorization: "Bearer " + tok.access_token } });
      const jj = await rr.json();
      recs = recs.concat(jj.records || []);
      nr = jj.nextRecordsUrl;
    }
    return recs;
  };
  return { q };
}

async function loadCanvasRows(serviceRole) {
  const rows = [];
  let offset = 0;
  const pageSize = 200;
  while (true) {
    const url =
      `${SUPABASE_URL}/rest/v1/canvases?select=workbook_id,workbook_name,workspace_id,workspace_name,sfdc_opportunity_id,sfdc_opportunity_name,sfdc_opportunity_url,updated_at` +
      `&order=updated_at.desc&limit=${pageSize}&offset=${offset}`;
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
  return rows.map((c) => ({
    workbook_id: c.workbook_id,
    workbook_name: c.workbook_name,
    workspace_id: c.workspace_id,
    workspace_name: c.workspace_name,
    sfdc_opportunity_id: c.sfdc_opportunity_id,
    sfdc_opportunity_name: c.sfdc_opportunity_name,
    sfdc_opportunity_url: c.sfdc_opportunity_url,
    updated: (c.updated_at || "").slice(0, 10),
    rows: 0,
    tabs: 0,
  }));
}

async function loadTabNamesByWorkbook(serviceRole) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/canvas_tabs?select=workbook_id,name`,
    { headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` } },
  );
  const rows = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(rows));
  const byWb = new Map();
  for (const r of rows) {
    if (!byWb.has(r.workbook_id)) byWb.set(r.workbook_id, []);
    if (r.name) byWb.get(r.workbook_id).push(r.name);
  }
  return byWb;
}

function serviceRoleKey() {
  const key = execSync("supabase projects api-keys --project-ref hqlrnipieyeyikdyzeqt -o json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const serviceRole = JSON.parse(key).find((k) => k.name === "service_role")?.api_key;
  if (!serviceRole) throw new Error("service_role key not found");
  return serviceRole;
}

async function main() {
  const { q } = await sfdcAuth();
  const emailList = ROSTER_EMAILS.map((e) => `'${e}'`).join(",");
  const users = await q(`SELECT Id, Name, Email, Title, User_Role_Type__c FROM User WHERE Email IN (${emailList})`);
  const ownerIds = users.map((u) => `'${u.Id}'`).join(",");
  const opps = await q(`SELECT Id, Name, OwnerId, StageName, Account.Name, Amount, IsClosed, IsWon, CloseDate, POC_Doc_Link__c FROM Opportunity WHERE IsClosed = false AND StageName IN ('2. Discovery','3. Scoping','4. Validating') AND OwnerId IN (${ownerIds})`);

  const serviceRole = serviceRoleKey();
  const [canvasRowsLive, tabNamesByWb] = await Promise.all([
    loadCanvasRows(serviceRole),
    loadTabNamesByWorkbook(serviceRole),
  ]);
  const cachedRows = existsSync(CANVAS_ROWS_CACHE)
    ? JSON.parse(readFileSync(CANVAS_ROWS_CACHE, "utf8"))
    : [];
  const countsByWb = new Map(cachedRows.map((c) => [c.workbook_id, { rows: Number(c.rows) || 0, tabs: Number(c.tabs) || 0 }]));
  const canvasRows = canvasRowsLive.map((c) => {
    const counts = countsByWb.get(c.workbook_id) || { rows: 0, tabs: 0 };
    return { ...c, rows: counts.rows, tabs: counts.tabs };
  });
  writeFileSync(CANVAS_ROWS_CACHE, JSON.stringify(canvasRows, null, 2));

  const contribRows = JSON.parse(readFileSync("/Users/qr3naud/.cursor/projects/Users-qr3naud-Developer-clay-base-apps-quartz/agent-tools/contrib-rows.json", "utf8"));

  const tables = canvasRows.map((c) => ({
    workbookId: c.workbook_id,
    workbookName: c.workbook_name,
    workspaceId: c.workspace_id,
    workspaceName: c.workspace_name,
    sfdcId: c.sfdc_opportunity_id,
    sfdcName: c.sfdc_opportunity_name,
    sfdcUrl: c.sfdc_opportunity_url,
    updated: c.updated,
    rows: Number(c.rows),
    tabs: Number(c.tabs),
    tabNames: tabNamesByWb.get(c.workbook_id) || [],
    dealLabel: deriveDealLabel(c),
    quartzUrl: quartzUrl(c.workspace_id, c.workbook_id),
    internal: isInternal(c.workspace_name, c.workspace_id),
  }));

  const contribByWb = new Map();
  for (const r of contribRows) {
    if (!contribByWb.has(r.workbook_id)) contribByWb.set(r.workbook_id, []);
    contribByWb.get(r.workbook_id).push({ email: r.email, name: r.name, last: r.last_active });
  }

  const userByEmail = Object.fromEntries(users.filter((u) => u.Email).map((u) => [u.Email.toLowerCase(), u]));
  const oppById = new Map();
  const oppsByOwner = new Map();

  for (const o of opps) {
    const mapped = mapOpp(o);
    oppById.set(mapped.id, mapped);
    if (!oppsByOwner.has(o.OwnerId)) oppsByOwner.set(o.OwnerId, []);
    oppsByOwner.get(o.OwnerId).push(mapped);
  }

  const linkedIds = [...new Set(tables.filter((t) => t.sfdcId).map((t) => t.sfdcId))];
  if (linkedIds.length) {
    const linkedOpps = await q(
      `SELECT Id, Name, OwnerId, StageName, Account.Name, Amount, IsClosed, IsWon, CloseDate, POC_Doc_Link__c FROM Opportunity WHERE Id IN (${linkedIds.map((id) => `'${id}'`).join(",")})`,
    );
    for (const o of linkedOpps) {
      const mapped = mapOpp(o);
      oppById.set(mapped.id, mapped);
      if (!oppsByOwner.has(o.OwnerId)) oppsByOwner.set(o.OwnerId, []);
      if (!oppsByOwner.get(o.OwnerId).some((x) => x.id === mapped.id)) {
        oppsByOwner.get(o.OwnerId).push(mapped);
      }
    }
  }

  const matchedOppIds = new Set(tables.filter((t) => t.sfdcId).map((t) => t.sfdcId));

  // Pair tables without SFDC link to the best owner opp (workspace > workbook > tabs).
  for (const t of tables) {
    if (t.sfdcId) continue;
    const contributors = contribByWb.get(t.workbookId) || [];
    const candidates = customerCandidates(t, t.tabNames);
    let best = null;
    for (const c of contributors) {
      const owner = userByEmail[c.email?.toLowerCase()];
      if (!owner) continue;
      const ownerOpps = oppsByOwner.get(owner.Id) || [];
      const hit = pickBestOpp(ownerOpps, t, candidates);
      if (hit && (!best || scoreOppMatch(hit, candidates, t) > scoreOppMatch(best, candidates, t))) {
        best = hit;
      }
    }
    if (best) {
      t.inferredOppId = best.id;
      t.inferredAccount = best.account;
      matchedOppIds.add(best.id);
    }
  }

  for (const t of tables) {
    const oppId = t.sfdcId || t.inferredOppId;
    t.opp = oppId ? oppById.get(oppId) || null : null;
    t.dealLabel = resolveCustomerLabel(t, t.opp);
    t.customerSource = t.sfdcId
      ? "linked"
      : t.inferredOppId
        ? "inferred"
        : t.workspaceName && !t.internal
          ? "workspace"
          : isGenericWorkbook(t.workbookName)
            ? "workbook"
            : "workbook";
  }

  const people = ROSTER_EMAILS.map((email) => {
    const u = userByEmail[email];
    const name = u?.Name || email;
    const role = u?.User_Role_Type__c || "";
    const title = u?.Title || "";
    const cohort = classifyCohort(u);
    const ownerOpps = u ? (oppsByOwner.get(u.Id) || []) : [];

    const quartzTables = tables
      .filter((t) => (contribByWb.get(t.workbookId) || []).some((c) => c.email === email))
      .map((t) => {
        const contribs = contribByWb.get(t.workbookId) || [];
        const last = contribs.find((c) => c.email === email)?.last || t.updated;
        const oppId = t.sfdcId || t.inferredOppId;
        const opp = t.opp || (oppId ? oppById.get(oppId) : null);
        return {
          deal: t.dealLabel,
          workbook: t.workbookName,
          workspace: t.workspaceName || (t.internal ? "internal" : "-"),
          customerSource: t.customerSource,
          rows: t.rows,
          last,
          quartzUrl: t.quartzUrl,
          sfUrl: opp?.sfUrl || t.sfdcUrl || null,
          linked: !!t.sfdcId,
          inferred: !t.sfdcId && !!t.inferredOppId,
          opp: oppPayload(opp),
        };
      })
      .sort((a, b) => (b.last > a.last ? 1 : -1));

    const inQuartzOppIds = new Set();
    for (const qt of quartzTables) {
      const tbl = tables.find((t) => t.quartzUrl === qt.quartzUrl);
      if (tbl?.sfdcId) inQuartzOppIds.add(tbl.sfdcId);
      if (tbl?.inferredOppId) inQuartzOppIds.add(tbl.inferredOppId);
    }
    const pipelineNotInQuartz = ownerOpps
      .filter((o) => !inQuartzOppIds.has(o.id))
      .sort((a, b) => b.amount - a.amount)
      .map((o) => ({
        account: o.account,
        stage: o.stageShort,
        amount: o.amount,
        poc: o.poc,
        sfUrl: o.sfUrl,
        opp: oppPayload(o),
      }));

    const used = quartzTables.length > 0;
    const totalRows = quartzTables.reduce((s, t) => s + t.rows, 0);

    return {
      name,
      email,
      role,
      title,
      cohort,
      used,
      totalRows,
      tableCount: quartzTables.length,
      pipelineCount: ownerOpps.length,
      inQuartz: quartzTables,
      notInQuartz: pipelineNotInQuartz,
    };
  });

  people.sort((a, b) => {
    if (a.inQuartz.length && !b.inQuartz.length) return -1;
    if (!a.inQuartz.length && b.inQuartz.length) return 1;
    return b.totalRows - a.totalRows || b.notInQuartz.length - a.notInQuartz.length;
  });

  const COHORTS = ["SE", "GTME", "GS", "Other"];
  const cohortCounts = {};
  for (const c of COHORTS) {
    const group = people.filter((p) => p.cohort === c);
    cohortCounts[c] = { people: group.length, used: group.filter((p) => p.used).length };
  }

  // email (lowercased) -> cohort, so the calendar/weekly aggregation can tag
  // any active @clay.com user by cohort (non-roster emails default to Other).
  const roleByEmail = {};
  for (const p of people) roleByEmail[p.email.toLowerCase()] = p.cohort;

  const summary = {
    people: people.length,
    used: people.filter((p) => p.used).length,
    tables: people.reduce((s, p) => s + p.tableCount, 0),
    rows: people.reduce((s, p) => s + p.totalRows, 0),
    pipelineDeals: people.reduce((s, p) => s + p.pipelineCount, 0),
    inQuartzDeals: people.reduce((s, p) => s + p.inQuartz.length, 0),
    notInQuartzDeals: people.reduce((s, p) => s + p.notInQuartz.length, 0),
    cohortCounts,
  };

  writeFileSync(OUT, JSON.stringify({ summary, roleByEmail, people }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
