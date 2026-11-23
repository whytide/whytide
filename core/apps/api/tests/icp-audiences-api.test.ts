// icp's audiences end to end (gamma-p3-020; core/modules/icp/README.md "Routes"): the host started
// with identity and icp, on the fake authentication adapter, in a schema of the worktree's database,
// answering real HTTP; a write sends the app's Origin and, to the draft's routes, an
// Idempotency-Key. The audiences' routes, the limit, another workspace's id on every route that names
// one, and the draft's routes with ?icpId=; no worker runs here: the test writes the audience as the
// drafter leaves it. The events are read from the outbox. The list answers the audiences' limit,
// the setting's default here (limits-env). It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// icp by its build's path, as icp-api.test.ts loads it: the api's dev dependency would close a cycle.
const icp = new URL("../../../../modules/icp/dist/index.js", import.meta.url).href;
const db = withTestDb();
useTenancyClient(asRole("app"));
const modules: ModuleLoader[] = [
  { name: "identity", load: () => import("@whytide/identity") },
  { name: "icp", load: () => import(icp) },
];
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules,
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

type Member = { readonly userId: string; readonly workspaceId: string; readonly cookie: string };
type Answer = { readonly status: number; readonly body: Record<string, unknown> };
type Listed = { readonly id: string; readonly name: string; readonly isDefault: boolean };

const EMPTY = {
  name: "",
  titles: [],
  seniorities: [],
  industries: [],
  sizeRanges: [],
  countries: [],
  mustHaves: "",
  disqualifiers: "",
};
const TARGETING = { ...EMPTY, name: "Logistics founders", titles: ["Founder"], countries: ["FR"] };
const DEFAULTS = [
  { key: "title_function", weight: 30, isMust: true, enabled: true },
  { key: "seniority", weight: 15, isMust: false, enabled: true },
  { key: "company_size", weight: 10, isMust: false, enabled: true },
  { key: "industry", weight: 15, isMust: false, enabled: true },
  { key: "location", weight: 10, isMust: true, enabled: true },
  { key: "must_haves", weight: 20, isMust: false, enabled: true },
];
/** The defaults with ten points moved from industry to seniority. */
const MOVED = DEFAULTS.map((row) =>
  row.key === "industry"
    ? { ...row, weight: 5 }
    : row.key === "seniority"
      ? { ...row, weight: 25 }
      : row,
);
/** What a good model proposes, as the drafter's pending draft carries it. */
const PROPOSAL = {
  name: "Bakery owners",
  titles: ["Owner", "Head of Finance"],
  seniorities: ["owner_founder", "head"],
  industries: ["Food and beverage"],
  sizeRanges: ["11-50"],
  countries: ["FR"],
  mustHaves: "Runs two bakeries or more",
  disqualifiers: "",
};

/** The Owners of two new workspaces, each signed in. */
async function members(): Promise<[Member, Member]> {
  const [a, b] = await createTwoWorkspaces();
  const signedIn = (userId: string, workspaceId: string): Member => {
    const cookie = signInAs(userId)
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
    return { userId, workspaceId, cookie };
  };
  return [signedIn(a.user.id, a.workspace.id), signedIn(b.user.id, b.workspace.id)];
}

