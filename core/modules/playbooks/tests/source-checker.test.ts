// playbooks' source checker (gamma-p3-040; README "The source checker"): with none registered, every
// link is refused and nothing is written; with a fake one in place through useSourceChecker, a source
// it finds and reads through the owner's own account is usable, one it does not find (or leaves out)
// is playbook_source_not_found, one read through another member's account or through none
// playbook_source_wrong_owner, each with details.sourceIds, the set's first refused code winning; the
// checker runs in the caller's run, once per set; a second registration is refused. The route of the
// check is the api host's test, core/apps/api/tests/playbooks-api.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { currentTenant, isAppError, type Principal } from "@whytide/platform";
import { checkSources, setSources, sourcesOf } from "../domain/playbooks.ts";
import { defineSourceChecker, type SourceChecker } from "../domain/source-checker.ts";
import { createPlaybook as seed, useSourceChecker } from "../testing/index.ts";

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
const refusal = (error: unknown) =>
  isAppError(error) ? { code: error.code, status: error.status, details: error.details } : error;
const changes = (workspaceId: string) => {
  const where = { workspaceId, eventName: "playbooks.sources_changed" };
  return asRole("app").outboxEntry.count({ where });
};

/** The fake's sources: each id's reading account and that account's owner. */
const KNOWN: Record<string, { readonly account: string | null; readonly owner: string | null }> = {
  src_mine: { account: "sac_mine", owner: OWNER },
  src_mine_too: { account: "sac_mine", owner: OWNER },
  src_theirs: { account: "sac_theirs", owner: "usr_other" },
  src_unread: { account: null, owner: null },
  // A source with no sender account, a research source (gamma-wr-030): its creator the owner.
  src_research: { account: null, owner: OWNER },
  src_research_theirs: { account: null, owner: "usr_other" },
};
/** A checker that answers from KNOWN, leaves src_left_out out, and records each call's run and ids. */
function fake(calls: { workspaceId: string; sourceIds: string[] }[] = []): SourceChecker {
  return async (sourceIds) => {
    calls.push({ workspaceId: currentTenant().workspaceId, sourceIds: [...sourceIds] });
    return sourceIds.flatMap((sourceId) => {
      if (sourceId === "src_left_out") return [];
      const known = KNOWN[sourceId];
      const readingAccountId = known?.account ?? null;
      const readingOwnerUserId = known?.owner ?? null;
      return [{ sourceId, found: known !== undefined, readingAccountId, readingOwnerUserId }];
    });
  };
}

test("no checker registered: every set is playbook_source_checker_missing (503), the empty one included, and nothing is written; the check is refused the same", async (t) => {
  t.after(useSourceChecker(undefined));
  const ws = "wsp_checker_missing";
  const sourceIds = ["src_mine"];
  const playbookId = await seed({ workspaceId: ws, icpId: "icp_a", ownerUserId: OWNER, sourceIds });
  const missing = { code: "playbook_source_checker_missing", status: 503, details: undefined };
  for (const set of [["src_mine_too"], ["src_mine", "src_mine_too"], []]) {
    assert.deepEqual(await run(ws, () => setSources(playbookId, set)).catch(refusal), missing);
  }
  assert.deepEqual(
    await run(ws, () => checkSources(playbookId, ["src_mine"])).catch(refusal),
    missing,
  );
  assert.deepEqual(await run(ws, () => sourcesOf(playbookId)), ["src_mine"], "nothing written");
  assert.equal(await changes(ws), 0);
});

test("a fake checker: found through the owner's account, usable; not found or left out, playbook_source_not_found; another member's account or none, playbook_source_wrong_owner; each with its ids, the first refused code winning, nothing written", async (t) => {
  const calls: { workspaceId: string; sourceIds: string[] }[] = [];
  t.after(useSourceChecker(fake(calls)));
  const ws = "wsp_checker_fake";
  const playbookId = await seed({ workspaceId: ws, icpId: "icp_a", ownerUserId: OWNER });
  const set = (sourceIds: string[]) =>
    run(ws, () => setSources(playbookId, sourceIds)).catch(refusal);
  const notFound = (sourceIds: string[]) => ({
    code: "playbook_source_not_found",
    status: 409,
    details: { sourceIds },
  });
  const wrongOwner = (sourceIds: string[]) => ({
    code: "playbook_source_wrong_owner",
    status: 409,
    details: { sourceIds },
  });
  assert.deepEqual(
    await set(["src_mine", "src_theirs", "src_gone", "src_left_out"]),
    notFound(["src_gone", "src_left_out"]),
  );
  assert.deepEqual(
    await set(["src_unread", "src_mine", "src_theirs"]),
    wrongOwner(["src_unread", "src_theirs"]),
  );
  assert.deepEqual(await run(ws, () => sourcesOf(playbookId)), [], "nothing written");
  assert.equal(await changes(ws), 0);

  assert.deepEqual(await set(["src_mine_too", "src_mine"]), ["src_mine", "src_mine_too"]);
  assert.deepEqual(
    calls.at(-1),
    { workspaceId: ws, sourceIds: ["src_mine_too", "src_mine"] },
    "asked once for the set, in the caller's run",
  );
  assert.equal(calls.length, 3);
  assert.equal(await changes(ws), 1);
});

