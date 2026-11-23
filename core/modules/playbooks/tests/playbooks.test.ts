// playbooks' commands (gamma-p3-040; README "Commands") on the worktree's database, each in a tenant
// run as `app`: the create, its owner and its event; the limit under the workspace's lock, two
// creates racing included; the audience's checks; the sources set, replaced and refused, a fake
// source checker in place; archive, which frees the sources and the audience and is final; an agent
// the workspace does not hold; the review's fixes (gamma-p3-041), the sources' limit in the command
// and no event for a patch that changes nothing. The routes are the api host's test,
// core/apps/api/tests/playbooks-api.test.ts: a module's test never imports a host.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { ids as icpIds } from "@whytide/icp";
import { isAppError, newId, type Principal } from "@whytide/platform";
import {
  checkSources,
  createPlaybook,
  detachSource,
  getPlaybook,
  listPlaybooks,
  playbookOfSource,
  setSources,
  sourcesOf,
  updatePlaybook,
} from "../domain/playbooks.ts";
import type { SourceCheck } from "../domain/source-checker.ts";
import { settings } from "../settings.ts";
import { useSourceChecker } from "../testing/index.ts";
import { together } from "./together.ts";

// The limits as the commands read them, unset here: their defaults (tests/limits.test.ts sets them).
const {
  PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE: MAX_PLAYBOOKS_PER_WORKSPACE,
  PLAYBOOKS_MAX_SOURCES_PER_AGENT: MAX_SOURCES_PER_PLAYBOOK,
} = settings;

withTestDb();

const OWNER = "usr_owner";
/** The agents' owner, a Member as the api's guard resolves one, bound to each run's workspace. */
const member: Principal = {
  userId: OWNER,
  actorType: "human",
  authMethod: "session",
  membershipId: "mem_owner",
  role: "Member",
  scopes: [],
};
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: { ...member, workspaceId } }, fn, { client: asRole("app") });
const codeOf = (error: unknown) => (isAppError(error) ? error.code : error);
const refusal = (error: unknown) =>
  isAppError(error) ? { code: error.code, status: error.status, details: error.details } : error;

/** An audience of the workspace, as icp's createAudience leaves one: icp has no test factory. */
async function audience(workspaceId: string, name: string): Promise<string> {
  const id = newId(icpIds.icp);
  await asRole("app").icp.create({ data: { id, workspaceId, name, isDefault: false } });
  return id;
}
const create = (workspaceId: string, icpId: string, name = "Logistics agent") =>
  run(workspaceId, () => createPlaybook({ name, icpId, ownerUserId: OWNER }));
/** The payloads of the workspace's `eventName`, oldest first. */
const published = async (workspaceId: string, eventName: string) => {
  const where = { workspaceId, eventName };
  const rows = await asRole("app").outboxEntry.findMany({ where, orderBy: { id: "asc" } });
  return rows.map((row) => row.payload);
};

/** A checker that finds every id of `owned` read through OWNER's account, and another's of `theirs`. */
function checker(owned: readonly string[], theirs: readonly string[] = []) {
  return async (sourceIds: readonly string[]): Promise<SourceCheck[]> =>
    sourceIds.map((sourceId) => {
      const mine = owned.includes(sourceId);
      const found = mine || theirs.includes(sourceId);
      return {
        sourceId,
        found,
        readingAccountId: found ? `sac_${mine ? "mine" : "theirs"}` : null,
        readingOwnerUserId: found ? (mine ? OWNER : "usr_other") : null,
      };
    });
}
const SOURCES = Array.from({ length: 12 }, (_, at) => `src_${String(at).padStart(26, "0")}`);
after(useSourceChecker(checker(SOURCES, ["src_theirs"])));

test("createPlaybook: an active agent on the audience, its owner and creator the member; playbooks.playbook_created once, with the owner and the audience; the readers answer it", async () => {
  const ws = "wsp_playbooks_create";
  const icpId = await audience(ws, "Logistics founders");
  const created = await create(ws, icpId, "  Logistics agent ");
  const { id, createdAt, ...fields } = created;
  assert.match(id, /^pbk_[0-9A-Z]{26}$/);
  assert.ok(createdAt instanceof Date);
  assert.deepEqual(fields, {
    name: "Logistics agent",
    icpId,
    ownerUserId: OWNER,
    status: "active",
    pausedReason: null,
  });
  assert.deepEqual(await run(ws, () => getPlaybook(created.id)), created);
  assert.deepEqual(await run(ws, () => listPlaybooks()), [{ ...created, sourceCount: 0 }]);
  const row = await asRole("app").playbook.findUniqueOrThrow({ where: { id: created.id } });
  assert.deepEqual([row.createdBy, row.archivedAt], [OWNER, null]);
  const event = { playbookId: created.id, ownerUserId: OWNER, icpId };
  assert.deepEqual(await published(ws, "playbooks.playbook_created"), [event]);
  await run(ws, () => updatePlaybook(created.id, { name: "Renamed" }));
  assert.deepEqual(await published(ws, "playbooks.playbook_created"), [event], "once per agent");
});