/** A call to …/icp`path`; a write with the app's Origin, a POST to the draft's with a new key. */
async function call(who: Member, method: string, path: string, body?: object): Promise<Answer> {
  const url = new URL(`/v1/workspaces/${who.workspaceId}/icp${path}`, api.url);
  const key = path.startsWith("/draft") ? { "idempotency-key": randomUUID() } : {};
  const write = { origin: APP_ORIGIN, "content-type": "application/json", ...key };
  const res = await fetch(url, {
    method,
    headers: { cookie: who.cookie, ...(method === "GET" ? {} : write) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The payloads of `eventName` the workspace published, oldest first. */
async function published(workspaceId: string, eventName: string): Promise<unknown[]> {
  const where = { workspaceId, eventName };
  const rows = await asRole("app").outboxEntry.findMany({ where, orderBy: { id: "asc" } });
  return rows.map((row) => row.payload);
}

/** An audience's answer without its id and time, which change with every run. */
const fieldsOf = ({ body: { id: _id, updatedAt: _at, ...rest } }: Answer) => rest;
const refused = (status: number, code: string, details?: object) => ({
  status,
  body: details === undefined ? { code } : { code, details },
});
const listOf = async (who: Member) =>
  (await call(who, "GET", "/audiences")).body.audiences as Listed[];

test("POST …/icp/audiences is 201 with the audience, its creator the member; GET lists the default first, then by name; an audience's routes and its criteria's act on it alone, with icp.audience_updated; the ICP's routes keep the default, whose save publishes both events", async () => {
  const [who] = await members();
  const { workspaceId } = who;
  const created = await call(who, "POST", "/audiences", { name: "  Logistics founders " });
  const { id, updatedAt, ...made } = created.body;
  assert.equal(created.status, 201);
  assert.match(String(id), /^icp_[0-9A-Z]{26}$/);
  assert.ok(!Number.isNaN(Date.parse(String(updatedAt))), String(updatedAt));
  const audience = { name: "Logistics founders", isDefault: false, createdBy: who.userId };
  assert.deepEqual(made, { ...audience, version: 1 });
  assert.equal((await call(who, "POST", "/audiences", { name: "Bakeries" })).status, 201);
  const listed = (await call(who, "GET", "/audiences")).body.audiences as Record<string, unknown>[];
  assert.deepEqual(
    listed.map((row) => [row.name, row.isDefault, row.createdBy, row.version]),
    [
      ["", true, who.userId, 1],
      ["Bakeries", false, who.userId, 1],
      ["Logistics founders", false, who.userId, 1],
    ],
  );

  const path = `/audiences/${String(id)}`;
  const named = { ...EMPTY, name: audience.name, version: 1 };
  assert.deepEqual(fieldsOf(await call(who, "GET", path)), named);
  const saved = await call(who, "PUT", path, TARGETING);
  assert.deepEqual([saved.status, fieldsOf(saved)], [200, { ...TARGETING, version: 2 }]);
  assert.deepEqual(await call(who, "GET", path), saved, "a reload shows what was saved");
  const moved = { status: 200, body: { criteria: MOVED } };
  assert.deepEqual(await call(who, "PUT", `${path}/criteria`, { criteria: MOVED }), moved);
  assert.deepEqual(await call(who, "GET", `${path}/criteria`), moved);

  const theDefault = await call(who, "GET", "");
  assert.deepEqual(fieldsOf(theDefault), { ...EMPTY, version: 1 });
  assert.deepEqual((await call(who, "GET", "/criteria")).body, { criteria: DEFAULTS });
  const audienceV2 = { workspaceId, icpId: id, version: 2 };
  assert.deepEqual(await published(workspaceId, "icp.audience_updated"), [audienceV2]);
  assert.deepEqual(await published(workspaceId, "icp.updated"), []);

  assert.equal((await call(who, "PUT", "", { ...EMPTY, titles: ["CFO"] })).status, 200);
  assert.deepEqual(await published(workspaceId, "icp.updated"), [{ workspaceId, version: 2 }]);
  assert.deepEqual(await published(workspaceId, "icp.audience_updated"), [
    audienceV2,
    { workspaceId, icpId: theDefault.body.id, version: 2 },
  ]);
  assert.deepEqual(fieldsOf(await call(who, "GET", path)), { ...TARGETING, version: 2 });
});

test("POST …/icp/audiences: a blank name or one of 81 characters is 400 validation_failed; past ten audiences, the default included, 409 icp_audience_limit with the limit, also for two creates at once", async () => {
  const [who] = await members();
  const create = (name: string) => call(who, "POST", "/audiences", { name });
  const invalid = refused(400, "validation_failed", { fields: ["name"] });
  assert.deepEqual(await create("   "), invalid);
  assert.deepEqual(await create("x".repeat(81)), invalid);
  for (let at = 1; at <= 8; at++) assert.equal((await create(`Audience ${at}`)).status, 201);
  assert.equal((await listOf(who)).length, 9);
  const racing = await Promise.all([create("Racer A"), create("Racer B")]);
  assert.deepEqual(racing.map((answer) => answer.status).sort(), [201, 409]);
  const limit = refused(409, "icp_audience_limit", { limit: 10 });
  assert.deepEqual(
    racing.find((answer) => answer.status === 409),
    limit,
  );
  assert.equal((await listOf(who)).length, 10);
  assert.deepEqual(await create("Eleventh"), limit);
  assert.equal((await listOf(who)).length, 10);
});

test("GET …/icp/audiences answers limits.audiences, ICP_MAX_AUDIENCES_PER_WORKSPACE, 10 unset (limits-env)", async () => {
  const [who] = await members();
  const listed = await call(who, "GET", "/audiences");
  assert.deepEqual([listed.status, listed.body.limits], [200, { audiences: 10 }]);
});

test("another workspace's audience is 404 icp_not_found on every route that names one, the draft's ?icpId= included; it is not listed and stays as it was", async () => {
  const [who, them] = await members();
  const theirs = String((await call(them, "POST", "/audiences", { name: "Theirs" })).body.id);
  const path = `/audiences/${theirs}`;
  const query = `?icpId=${theirs}`;
  const calls: [string, string, object?][] = [
    ["GET", path],
    ["PUT", path, TARGETING],
    ["GET", `${path}/criteria`],
    ["PUT", `${path}/criteria`, { criteria: MOVED }],
    ["GET", `/draft${query}`],
    ["POST", `/draft${query}`, { brief: "Bakeries in France" }],
    ["POST", `/draft/accept${query}`, { replace: true, runId: "idrun_none" }],
    ["POST", `/draft/discard${query}`, {}],
  ];
  for (const [method, at, body] of calls) {
    assert.deepEqual(
      await call(who, method, at, body),
      refused(404, "icp_not_found"),
      `${method} ${at}`,
    );
  }
  assert.ok((await listOf(who)).every((audience) => audience.id !== theirs));
  const kept = await call(them, "GET", path);
  assert.deepEqual(fieldsOf(kept), { ...EMPTY, name: "Theirs", version: 1 });
  assert.deepEqual((await call(them, "GET", `${path}/criteria`)).body, { criteria: DEFAULTS });
  assert.deepEqual(await published(them.workspaceId, "icp.audience_updated"), []);
  assert.deepEqual(await published(who.workspaceId, "icp.draft_requested"), []);
});

test("the draft's routes with ?icpId= draft, show and use that audience's draft alone: the default's draft and fields stay, icp.audience_updated and no icp.updated", async () => {
  const [who] = await members();
  const { workspaceId } = who;
  const id = String((await call(who, "POST", "/audiences", { name: "Bakeries" })).body.id);
  const query = `?icpId=${id}`;
  const requested = await call(who, "POST", `/draft${query}`, { brief: "Bakeries in France" });
  assert.deepEqual([requested.status, requested.body.status], [202, "drafting"]);
  assert.equal((await call(who, "GET", "/draft")).body.status, "none", "the default's draft");
  const pendingDraft = {
    model: "fake-model",
    promptVersion: 1,
    decisionRecordId: "dec_audience_api",
    fields: PROPOSAL,
  };
  const data = { draftStatus: "drafted", pendingDraft };
  const { draftRunId: runId } = await asRole("app").icp.update({ where: { id }, data });
  const read = await call(who, "GET", `/draft${query}`);
  assert.deepEqual(read.body.pending, { fields: PROPOSAL, promptVersion: 1, runId });

  const accepted = await call(who, "POST", `/draft/accept${query}`, { runId });
  assert.deepEqual(
    [accepted.status, accepted.body.id, accepted.body.titles, accepted.body.version],
    [200, id, PROPOSAL.titles, 2],
  );
  assert.equal((await call(who, "GET", `/draft${query}`)).body.status, "none");
  assert.deepEqual(fieldsOf(await call(who, "GET", "")), { ...EMPTY, version: 1 });
  assert.deepEqual(await published(workspaceId, "icp.draft_requested"), [
    { workspaceId, icpId: id, draftRunId: runId },
  ]);
  assert.deepEqual(await published(workspaceId, "icp.audience_updated"), [
    { workspaceId, icpId: id, version: 2 },
  ]);
  assert.deepEqual(await published(workspaceId, "icp.updated"), []);
});
