// icp's draft routes end to end (icp-draft-screen; core/modules/icp/README.md "Routes", "The draft"):
// the host started with identity and icp, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP; a write sends the app's Origin and, to the draft's
// routes, an Idempotency-Key. No worker runs here: the test writes the ICP as the drafter leaves it,
// and Company Knowledge as onboarding stores it. The events are read from the outbox.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl, Prisma } from "@whytide/db";
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

type Member = { readonly workspaceId: string; readonly cookie: string };
type Answer = {
  readonly status: number;
  readonly replayed: string | null;
  readonly body: Record<string, unknown>;
};

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
/** What a good model proposes, as the drafter's pending draft carries it. */
const PROPOSAL = {
  name: "Bakery owners",
  titles: ["Owner", "Head of Finance"],
  seniorities: ["owner_founder", "head"],
  industries: ["Food and beverage"],
  sizeRanges: ["11-50"],
  countries: ["FR", "BE"],
  mustHaves: "Runs two bakeries or more",
  disqualifiers: "",
};
const BRIEF = "Bakeries in France and Belgium";
const DECISION = "dec_icp_draft_api";
const NO_DRAFT = { status: "none", error: null, pending: null };
/** A run the ICP never had. */
const NO_RUN = "idrun_none";

/** The Owner of a new workspace, signed in. */
async function member(): Promise<Member> {
  const [{ user, workspace }] = await createTwoWorkspaces();
  const cookie = signInAs(user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  return { workspaceId: workspace.id, cookie };
}

/**
 * A call to …/icp`path`: a GET without a body; with one, a POST to the draft's routes under the
 * Idempotency-Key `key`, or a PUT to the ICP's, with the app's Origin.
 */
async function call(who: Member, path: string, body?: object, key = randomUUID()) {
  const url = new URL(`/v1/workspaces/${who.workspaceId}/icp${path}`, api.url);
  const method = body === undefined ? "GET" : path.startsWith("/draft") ? "POST" : "PUT";
  const write = { origin: APP_ORIGIN, "content-type": "application/json", "idempotency-key": key };
  const res = await fetch(url, {
    method,
    headers: { cookie: who.cookie, ...(body === undefined ? {} : write) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const replayed = res.headers.get("idempotent-replayed");
  return { status: res.status, replayed, body: (await res.json()) as Record<string, unknown> };
}

/** Company Knowledge with a one-liner and a product, as onboarding stores a save. */
async function knowledge(workspaceId: string): Promise<void> {
  const fields = { oneLiner: "Bookkeeping for bakeries", products: ["Ledger"] };
  const create = { id: `ck_${randomUUID()}`, workspaceId, ...fields };
  const where = { workspaceId };
  await asRole("app").companyKnowledge.upsert({ where, create, update: fields });
}

/** The worker's part: the latest run drafted `fields`, as the drafter leaves the ICP. */
async function drafted(workspaceId: string, fields: object = PROPOSAL): Promise<void> {
  const pendingDraft = {
    model: "fake-model",
    promptVersion: 1,
    decisionRecordId: DECISION,
    fields,
  };
  const data = { draftStatus: "drafted", pendingDraft };
  assert.equal((await asRole("app").icp.updateMany({ where: { workspaceId }, data })).count, 1);
}

/** The payloads of `eventName` the workspace published, oldest first. */
async function published(workspaceId: string, eventName: string): Promise<unknown[]> {
  const where = { workspaceId, eventName };
  const rows = await asRole("app").outboxEntry.findMany({ where, orderBy: { id: "asc" } });
  return rows.map((row) => row.payload);
}

const stored = (workspaceId: string) =>
  asRole("app").icp.findFirstOrThrow({ where: { workspaceId } });
/** The ICP's latest run, which GET …/icp/draft answers as pending.runId and Use sends back. */
const latestRun = async (workspaceId: string) => (await stored(workspaceId)).draftRunId;
/** The ICP's answer without its id and time, which change with every run. */
const fieldsOf = ({ body: { id: _id, updatedAt: _at, ...rest } }: Answer) => rest;
const refused = (status: number, code: string, details?: object) => ({
  status,
  replayed: null,
  body: details === undefined ? { code } : { code, details },
});

test("GET …/icp/draft answers the status, the error, the proposal with its run and hasKnowledge, false for an empty Company Knowledge and true once it has a field; no answer holds the brief or the decision record", async () => {
  const who = await member();
  assert.deepEqual((await call(who, "/draft")).body, { ...NO_DRAFT, hasKnowledge: false });
  await knowledge(who.workspaceId);
  assert.deepEqual((await call(who, "/draft")).body, { ...NO_DRAFT, hasKnowledge: true });

  const requested = await call(who, "/draft", { brief: BRIEF });
  await drafted(who.workspaceId);
  const read = await call(who, "/draft");
  assert.deepEqual(read, {
    status: 200,
    replayed: null,
    body: {
      status: "drafted",
      error: null,
      pending: { fields: PROPOSAL, promptVersion: 1, runId: await latestRun(who.workspaceId) },
      hasKnowledge: true,
    },
  });
  for (const { body } of [requested, read]) {
    const text = JSON.stringify(body);
    assert.ok(!text.includes(BRIEF) && !text.includes(DECISION), text);
  }
  const failed = { draftStatus: "failed", draftError: "ai_failed", pendingDraft: Prisma.DbNull };
  await asRole("app").icp.updateMany({ where: { workspaceId: who.workspaceId }, data: failed });
  const { body } = await call(who, "/draft");
  assert.deepEqual(body, {
    status: "failed",
    error: "ai_failed",
    pending: null,
    hasKnowledge: true,
  });
});

test("POST …/icp/draft: neither source is 409 icp_draft_no_source and a brief of 2,001 characters 400 icp_draft_brief_too_long, neither writing; a brief alone is 202 drafting with one icp.draft_requested, the version kept, its key answered again", async () => {
  const who = await member();
  const { workspaceId } = who;
  assert.deepEqual(await call(who, "/draft", {}), refused(409, "icp_draft_no_source"));
  const long = { brief: "b".repeat(2001) };
  assert.deepEqual(
    await call(who, "/draft", long),
    refused(400, "icp_draft_brief_too_long", { max: 2000 }),
  );
  assert.deepEqual(await published(workspaceId, "icp.draft_requested"), []);

  const key = randomUUID();
  const first = await call(who, "/draft", { brief: BRIEF }, key);
  const drafting = { status: "drafting", error: null, pending: null, hasKnowledge: false };
  assert.deepEqual(first, { status: 202, replayed: null, body: drafting });
  assert.deepEqual(await call(who, "/draft", { brief: BRIEF }, key), {
    ...first,
    replayed: "true",
  });
  const row = await stored(workspaceId);
  assert.deepEqual(
    [row.draftStatus, row.draftBrief, row.version],
    ["drafting", BRIEF, 1],
    "the brief kept for the drafter, the version unchanged",
  );
  assert.deepEqual(await published(workspaceId, "icp.draft_requested"), [
    { workspaceId, icpId: row.id, draftRunId: row.draftRunId },
  ]);
  assert.deepEqual(await published(workspaceId, "icp.updated"), []);
});

test("accept: nothing drafted is 409 icp_draft_none; over targeting without replace 409 icp_not_empty; with replace, the proposal saved as a PUT saves it, the version moved, one icp.updated, the criteria kept and the draft ended; a proposal off the PUT body's schema is 422 icp_draft_invalid", async () => {
  const who = await member();
  const { workspaceId } = who;
  await knowledge(workspaceId);
  const none = { runId: NO_RUN };
  assert.deepEqual(await call(who, "/draft/accept", none), refused(409, "icp_draft_none"));
  assert.equal((await call(who, "", { ...EMPTY, titles: ["CFO"] })).body.version, 2);
  const { body: before } = await call(who, "/criteria");
  await call(who, "/draft", {});
  await drafted(workspaceId);
  const runId = await latestRun(workspaceId);
  assert.deepEqual(await call(who, "/draft/accept", { runId }), refused(409, "icp_not_empty"));
  assert.equal((await call(who, "/draft")).body.status, "drafted", "the draft waits");

  const key = randomUUID();
  const accepted = await call(who, "/draft/accept", { replace: true, runId }, key);
  assert.equal(accepted.status, 200);
  const normalized = { ...PROPOSAL, countries: ["BE", "FR"] };
  assert.deepEqual(fieldsOf(accepted), { ...normalized, version: 3 });
  assert.deepEqual(await call(who, ""), accepted, "the ICP as GET and PUT answer it");
  assert.deepEqual(await call(who, "/draft/accept", { replace: true, runId }, key), {
    ...accepted,
    replayed: "true",
  });
  assert.deepEqual(await published(workspaceId, "icp.updated"), [
    { workspaceId, version: 2 },
    { workspaceId, version: 3 },
  ]);
  assert.deepEqual((await call(who, "/criteria")).body, before, "the criteria unchanged");
  assert.deepEqual((await call(who, "/draft")).body, { ...NO_DRAFT, hasKnowledge: true });
  const row = await stored(workspaceId);
  assert.deepEqual([row.pendingDraft, row.draftRunId, row.draftError], [null, null, null]);
  assert.deepEqual(await call(who, "/draft/accept", { runId }), refused(409, "icp_draft_none"));

  await call(who, "/draft", {});
  await drafted(workspaceId, { ...PROPOSAL, name: "n".repeat(101), titles: ["t".repeat(101)] });
  assert.deepEqual(
    await call(who, "/draft/accept", { replace: true, runId: await latestRun(workspaceId) }),
    refused(422, "icp_draft_invalid", { fields: ["name", "titles.0"] }),
  );
  assert.equal((await call(who, "")).body.version, 3, "nothing saved");
  assert.equal((await call(who, "/draft")).body.status, "drafted");
});

test("accept of the run a later request replaced is 409 icp_draft_none, replace or not: nothing saved, no icp.updated, and the later run's proposal waits", async () => {
  const who = await member();
  const { workspaceId } = who;
  await knowledge(workspaceId);
  await call(who, "/draft", { brief: BRIEF });
  await drafted(workspaceId);
  const shown = (await call(who, "/draft")).body.pending as { readonly runId: string };
  await call(who, "/draft", { brief: BRIEF });
  const later = { ...PROPOSAL, name: "Later" };
  await drafted(workspaceId, later);
  for (const replace of [false, true]) {
    const stale = { replace, runId: shown.runId };
    assert.deepEqual(await call(who, "/draft/accept", stale), refused(409, "icp_draft_none"));
  }
  assert.deepEqual(fieldsOf(await call(who, "")), { ...EMPTY, version: 1 }, "nothing saved");
  assert.deepEqual(await published(workspaceId, "icp.updated"), []);
  const runId = await latestRun(workspaceId);
  assert.notEqual(runId, shown.runId);
  const { body } = await call(who, "/draft");
  assert.deepEqual(
    [body.status, body.pending],
    ["drafted", { fields: later, promptVersion: 1, runId }],
    "the later run's proposal waits",
  );
});

test("discard ends the draft and keeps every field of the ICP; a second discard is 409 icp_draft_none", async () => {
  const who = await member();
  const { workspaceId } = who;
  await knowledge(workspaceId);
  const saved = await call(who, "", { ...EMPTY, titles: ["CFO"] });
  await call(who, "/draft", { brief: BRIEF });
  await drafted(workspaceId);
  const discarded = await call(who, "/draft/discard", {});
  assert.deepEqual(discarded, {
    status: 200,
    replayed: null,
    body: { ...NO_DRAFT, hasKnowledge: true },
  });
  assert.deepEqual(
    fieldsOf(await call(who, "")),
    fieldsOf(saved),
    "every field kept, the version too",
  );
  assert.equal((await stored(workspaceId)).pendingDraft, null);
  assert.deepEqual(await call(who, "/draft/discard", {}), refused(409, "icp_draft_none"));
  assert.deepEqual(await published(workspaceId, "icp.updated"), [{ workspaceId, version: 2 }]);
});