test("the limit: three live agents, two of them created at once; a fourth is playbook_limit_reached, a paused agent counting; archiving one frees a place", async () => {
  const ws = "wsp_playbooks_limit";
  const audiences = [];
  for (let at = 0; at < MAX_PLAYBOOKS_PER_WORKSPACE + 2; at++) {
    audiences.push(await audience(ws, `Audience ${at}`));
  }
  const [a, b, c, d, e] = audiences as [string, string, string, string, string];
  await create(ws, a);
  // Both runs open before either counts: without the lock, both would count one and insert.
  const meet = together(2);
  const racing = (icpId: string) =>
    run(ws, async () => {
      await meet();
      return createPlaybook({ name: "Racer", icpId, ownerUserId: OWNER });
    });
  const settled = await Promise.allSettled([racing(b), racing(c)]);
  assert.deepEqual(
    settled.map((result) => result.status),
    ["fulfilled", "fulfilled"],
    "two and three",
  );
  const limit = {
    code: "playbook_limit_reached",
    status: 409,
    details: { limit: MAX_PLAYBOOKS_PER_WORKSPACE },
  };
  assert.deepEqual(await create(ws, d).catch(refusal), limit);
  assert.equal(await asRole("app").playbook.count({ where: { workspaceId: ws } }), 3);

  const [first] = await run(ws, () => listPlaybooks());
  await run(ws, () => updatePlaybook(first?.id ?? "", { status: "paused" }));
  assert.equal(
    await create(ws, d).catch(codeOf),
    "playbook_limit_reached",
    "a paused agent counts",
  );
  await run(ws, () => updatePlaybook(first?.id ?? "", { status: "archived" }));
  const freed = await create(ws, d);
  assert.equal(freed.status, "active", "archiving frees a place");
  assert.equal(await create(ws, e).catch(codeOf), "playbook_limit_reached");
});

test("of two creates at once at two live agents, the workspace's lock lets one through and refuses the other with playbook_limit_reached", async () => {
  const ws = "wsp_playbooks_race";
  const [a, b, c, d] = [
    await audience(ws, "A"),
    await audience(ws, "B"),
    await audience(ws, "C"),
    await audience(ws, "D"),
  ];
  await create(ws, a);
  await create(ws, b);
  const meet = together(2);
  const racing = (icpId: string) =>
    run(ws, async () => {
      await meet();
      return createPlaybook({ name: "Racer", icpId, ownerUserId: OWNER });
    });
  const settled = await Promise.allSettled([racing(c), racing(d)]);
  const refused = settled.flatMap((result) =>
    result.status === "rejected" ? [refusal(result.reason)] : [],
  );
  const limit = { limit: MAX_PLAYBOOKS_PER_WORKSPACE };
  assert.deepEqual(refused, [{ code: "playbook_limit_reached", status: 409, details: limit }]);
  assert.equal(await asRole("app").playbook.count({ where: { workspaceId: ws } }), 3);
});

