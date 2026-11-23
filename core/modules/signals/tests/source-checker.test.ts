// signals' source checker (gamma-p5-045; README.md "Decided here"), against the worktree's database
// in the caller's tenant run: a source of the workspace is found with the sender account it reads
// through and that account's owner, each account read once; an unknown id, and another workspace's
// source, are not found and name no account; an account linkedin no longer finds leaves both ids
// null. Loading events.ts and workflows/index.ts, as the worker does from dist/, registers it once.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { createConnectedAccount, useLinkedinClient } from "@whytide/linkedin/testing";
import { AppError, isAppError, newId, servicePrincipal } from "@whytide/platform";
import { defineSourceChecker } from "@whytide/playbooks";
import { checkSources, type FindAccount } from "../domain/source-checker.ts";
import { ids } from "../ids.ts";
import { createSignalSource } from "../testing/index.ts";

withTestDb();
const client = asRole("app");
useLinkedinClient(client);
const principal = servicePrincipal("signals_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client });
const A = "wsp_checker_a";
const B = "wsp_checker_b";
const OWNER = "usr_checker_owner";

/** A post source of the workspace, read through the account: its id. */
async function sourceOn(workspaceId: string, senderAccountId: string): Promise<string> {
  const config = {
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000",
  };
  const source = await client.signalSource.create({
    data: {
      id: newId(ids.signal_source),
      ...{ workspaceId, kind: "post_engagers", config, label: "Launch post" },
      ...{ senderAccountId, createdBy: OWNER },
    },
  });
  return source.id;
}

/** linkedin's account read, the ids it was asked for kept in order. */
function counted(): { find: FindAccount; reads: string[] } {
  const reads: string[] = [];
  const find: FindAccount = async (accountId) => {
    reads.push(accountId);
    return findSenderAccount(accountId);
  };
  return { find, reads };
}

test("a source of the workspace is found, with the account it reads through and that account's owner; two sources on one account read it once; an unknown id is not found, both ids null", async () => {
  const account = (await createConnectedAccount(A, { ownerUserId: OWNER })).id;
  const other = (await createConnectedAccount(A, { ownerUserId: "usr_checker_member" })).id;
  const first = await sourceOn(A, account);
  const second = await sourceOn(A, account);
  const theirs = await sourceOn(A, other);
  const unknown = newId(ids.signal_source);
  const { find, reads } = counted();
  const answers = await inRun(A, () => checkSources([second, unknown, first, theirs], find));
  const found = (sourceId: string, readingAccountId: string, readingOwnerUserId: string) => ({
    ...{ sourceId, found: true, readingAccountId, readingOwnerUserId },
  });
  assert.deepEqual(answers, [
    found(second, account, OWNER),
    { sourceId: unknown, found: false, readingAccountId: null, readingOwnerUserId: null },
    found(first, account, OWNER),
    found(theirs, other, "usr_checker_member"),
  ]);
  assert.deepEqual(reads.sort(), [account, other].sort());
  assert.deepEqual(await inRun(A, () => checkSources([], find)), []);
});

test("protective rule, tenant isolation: another workspace's source is not found and its account is never named nor read", async () => {
  const mine = (await createConnectedAccount(A, { ownerUserId: OWNER })).id;
  const theirs = (await createConnectedAccount(B, { ownerUserId: OWNER })).id;
  const own = await sourceOn(A, mine);
  const another = await sourceOn(B, theirs);
  const { find, reads } = counted();
  const answers = await inRun(A, () => checkSources([another, own], find));
  assert.deepEqual(answers, [
    { sourceId: another, found: false, readingAccountId: null, readingOwnerUserId: null },
    { sourceId: own, found: true, readingAccountId: mine, readingOwnerUserId: OWNER },
  ]);
  assert.ok(!JSON.stringify(answers).includes(theirs), "the answer names the other's account");
  assert.deepEqual(reads, [mine]);
  // In B's own run, the same source is found.
  const [inB] = await inRun(B, () => checkSources([another]));
  assert.deepEqual(inB, {
    ...{ sourceId: another, found: true, readingAccountId: theirs, readingOwnerUserId: OWNER },
  });
});

test("a source whose account linkedin no longer finds is found with both ids null, which playbooks refuses as read by another; another failure of the read is not hidden", async () => {
  const account = (await createConnectedAccount(A, { ownerUserId: OWNER })).id;
  const source = await sourceOn(A, account);
  const gone: FindAccount = async () => {
    throw new AppError(linkedinErrors.sender_account_not_found);
  };
  assert.deepEqual(await inRun(A, () => checkSources([source], gone)), [
    { sourceId: source, found: true, readingAccountId: null, readingOwnerUserId: null },
  ]);
  const broken: FindAccount = async () => {
    throw new Error("the database is down");
  };
  await assert.rejects(
    inRun(A, () => checkSources([source], broken)),
    /the database is down/,
  );
});

test("loading events.ts and workflows/index.ts, as the worker does, registers the checker once", async () => {
  await import("../events.ts");
  await import("../workflows/index.ts");
  assert.throws(
    () => defineSourceChecker(async () => []),
    (error: unknown) => isAppError(error) && error.code === "playbook_source_checker_duplicate",
  );
});

const RESEARCH = { kind: "web_research", config: { focus: "traders of grain" } };

test("a research source, with no sender account, is found with no reading account and its creator as the reading owner, and no account is read", async () => {
  const mine = await createSignalSource({
    ...{ workspaceId: A, label: "Grain", senderAccountId: null, createdBy: OWNER },
    ...RESEARCH,
  });
  const account = (await createConnectedAccount(A, { ownerUserId: "usr_checker_member" })).id;
  const linked = await sourceOn(A, account);
  const { find, reads } = counted();
  const answers = await inRun(A, () => checkSources([mine.id, linked], find));
  assert.deepEqual(answers, [
    { sourceId: mine.id, found: true, readingAccountId: null, readingOwnerUserId: OWNER },
    {
      ...{ sourceId: linked, found: true, readingAccountId: account },
      readingOwnerUserId: "usr_checker_member",
    },
  ]);
  assert.deepEqual(reads, [account], "an account was read for a source with none");
});

test("protective rule, tenant isolation: another workspace's research source is not found, and in its own workspace it is found", async () => {
  const theirs = await createSignalSource({
    ...{ workspaceId: B, label: "Grain", senderAccountId: null, createdBy: OWNER },
    ...RESEARCH,
  });
  assert.deepEqual(await inRun(A, () => checkSources([theirs.id])), [
    { sourceId: theirs.id, found: false, readingAccountId: null, readingOwnerUserId: null },
  ]);
  const [inB] = await inRun(B, () => checkSources([theirs.id]));
  assert.equal(inB?.found, true);
});
