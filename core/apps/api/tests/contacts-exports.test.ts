// contacts' leads CSV end to end (alpha-p9-050; core/modules/contacts/README.md "Routes"): the host
// started with identity, whose resolver guards the workspace, and contacts, on the fake
// authentication adapter, in a schema of the worktree's database, answering real HTTP. The 46 leads
// are the valid rows of discovery's 50-row file, written as an import and qualification write them.
// It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import {
  applyQualification,
  createLeadForPerson,
  normalizeLinkedinUrl,
  upsertPersonFromSource,
  type WhyBullet,
} from "@whytide/contacts";
import { useContactsClient, useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useContactsClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "contacts", load: () => import("@whytide/contacts") },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

const COLUMNS =
  "first_name,last_name,headline,title,company,location,fit,tier,confidence,status,review,review_reason,review_text,source,why,linkedin_url";
const FIFTY_ROWS = resolve(import.meta.dirname, "../../tests/fixtures/discovery/fifty-rows.csv");
const why: WhyBullet[] = [
  {
    key: "qualification.why.fit",
    params: { criterion: "title_function", quote: "Head of Data", met: 4, total: 6 },
  },
  { key: "qualification.why.gap", params: { criterion: "company_size", more: 1 } },
];

/** The file's rows whose URL is a profile, once each: the 46 an import writes. */
function fixtureRows() {
  const rows = readFileSync(FIFTY_ROWS, "utf8").trim().split("\n").slice(1);
  const byUrl = new Map<string, { name: string; company: string }>();
  for (const [url = "", name = "", company = ""] of rows.map((row) => row.split(","))) {
    const linkedinUrl = normalizeLinkedinUrl(url);
    if (linkedinUrl && !byUrl.has(linkedinUrl)) byUrl.set(linkedinUrl, { name, company });
  }
  return [...byUrl].map(([linkedinUrl, row]) => ({ linkedinUrl, ...row }));
}

type Profile = { linkedinUrl: string; name: string; company: string };
/** The persons and their leads in the tenant's workspace, the i-th qualified at fit 99 - i. */
const seed = ({ workspace }: TestTenant, profiles: readonly Profile[]) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("contacts_test") },
    async () => {
      const ids: string[] = [];
      for (const [i, { linkedinUrl, name, company }] of profiles.entries()) {
        const profile = { linkedinUrl, name, companyName: company, title: "Head of Data" };
        const source = { source: "import", provider: "csv", profile } as const;
        const { person } = await upsertPersonFromSource(source);
        await createLeadForPerson({
          personId: person.id,
          source: { kind: "imported", ref: "imp_1" },
        });
        const fitScore = 99 - i;
        const tier = fitScore >= 75 ? "hot" : fitScore >= 60 ? "warm" : "cool";
        const decision = { status: "qualified", fitScore, confidence: "high", tier } as const;
        await applyQualification({ personId: person.id, ...decision, why: i === 0 ? why : [] });
        ids.push(person.id);
      }
      return ids;
    },
    { client: asRole("app") },
  );