test("the audience: one of the workspace's, else playbook_icp_not_found; one live agent per audience, playbook_icp_in_use, also for two creates at once and for a move; archiving frees it", async () => {
  const [ws, other] = ["wsp_playbooks_icp", "wsp_playbooks_icp_other"];
  const [mine, second] = [await audience(ws, "Mine"), await audience(ws, "Second")];
  const theirs = await audience(other, "Theirs");
  const notFound = { code: "playbook_icp_not_found", status: 404, details: undefined };
  assert.deepEqual(await create(ws, theirs).catch(refusal), notFound, "another workspace's");
  assert.deepEqual(await create(ws, "icp_unknown").catch(refusal), notFound);

  const meet = together(2);
  const racing = () =>
    run(ws, async () => {
      await meet();
      return createPlaybook({ name: "Racer", icpId: mine, ownerUserId: OWNER });
    });
  const settled = await Promise.allSettled([racing(), racing()]);
  const refused = settled.flatMap((result) =>
    result.status === "rejected" ? [codeOf(result.reason)] : [],
  );
  assert.deepEqual(refused, ["playbook_icp_in_use"]);
  const [held] = await run(ws, () => listPlaybooks());
  const inUse = { code: "playbook_icp_in_use", status: 409, details: undefined };
  assert.deepEqual(await create(ws, mine).catch(refusal), inUse);

  const moving = await create(ws, second, "Mover");
  const move = (icpId: string) => run(ws, () => updatePlaybook(moving.id, { icpId }));
  assert.deepEqual(await move(mine).catch(refusal), inUse);
  assert.deepEqual(await move(theirs).catch(refusal), notFound);
  assert.equal((await run(ws, () => getPlaybook(moving.id)))?.icpId, second, "unchanged");

  await run(ws, () => updatePlaybook(held?.id ?? "", { status: "archived" }));
  assert.equal((await move(mine)).icpId, mine, "the archived agent freed it");
  assert.equal((await create(ws, second)).icpId, second, "the move freed the other");
});

test("sources: the set replaced, playbooks.sources_changed on a change; a source another agent holds is playbook_source_in_use naming it; archiving frees them; playbookOfSource and detachSource", async () => {
  const ws = "wsp_playbooks_sources";
  const first = await create(ws, await audience(ws, "First"), "First");
  const second = await create(ws, await audience(ws, "Second"), "Second");
  const [s0, s1, s2, s3] = SOURCES as [string, string, string, string];
  const set = (playbookId: string, sourceIds: string[]) =>
    run(ws, () => setSources(playbookId, sourceIds));
  assert.deepEqual(await set(first.id, [s0, s1, s0]), [s0, s1]);
  assert.deepEqual(await set(first.id, [s1, s2]), [s1, s2], "replaced");
  assert.deepEqual(await run(ws, () => sourcesOf(first.id)), [s1, s2]);
  const changed = { playbookId: first.id };
  assert.deepEqual(await published(ws, "playbooks.sources_changed"), [changed, changed]);
  await set(first.id, [s2, s1]);
  assert.equal((await published(ws, "playbooks.sources_changed")).length, 2, "no change, no event");

  const inUse = {
    code: "playbook_source_in_use",
    status: 409,
    details: { sourceIds: [s1, s2] },
  };
  assert.deepEqual(await set(second.id, [s3, s1, s2]).catch(refusal), inUse);
  assert.deepEqual(await run(ws, () => sourcesOf(second.id)), [], "nothing written");
  assert.deepEqual(await run(ws, () => checkSources(second.id, [s3, s1, s3])), [
    { sourceId: s3, usable: true, code: null, heldBy: null },
    { sourceId: s1, usable: false, code: "playbook_source_in_use", heldBy: first.id },
  ]);
  assert.deepEqual(await run(ws, () => checkSources(first.id, [s1])), [
    { sourceId: s1, usable: true, code: null, heldBy: null },
  ]);
  assert.equal(await run(ws, () => playbookOfSource(s1)), first.id);
  assert.equal(await run(ws, () => playbookOfSource(s3)), null, "a free one");
  const listed = await run(ws, () => listPlaybooks());
  assert.deepEqual(
    listed.map(({ id, sourceCount }) => [id, sourceCount]),
    [
      [first.id, 2],
      [second.id, 0],
    ],
  );

  await run(ws, () => updatePlaybook(first.id, { status: "archived" }));
  assert.deepEqual(await run(ws, () => sourcesOf(first.id)), [], "archiving frees them");
  assert.deepEqual(await set(second.id, [s1, s2]), [s1, s2]);
  await run(ws, () => detachSource(s1));
  assert.deepEqual(await run(ws, () => sourcesOf(second.id)), [s2]);
  await run(ws, () => detachSource(s1));
  assert.equal(await run(ws, () => playbookOfSource(s1)), null);
});

