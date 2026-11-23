// Who writes an audience (gamma-p6-015; README "Decided here") on the worktree's database: its
// owner, a Member, writes it and an Owner writes every one; a Member's write of another member's
// audience, of the default, even one their own first read created, and of a row whose created_by is
// null or system is forbidden through every command that writes, and nothing changes. The routes
// are the api host's test, core/apps/api/tests/members-own-agents.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, type Principal, type Role } from "@whytide/platform";
import { createAudience, getIcp, saveCriteria, saveIcp } from "../domain/commands.ts";
import { SYSTEM_CREATOR } from "../domain/constants.ts";
import { acceptDraft, discardDraft, requestDraft } from "../domain/draft.ts";
import { DEFAULT_CRITERIA } from "../domain/lists.ts";

withTestDb();

/** A member as the api's guard resolves one; a run binds it to its workspace. */
const human = (name: string, role: Role): Principal => ({
  userId: `usr_${name}`,
  actorType: "human",
  authMethod: "session",
  membershipId: `mem_${name}`,
  role,
  scopes: [],
});
const [mia, max, olga] = [human("mia", "Member"), human("max", "Member"), human("olga", "Owner")];
const run = <T>(workspaceId: string, who: Principal, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: { ...who, workspaceId } }, fn, { client: asRole("app") });
const answerOf = (error: unknown) => (isAppError(error) ? [error.code, error.status] : error);
const FORBIDDEN = ["forbidden", 403];

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
const MOVED = DEFAULT_CRITERIA.map((row) =>
  row.key === "industry"
    ? { ...row, weight: 5 }
    : row.key === "seniority"
      ? { ...row, weight: 25 }
      : row,
);

/** Every command that writes an audience, on `icpId`, or on the default without one. */
const writes = (ws: string, icpId?: string): [string, () => Promise<unknown>][] => [
  ["saveIcp", () => saveIcp(FIELDS, icpId)],
  ["saveCriteria", () => saveCriteria(MOVED, icpId)],
  ["requestDraft", () => requestDraft(ws, "Bakeries in France", icpId)],
  ["acceptDraft", () => acceptDraft(true, "idrun_none", icpId)],
  ["discardDraft", () => discardDraft(icpId)],
];
/** What a refused write must leave as it was: the audiences, their criteria and the outbox. */
const stored = (ws: string) =>
  run(ws, olga, async (tx) => ({
    icps: await tx.icp.findMany({ orderBy: { id: "asc" } }),
    criteria: await tx.criterion.findMany({ orderBy: { id: "asc" } }),
    outbox: await tx.outboxEntry.findMany({ orderBy: { id: "asc" } }),
  }));
/** Each write as `who` on `icpId` is forbidden, and nothing changes. */
async function refusedEach(ws: string, who: Principal, icpId?: string): Promise<void> {
  const before = await stored(ws);
  for (const [name, write] of writes(ws, icpId)) {
    assert.deepEqual(await run(ws, who, write).catch(answerOf), FORBIDDEN, name);
  }
  assert.deepEqual(await stored(ws), before, "nothing changes");
}
const audience = (ws: string, name: string, createdBy: string | null) =>
  run(ws, olga, async (tx) => {
    const made = await createAudience({ name, createdBy: createdBy ?? mia.userId });
    if (createdBy === null) await tx.icp.update({ where: { id: made.id }, data: { createdBy } });
    return made;
  });

test("a Member writes the audience they created through every command; an Owner writes it too", async () => {
  const ws = "wsp_owners_own";
  const own = await audience(ws, "Mia's bakeries", mia.userId);
  const saved = await run(ws, mia, () => saveIcp(FIELDS, own.id));
  assert.deepEqual([saved.id, saved.version, saved.titles], [own.id, 2, ["Owner"]]);
  assert.deepEqual(await run(ws, mia, () => saveCriteria(MOVED, own.id)), MOVED);
  const runId = await run(ws, mia, () => requestDraft(ws, "Bakeries in France", own.id));
  assert.match(runId, /^idrun_/);
  // Past the owner check, the draft's own rules answer: no proposal yet.
  const reviews: (() => Promise<unknown>)[] = [
    () => acceptDraft(true, runId, own.id),
    () => discardDraft(own.id),
  ];
  for (const review of reviews) {
    assert.deepEqual(await run(ws, mia, review).catch(answerOf), ["icp_draft_none", 409]);
  }
  const byOwner = await run(ws, olga, () => saveIcp({ ...FIELDS, titles: ["CFO"] }, own.id));
  assert.deepEqual([byOwner.version, byOwner.titles], [3, ["CFO"]]);
});

test("a Member's write of another member's audience is forbidden through every command, and nothing changes", async () => {
  const ws = "wsp_owners_theirs";
  const theirs = await audience(ws, "Mia's bakeries", mia.userId);
  await refusedEach(ws, max, theirs.id);
  const kept = await run(ws, olga, () => getIcp(ws, theirs.id));
  assert.deepEqual([kept.version, kept.titles], [1, []]);
});

test("the default is icp.manage's: a Member whose own first read created it is forbidden every write of it, without an id and by its id; an Owner writes it", async () => {
  const ws = "wsp_owners_default";
  const theDefault = await run(ws, mia, () => getIcp(ws));
  const row = await run(ws, olga, (tx) => tx.icp.findFirstOrThrow({ where: { isDefault: true } }));
  assert.deepEqual([row.id, row.createdBy], [theDefault.id, mia.userId], "her read created it");
  await refusedEach(ws, mia, undefined);
  await refusedEach(ws, mia, theDefault.id);
  const saved = await run(ws, olga, () => saveIcp(FIELDS));
  assert.deepEqual([saved.id, saved.version], [theDefault.id, 2]);
});

test("a Member's write before any read is forbidden and leaves no default behind", async () => {
  const ws = "wsp_owners_first";
  assert.deepEqual(await run(ws, mia, () => saveIcp(FIELDS)).catch(answerOf), FORBIDDEN);
  assert.equal(await run(ws, olga, (tx) => tx.icp.count()), 0);
  assert.equal(await run(ws, olga, (tx) => tx.criterion.count()), 0);
});

test("a row whose created_by is null, made before gamma-p3-020, or system, a service's, is the workspace's: a Member is forbidden every write, an Owner writes it", async () => {
  const ws = "wsp_owners_workspace";
  for (const createdBy of [null, SYSTEM_CREATOR]) {
    const row = await audience(ws, `Owned by ${createdBy}`, createdBy);
    const found = await run(ws, olga, (tx) => tx.icp.findFirstOrThrow({ where: { id: row.id } }));
    assert.equal(found.createdBy, createdBy);
    await refusedEach(ws, mia, row.id);
    const saved = await run(ws, olga, () => saveIcp(FIELDS, row.id));
    assert.equal(saved.version, 2, String(createdBy));
  }
});