/** A call to …/contacts/<path> in the tenant's workspace, as its Owner, from the app. */
async function call(tenant: TestTenant, method: string, path: string, body?: unknown) {
  const cookie = signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, origin: APP_ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/contacts/${path}`, api.url);
  return fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The CSV's rows, RFC 4180: quoted cells unquoted, a line break inside one kept. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (c === '"') quoted = !quoted;
    else if (!quoted && c === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && c === "\r" && text[i + 1] === "\n") {
      rows.push([...row, cell]);
      [row, cell] = [[], ""];
      i++;
    } else cell += c;
  }
  return rows;
}

/** The CSV of the view, as a raw body and its rows by column. */
async function csv(tenant: TestTenant, query = "") {
  const res = await call(tenant, "GET", `exports/leads.csv${query}`);
  const body = Buffer.from(await res.arrayBuffer());
  const [header = [], ...rows] = parseCsv(body.toString("utf8").replace(/^﻿/, ""));
  const named = rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i]])));
  return { res, body, header, rows: named };
}

test("GET …/contacts/exports/leads.csv: the 46 leads of the 50-row file, UTF-8 with a byte-order mark, the documented columns, `=SUM(A1)` as `'=SUM(A1)`, the why and a Not a fit's reason in English; the filters choose the rows", async () => {
  const [a] = await createTwoWorkspaces();
  const profiles = fixtureRows();
  assert.equal(profiles.length, 46);
  const formula = profiles[4];
  assert.ok(formula);
  formula.company = "=SUM(A1)";
  const ids = await seed(a, profiles);
  const reviewed = { decision: "not_a_fit", reasonCode: "company_wrong_size" };
  assert.equal((await call(a, "POST", `leads/${ids[1]}/review`, reviewed)).status, 201);

  const { res, body, header, rows } = await csv(a);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(
    res.headers.get("content-disposition") ?? "",
    /^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/,
  );
  assert.deepEqual([...body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(header.join(","), COLUMNS);
  assert.equal(rows.length, 46);
  assert.deepEqual(
    rows.map((row) => row.linkedin_url),
    profiles.map((profile) => profile.linkedinUrl),
  );
  assert.equal(rows[4]?.company, "'=SUM(A1)");
  assert.match(body.toString("utf8"), /,'=SUM\(A1\),/);
  assert.deepEqual(rows[0], {
    first_name: "Example",
    last_name: "Person 1",
    headline: "",
    title: "Head of Data",
    company: "Example Company 1",
    location: "",
    fit: "99",
    tier: "hot",
    confidence: "high",
    status: "qualified",
    review: "",
    review_reason: "",
    review_text: "",
    source: "imported",
    why: "Title and function: “Head of Data”, 4 of 6 criteria met\nNot enough data on company size and 1 more criterion",
    linkedin_url: "https://linkedin.com/in/example-person-1",
  });
  const second = rows[1] ?? {};
  assert.deepEqual(
    [second.review, second.review_reason, second.review_text],
    ["not_a_fit", "Wrong company size", ""],
  );

  const hot = await csv(a, "?status=qualified&tier=hot");
  assert.equal(hot.rows.length, 25);
  assert.ok(hot.rows.every((row) => row.tier === "hot"));
  const unreviewed = await csv(a, "?review=unreviewed");
  assert.equal(unreviewed.rows.length, 45);
  assert.ok(!unreviewed.rows.some((row) => row.review !== ""));
  const none = await csv(a, "?status=pending");
  assert.deepEqual([none.header.join(","), none.rows.length], [COLUMNS, 0]);
  const invalid = await call(a, "GET", "exports/leads.csv?tier=lukewarm");
  assert.deepEqual(
    [invalid.status, await invalid.json()],
    [
      400,
      {
        code: "validation_failed",
        details: { fields: ["tier"] },
      },
    ],
  );
});

test("two workspaces: each one's CSV holds its own leads only, and a member of one cannot export the other's", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ours = {
    linkedinUrl: "https://linkedin.com/in/ada-ours",
    name: "Ada Ours",
    company: "Ours",
  };
  const theirs = {
    linkedinUrl: "https://linkedin.com/in/ada-theirs",
    name: "Ada Theirs",
    company: "Theirs",
  };
  await seed(a, [ours]);
  await seed(b, [theirs, { ...ours, company: "Ours, seen by B" }]);

  const mine = await csv(a);
  assert.deepEqual(
    mine.rows.map((row) => [row.linkedin_url, row.company]),
    [[ours.linkedinUrl, "Ours"]],
  );
  assert.doesNotMatch(mine.body.toString("utf8"), /Theirs|seen by B/);
  const other = await csv(b);
  assert.deepEqual(
    other.rows.map((row) => row.linkedin_url),
    [theirs.linkedinUrl, ours.linkedinUrl],
  );
  const cookie = signInAs(a.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const url = new URL(`/v1/workspaces/${b.workspace.id}/contacts/exports/leads.csv`, api.url);
  const refused = await fetch(url, { headers: { cookie } });
  assert.deepEqual([refused.status, await refused.json()], [403, { code: "forbidden" }]);
});