test("checkSources: each id once, in the order asked; usable only when found, read through the owner's account and held by no other agent; the code and the holder of the others", async (t) => {
  t.after(useSourceChecker(fake()));
  const ws = "wsp_checker_check";
  const sourceIds = ["src_mine_too"];
  const holder = await seed({ workspaceId: ws, icpId: "icp_a", ownerUserId: OWNER, sourceIds });
  const playbookId = await seed({ workspaceId: ws, icpId: "icp_b", ownerUserId: OWNER });
  const asked = ["src_theirs", "src_mine", "src_gone", "src_mine_too", "src_mine", "src_unread"];
  assert.deepEqual(await run(ws, () => checkSources(playbookId, asked)), [
    { sourceId: "src_theirs", usable: false, code: "playbook_source_wrong_owner", heldBy: null },
    { sourceId: "src_mine", usable: true, code: null, heldBy: null },
    { sourceId: "src_gone", usable: false, code: "playbook_source_not_found", heldBy: null },
    { sourceId: "src_mine_too", usable: false, code: "playbook_source_in_use", heldBy: holder },
    { sourceId: "src_unread", usable: false, code: "playbook_source_wrong_owner", heldBy: null },
  ]);
  assert.deepEqual(await run(ws, () => checkSources(playbookId, [])), []);
  const other = await seed({ workspaceId: ws, icpId: "icp_c", ownerUserId: "usr_other" });
  const [mine] = await run(ws, () => checkSources(other, ["src_mine"]));
  assert.equal(mine?.code, "playbook_source_wrong_owner", "the agent's owner, not the caller");
});

test("defineSourceChecker: one per process; a second registration is playbook_source_checker_duplicate (500) and the first stays", async (t) => {
  t.after(() => void useSourceChecker(undefined));
  useSourceChecker(undefined);
  const calls: { workspaceId: string; sourceIds: string[] }[] = [];
  defineSourceChecker(fake(calls));
  assert.throws(
    () => defineSourceChecker(fake()),
    (error: unknown) =>
      isAppError(error) &&
      error.code === "playbook_source_checker_duplicate" &&
      error.status === 500,
  );
  const ws = "wsp_checker_define";
  const playbookId = await seed({ workspaceId: ws, icpId: "icp_a", ownerUserId: OWNER });
  assert.deepEqual(await run(ws, () => setSources(playbookId, ["src_mine"])), ["src_mine"]);
  assert.equal(calls.length, 1, "the first checker answered");
});

test("a source with no sender account is usable by its creator's agent alone: the creator is its reading owner, another member's research source is playbook_source_wrong_owner, and one held by another agent is in use (gamma-wr-030)", async (t) => {
  t.after(useSourceChecker(fake()));
  const ws = "wsp_checker_research";
  const holder = await seed({
    ...{ workspaceId: ws, icpId: "icp_a", ownerUserId: OWNER, sourceIds: ["src_research"] },
  });
  const playbookId = await seed({ workspaceId: ws, icpId: "icp_b", ownerUserId: OWNER });
  const asked = ["src_research", "src_research_theirs", "src_mine"];
  assert.deepEqual(await run(ws, () => checkSources(playbookId, asked)), [
    { sourceId: "src_research", usable: false, code: "playbook_source_in_use", heldBy: holder },
    {
      sourceId: "src_research_theirs",
      usable: false,
      code: "playbook_source_wrong_owner",
      heldBy: null,
    },
    { sourceId: "src_mine", usable: true, code: null, heldBy: null },
  ]);
  const free = await seed({ workspaceId: ws, icpId: "icp_c", ownerUserId: OWNER });
  const set = (sourceIds: string[]) => run(ws, () => setSources(free, sourceIds)).catch(refusal);
  assert.deepEqual(await set(["src_research_theirs"]), {
    code: "playbook_source_wrong_owner",
    status: 409,
    details: { sourceIds: ["src_research_theirs"] },
  });
});
