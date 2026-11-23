// icp's audiences (gamma-p3-020; README "Commands", "Decided here") on the worktree's database: the
// create under the workspace's lock and its limit, two creates racing included; the list's order;
// the reads and saves of one audience, which leave the others as they were, and their events; an id
// another workspace holds; created_by. The routes are the api host's test,
// core/apps/api/tests/icp-audiences-api.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, type Principal, servicePrincipal } from "@whytide/platform";
import {
  createAudience,
  creatorOf,
  findAudience,
  getCriteria,
  getIcp,
  listAudiences,
  lockedIcpId,
  readIcpForScoring,
  saveCriteria,
  saveIcp,
} from "../domain/commands.ts";
import { SYSTEM_CREATOR } from "../domain/constants.ts";
import { acceptDraft, discardDraft, readDraft, requestDraft } from "../domain/draft.ts";
import { DEFAULT_CRITERIA } from "../domain/lists.ts";
import { settings } from "../settings.ts";
import { together } from "./together.ts";

// The limit as the create reads it, unset here: its default (tests/limits.test.ts sets it).
const { ICP_MAX_AUDIENCES_PER_WORKSPACE: MAX_AUDIENCES_PER_WORKSPACE } = settings;

withTestDb();

const worker = servicePrincipal("icp_test");
/** A member as the api's guard resolves one, an Owner, who writes every audience (owners.test.ts). */
const member: Principal = {
  userId: "usr_member",
  actorType: "human",
  authMethod: "session",
  membershipId: "mem_member",
  role: "Owner",
  scopes: [],
};
/** A run as the principal, a member bound to the run's workspace as the guard binds one. */
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>, principal = member) => {
  const bound = principal.membershipId ? { ...principal, workspaceId } : principal;
  return withTenant({ workspaceId, principal: bound }, fn, { client: asRole("app") });
};
const codeOf = (error: unknown) => (isAppError(error) ? error.code : error);
const create = (workspaceId: string, name: string) =>
  run(workspaceId, () => createAudience({ name, createdBy: member.userId }));
/** A flat payload as text, its keys sorted: jsonb stores them in an order of its own. */
const text = (payload: unknown) => JSON.stringify(payload, Object.keys(payload ?? {}).sort());
/** The payloads of the workspace's outbox entries of `eventName`, as text, in a fixed order. */
const published = async (workspaceId: string, eventName: string) => {
  const entries = await run(workspaceId, (tx) => tx.outboxEntry.findMany({ where: { eventName } }));
  return entries.map((entry) => text(entry.payload)).sort();
};

const FIELDS = {
  name: "Bakeries",
  titles: ["Owner"],
  seniorities: ["owner_founder"],
  industries: ["Food and beverage"],
  sizeRanges: ["11-50"],
  countries: ["FR"],
  mustHaves: "",
  disqualifiers: "",
};
/** The default criteria with ten points moved from industry to seniority. */
const MOVED = DEFAULT_CRITERIA.map((row) =>
  row.key === "industry"
    ? { ...row, weight: 5 }
    : row.key === "seniority"
      ? { ...row, weight: 25 }
      : row,
);

test("createAudience: a new audience, not the default, version 1, with the six default criteria and its creator, the default made first; listAudiences: the default first, then by name", async () => {
  const ws = "wsp_audiences_create";
  const zebra = await create(ws, "  Zebra founders ");
  assert.deepEqual(
    [zebra.name, zebra.isDefault, zebra.createdBy, zebra.version],
    ["Zebra founders", false, member.userId, 1],
  );
  const apple = await create(ws, "Apple growers");
  const listed = await run(ws, () => listAudiences());
  assert.deepEqual(
    listed.map((audience) => [audience.name, audience.isDefault]),
    [
      ["", true],
      ["Apple growers", false],
      ["Zebra founders", false],
    ],
  );
  assert.deepEqual(await run(ws, () => getCriteria(ws, zebra.id)), DEFAULT_CRITERIA);
  assert.deepEqual(await run(ws, () => findAudience(apple.id)), {
    id: apple.id,
    name: "Apple growers",
    isDefault: false,
    createdBy: member.userId,
    version: 1,
  });
  assert.equal((await run(ws, () => getIcp(ws))).id, listed[0]?.id, "without an id, the default");
  assert.equal(await run("wsp_audiences_else", () => findAudience(apple.id)), null);
});

test("the limit: ten audiences at most, the default included; of two creates at once at nine, the workspace's lock lets one through and refuses the other with icp_audience_limit", async () => {
  const ws = "wsp_audiences_limit";
  for (let at = 1; at < MAX_AUDIENCES_PER_WORKSPACE - 1; at++) await create(ws, `Audience ${at}`);
  assert.equal((await run(ws, () => listAudiences())).length, MAX_AUDIENCES_PER_WORKSPACE - 1);
  // Both runs open before either counts: without the lock, both would count nine and insert.
  const meet = together(2);
  const racing = (name: string) =>
    run(ws, async () => {
      await meet();
      return createAudience({ name, createdBy: member.userId });
    });
  const settled = await Promise.allSettled([racing("Racer A"), racing("Racer B")]);
  const refused = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  assert.equal(refused.length, 1, "one of the two is refused");
  const [error] = refused;
  assert.ok(isAppError(error), String(error));
  assert.deepEqual(
    [error.code, error.status, error.details],
    ["icp_audience_limit", 409, { limit: MAX_AUDIENCES_PER_WORKSPACE }],
  );
  assert.equal(await run(ws, (tx) => tx.icp.count()), MAX_AUDIENCES_PER_WORKSPACE);
  assert.equal(await create(ws, "Eleventh").catch(codeOf), "icp_audience_limit");
  assert.equal(await run(ws, (tx) => tx.icp.count()), MAX_AUDIENCES_PER_WORKSPACE);
});