test("archived is final: archived_at set, every later change refused with playbook_archived; the database refuses archived_at off the status", async () => {
  const ws = "wsp_playbooks_archive";
  const agent = await create(ws, await audience(ws, "Archive"));
  const archived = await run(ws, () => updatePlaybook(agent.id, { status: "archived" }));
  assert.equal(archived.status, "archived");
  const row = await asRole("app").playbook.findUniqueOrThrow({ where: { id: agent.id } });
  assert.ok(row.archivedAt instanceof Date);
  const changes: [string, () => Promise<unknown>][] = [
    ["resume", () => updatePlaybook(agent.id, { status: "active" })],
    ["pause", () => updatePlaybook(agent.id, { status: "paused" })],
    ["rename", () => updatePlaybook(agent.id, { name: "Again" })],
    ["nothing", () => updatePlaybook(agent.id, {})],
    ["sources", () => setSources(agent.id, [SOURCES[0] ?? ""])],
  ];
  for (const [name, change] of changes) {
    assert.equal(await run(ws, change).catch(codeOf), "playbook_archived", name);
  }
  const statuses = (await published(ws, "playbooks.playbook_updated")) as { status: string }[];
  assert.deepEqual(
    statuses.map(({ status }) => status),
    ["archived"],
  );
  const check = "23514";
  const off = asRole("app").playbook.update({
    where: { id: agent.id },
    data: { archivedAt: null },
  });
  assert.equal(await sqlstate(off), check);
  const live = await create(ws, await audience(ws, "Live"));
  const stamped = asRole("app").playbook.update({
    where: { id: live.id },
    data: { archivedAt: new Date() },
  });
  assert.equal(await sqlstate(stamped), check);
});

test("the review's fixes (gamma-p3-041): more than MAX_SOURCES_PER_PLAYBOOK distinct ids is playbook_sources_limit, nothing written, a repeated id counting once; a patch that changes nothing writes nothing and publishes no playbooks.playbook_updated", async () => {
  const ws = "wsp_playbooks_review";
  const agent = await create(ws, await audience(ws, "Review"), "Review agent");
  const set = (sourceIds: string[]) => run(ws, () => setSources(agent.id, sourceIds));
  const limit = {
    code: "playbook_sources_limit",
    status: 400,
    details: { limit: MAX_SOURCES_PER_PLAYBOOK },
  };
  assert.deepEqual(await set(SOURCES.slice(0, MAX_SOURCES_PER_PLAYBOOK + 1)).catch(refusal), limit);
  assert.deepEqual(await run(ws, () => sourcesOf(agent.id)), [], "nothing written");
  const most = SOURCES.slice(0, MAX_SOURCES_PER_PLAYBOOK);
  assert.deepEqual(await set([...most, most[0] ?? ""]), most, "a repeated id counts once");

  const row = () => asRole("app").playbook.findUniqueOrThrow({ where: { id: agent.id } });
  const before = await row();
  const same = { name: " Review agent ", icpId: agent.icpId, status: "active" } as const;
  for (const patch of [{}, { name: same.name }, { icpId: same.icpId }, same]) {
    assert.deepEqual(await run(ws, () => updatePlaybook(agent.id, patch)), agent);
  }
  assert.deepEqual(await published(ws, "playbooks.playbook_updated"), [], "no change, no event");
  assert.deepEqual((await row()).updatedAt, before.updatedAt, "nothing written");
  await run(ws, () => updatePlaybook(agent.id, { ...same, status: "paused" }));
  const paused = [{ playbookId: agent.id, status: "paused" }];
  assert.deepEqual(await published(ws, "playbooks.playbook_updated"), paused);
});

test("an agent the workspace does not hold, another workspace's included, is playbook_not_found on every command; the readers answer none", async () => {
  const [ws, other] = ["wsp_playbooks_mine", "wsp_playbooks_theirs"];
  const theirs = await create(other, await audience(other, "Theirs"));
  const mine = await audience(ws, "Mine");
  const calls: [string, () => Promise<unknown>][] = [
    ["updatePlaybook", () => updatePlaybook(theirs.id, { name: "Mine now" })],
    ["move", () => updatePlaybook(theirs.id, { icpId: mine })],
    ["setSources", () => setSources(theirs.id, [])],
    ["checkSources", () => checkSources(theirs.id, [])],
    ["empty id", () => updatePlaybook("", { status: "paused" })],
  ];
  for (const [name, call] of calls) {
    assert.equal(await run(ws, call).catch(codeOf), "playbook_not_found", name);
  }
  assert.equal(await run(ws, () => getPlaybook(theirs.id)), null);
  assert.deepEqual(await run(ws, () => listPlaybooks()), []);
  const kept = await run(other, () => getPlaybook(theirs.id));
  assert.deepEqual([kept?.name, kept?.status], ["Logistics agent", "active"]);
});