test("an audience's saves change it alone: a targeting change publishes icp.audience_updated and no icp.updated; the default's publishes both; the name alone neither", async () => {
  const ws = "wsp_audiences_save";
  const bakeries = await create(ws, "Bakeries");
  const saved = await run(ws, () => saveIcp(FIELDS, bakeries.id));
  assert.deepEqual([saved.id, saved.version, saved.titles], [bakeries.id, 2, ["Owner"]]);
  assert.deepEqual(await run(ws, () => saveCriteria(MOVED, bakeries.id)), MOVED);
  const scored = await run(ws, () => readIcpForScoring(ws, bakeries.id));
  assert.deepEqual(
    [scored.icp.id, scored.icp.countries, scored.criteria],
    [bakeries.id, ["FR"], MOVED],
  );
  const byDefault = await run(ws, () => readIcpForScoring(ws));
  assert.deepEqual(
    [byDefault.icp.version, byDefault.icp.titles, byDefault.criteria],
    [1, [], DEFAULT_CRITERIA],
    "the default as it was",
  );
  const bakeriesV2 = text({ workspaceId: ws, icpId: bakeries.id, version: 2 });
  assert.deepEqual(await published(ws, "icp.audience_updated"), [bakeriesV2]);
  assert.deepEqual(await published(ws, "icp.updated"), []);
  await run(ws, () => saveIcp({ ...FIELDS, name: "Bakeries, renamed" }, bakeries.id));
  assert.deepEqual(await published(ws, "icp.audience_updated"), [bakeriesV2], "the name alone");

  const theDefault = await run(ws, () => saveIcp(FIELDS));
  assert.equal(theDefault.version, 2);
  const defaultV2 = text({ workspaceId: ws, icpId: theDefault.id, version: 2 });
  assert.deepEqual(await published(ws, "icp.updated"), [text({ workspaceId: ws, version: 2 })]);
  assert.deepEqual(await published(ws, "icp.audience_updated"), [bakeriesV2, defaultV2].sort());
  // The default saved by its id is the default still: its events are the same.
  await run(ws, () => saveIcp({ ...FIELDS, titles: ["Owner", "CFO"] }, theDefault.id));
  assert.equal((await published(ws, "icp.updated")).length, 2);
  const kept = await run(ws, () => getIcp(ws, bakeries.id));
  assert.deepEqual([kept.name, kept.titles, kept.version], ["Bakeries, renamed", ["Owner"], 2]);
});

test("an audience another workspace holds is icp_not_found on every command that takes an id, and none for findAudience; it stays as it was", async () => {
  const [ws, other] = ["wsp_audiences_mine", "wsp_audiences_theirs"];
  const theirs = await create(other, "Theirs");
  const calls: [string, () => Promise<unknown>][] = [
    ["getIcp", () => getIcp(ws, theirs.id)],
    ["getCriteria", () => getCriteria(ws, theirs.id)],
    ["readIcpForScoring", () => readIcpForScoring(ws, theirs.id)],
    ["saveIcp", () => saveIcp(FIELDS, theirs.id)],
    ["saveCriteria", () => saveCriteria(MOVED, theirs.id)],
    ["lockedIcpId", () => lockedIcpId(theirs.id)],
    ["requestDraft", () => requestDraft(ws, "Bakeries in France", theirs.id)],
    ["readDraft", () => readDraft(theirs.id)],
    ["acceptDraft", () => acceptDraft(true, "idrun_none", theirs.id)],
    ["discardDraft", () => discardDraft(theirs.id)],
  ];
  for (const [name, call] of calls) {
    assert.equal(await run(ws, call).catch(codeOf), "icp_not_found", name);
  }
  assert.equal(await run(ws, () => findAudience(theirs.id)), null);
  const kept = await run(other, () => readIcpForScoring(other, theirs.id));
  assert.deepEqual([kept.icp.version, kept.icp.titles, kept.criteria], [1, [], DEFAULT_CRITERIA]);
  assert.equal((await run(other, () => readDraft(theirs.id))).status, "none");
  assert.deepEqual(await published(other, "icp.draft_requested"), []);
});

test("created_by: the member who created the audience; a default made by a service's first read, the worker's, is system, by a member's the member", async () => {
  const [byWorker, byMember] = ["wsp_audiences_worker", "wsp_audiences_member"];
  const listed = await run(byWorker, () => listAudiences(), worker);
  assert.deepEqual(
    listed.map((audience) => [audience.isDefault, audience.createdBy]),
    [[true, SYSTEM_CREATOR]],
  );
  const made = await run(
    byWorker,
    () => createAudience({ name: "By the worker", createdBy: creatorOf(worker) }),
    worker,
  );
  assert.equal(made.createdBy, SYSTEM_CREATOR);
  const theDefault = await run(byMember, () => getIcp(byMember));
  const found = await run(byMember, () => findAudience(theDefault.id));
  assert.deepEqual([found?.isDefault, found?.createdBy], [true, member.userId]);
  assert.equal(creatorOf(member), member.userId);
});
