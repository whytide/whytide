// linkedin's daily check of the pending invitations (beta-p4-070; core/modules/linkedin/README.md
// "Worker"), inside the hourly linkedin_status_refresh, on the slice's Temporal and a schema of its
// database, the LinkedIn fake bound: the host started with linkedin from its build, as the worker
// loads it, on linkedin's clock. Invites sent through linkedin_send_invite, one accepted on the fake
// with no webhook and one dropped there, as a decline leaves it: the check after the day's
// check_after counts the one pending, detects the acceptance and publishes linkedin.invite_accepted
// once, asks the declined one once, each call a read in the log and in the day's reads; another run
// that day, or before the next day's check_after, makes no call; a refused read makes none either and
// leaves the count. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { Client, Connection } from "@temporalio/client";
import { collectLogs, createLogger } from "@whytide/platform";
import { workerConfig } from "../src/config.ts";
import { moduleLoaders } from "../src/modules.generated.ts";
import {
  db,
  fake,
  later,
  linkedin,
  quota,
  type Sender,
  sender,
  THURSDAY,
  useSendTests,
} from "./fixtures/linkedin-send.ts";

useSendTests();
linkedin.useRandom(() => 0.5);
const { start } = await import("../src/start.ts");
type Hash = typeof import("../../../modules/linkedin/dist/domain/hash.js");
const hash: Hash = await import(
  new URL("../../../modules/linkedin/dist/domain/hash.js", import.meta.url).href
);
const log = createLogger({ destination: collectLogs().destination });
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const CHECK_CALLS = new Set(["listPendingInvites", "getRelation"]);
const ACCEPTED = "linkedin.invite_accepted";

/** `fn` with the host started, linkedin alone, on a queue of its own, and its hourly run; closed after. */
async function withHost(fn: (hourly: () => Promise<unknown>) => Promise<void>) {
  const connection = await Connection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  const temporal = new Client({ connection, namespace: workerConfig.TEMPORAL_NAMESPACE });
  const modules = moduleLoaders.filter(({ name }) => name === "linkedin");
  const taskQueue = `test-${randomUUID()}`;
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    client: db(),
    log,
    schedules: "off",
  });
  const hourly = () =>
    temporal.workflow.execute("linkedin_status_refresh", {
      args: [{}],
      taskQueue,
      workflowId: `linkedin_status_refresh-${randomUUID()}`,
    });
  try {
    await fn(hourly);
  } finally {
    await host.close();
    await connection.close();
  }
}

/** The fixture's account, its member id the fake's own, so that the refresh replaces nothing. */
async function account(): Promise<Sender> {
  const made = await sender();
  const { memberRef } = await fake.getAccountStatus(made.ref);
  const memberIdHash = hash.memberHash(memberRef ?? "");
  await db().senderAccount.update({ where: { id: made.accountId }, data: { memberIdHash } });
  return made;
}

const checkCalls = () => fake.recordedCalls.filter(({ method }) => CHECK_CALLS.has(method));
const row = (id: string) => db().senderAccount.findUniqueOrThrow({ where: { id } });
const days = (senderAccountId: string) =>
  db().senderQuotaUsage.findMany({ where: { senderAccountId }, orderBy: { quotaDay: "asc" } });
const outreachOf = (personId: string) =>
  db().senderOutreach.findFirstOrThrow({ where: { personId } });
const accepted = (workspaceId: string) =>
  db().outboxEntry.findMany({ where: { workspaceId, eventName: ACCEPTED } });
/** The account's log rows of a kind, as `outcome` or `objectRef:outcome`, sorted. */
async function logged(
  senderAccountId: string,
  kind: "pending_invites" | "relation_check" | "status_check",
) {
  const rows = await db().senderActionLog.findMany({ where: { senderAccountId, kind } });
  return rows
    .map(({ objectRef, outcome }) => (objectRef ? `${objectRef}:${outcome}` : outcome))
    .sort();
}
/** linkedin's clock, as the fixture moves it from THURSDAY at each test's start. */
let clock = THURSDAY;
beforeEach(() => {
  clock = THURSDAY;
});
const moveTo = (instant: Date): void => {
  later(instant.getTime() - clock.getTime());
  clock = instant;
};

test("the hourly run checks once a day, after the day's check_after: the count of the pending invitations, an acceptance the webhook missed detected and published once, a declined invite asked once, each call a read; another run that day, and the next day's before its check_after, make no call", () =>
  withHost(async (hourly) => {
    const a = await account();
    const steps = [await a.step("invite"), await a.step("invite"), await a.step("invite")];
    for (const step of steps) {
      const sent = await a.call("linkedin_send_invite", step.input());
      assert.deepEqual(sent, { sent: true, stepExecutionId: step.stepExecutionId });
    }
    assert.equal((await row(a.accountId)).pendingInvites, 3, "each committed invite adds one");
    const [kept, missed, declined] = steps as [
      (typeof steps)[0],
      (typeof steps)[0],
      (typeof steps)[0],
    ];
    fake.acceptInvite(a.ref, missed.memberRef); // no webhook
    const invitationRef = (await outreachOf(declined.personId)).providerInvitationRef ?? "";
    await fake.withdrawInvite({ providerAccountRef: a.ref, invitationRef }); // as a decline leaves it

    assert.deepEqual(await hourly(), { accounts: 1, failed: 0 });
    assert.deepEqual(checkCalls(), [], "not due before check_after");
    const [thursday] = await days(a.accountId);
    const checkAfter = thursday?.checkAfter ?? null;
    assert.ok(checkAfter !== null && checkAfter > THURSDAY);
    const checkedAt = new Date(checkAfter.getTime() + MINUTE_MS);
    moveTo(checkedAt);

    assert.deepEqual(await hourly(), { accounts: 1, failed: 0 });
    assert.deepEqual(
      checkCalls().map(({ method }) => method),
      ["listPendingInvites", "getRelation", "getRelation"],
    );
    const after = await row(a.accountId);
    assert.deepEqual([after.pendingInvites, after.pendingInvitesCheckedAt], [1, checkedAt]);
    assert.deepEqual((await days(a.accountId))[0]?.checkedAt, checkedAt);
    const detected = await outreachOf(missed.personId);
    assert.deepEqual(
      [detected.acceptedAt, detected.acceptedDetectedAt, detected.relationCheckedAt],
      [checkedAt, checkedAt, checkedAt],
    );
    const gone = await outreachOf(declined.personId);
    assert.deepEqual([gone.acceptedAt, gone.relationCheckedAt], [null, checkedAt]);
    assert.equal((await outreachOf(kept.personId)).relationCheckedAt, null, "pending: not asked");
    const events = await accepted(a.workspaceId);
    const payload = {
      sender_account_id: a.accountId,
      person_id: missed.personId,
      detected_at: checkedAt.toISOString(),
    };
    assert.deepEqual(
      events.map((entry) => entry.payload),
      [payload],
    );
    assert.deepEqual(await logged(a.accountId, "pending_invites"), ["ok", "reserved"]);
    const asked = [missed.personId, declined.personId].flatMap((id) => [
      `${id}:ok`,
      `${id}:reserved`,
    ]);
    assert.deepEqual(await logged(a.accountId, "relation_check"), asked.sort());
    const usage = await a.run(() => quota.readUsage(a.accountId));
    assert.deepEqual([usage.committed, usage.actions.used], [3, 6], "three reads, in the 200");

    moveTo(new Date(checkedAt.getTime() + HOUR_MS));
    await hourly();
    assert.equal(checkCalls().length, 3, "one check a day");
    assert.equal((await logged(a.accountId, "status_check")).length, 3, "each run refreshes");

    const friday = new Date("2026-10-23T08:00:00Z");
    moveTo(friday);
    await hourly();
    assert.equal(checkCalls().length, 3, "not due before Friday's check_after");
    const fridayRow = (await days(a.accountId))[1];
    const nextCheck = fridayRow?.checkAfter ?? null;
    assert.ok(nextCheck !== null && nextCheck > friday);
    const timeOfDay = (instant: Date) => instant.getTime() % (24 * HOUR_MS);
    assert.notEqual(timeOfDay(nextCheck), timeOfDay(checkAfter), "another time each day");
    moveTo(new Date(nextCheck.getTime() + MINUTE_MS));
    await hourly();
    assert.deepEqual(
      checkCalls().map(({ method }) => method),
      ["listPendingInvites", "getRelation", "getRelation", "listPendingInvites"],
      "the declined and the accepted invites are not asked again",
    );
    assert.equal((await accepted(a.workspaceId)).length, 1, "a second check publishes nothing");
    assert.equal((await row(a.accountId)).pendingInvites, 1);
  }));

test("a refused read, the account paused, the read cap reached or outside its hours, makes no call and leaves the count; the next day's check runs", () =>
  withHost(async (hourly) => {
    const a = await account();
    const hours = { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5, 6, 7] };
    await db().senderAccount.update({ where: { id: a.accountId }, data: { workingHours: hours } });
    await hourly(); // today's row made, its check_after drawn in what is left of the window
    const [day] = await days(a.accountId);
    const checkAfter = day?.checkAfter ?? null;
    assert.ok(checkAfter !== null);
    moveTo(new Date(checkAfter.getTime() + MINUTE_MS));
    const before = await row(a.accountId);

    await linkedin.setAccountPaused(a.accountId, "tester");
    await hourly();
    await linkedin.setAccountPaused(a.accountId, null);
    const capped = { readsCommitted: day?.readAllowance ?? 0 };
    await db().senderQuotaUsage.update({ where: { id: day?.id ?? "" }, data: capped });
    await hourly();
    await db().senderQuotaUsage.update({
      where: { id: day?.id ?? "" },
      data: { readsCommitted: 0 },
    });
    moveTo(new Date("2026-10-22T17:30:00Z"));
    await hourly();
    assert.deepEqual(checkCalls(), [], "no call");
    assert.deepEqual(await logged(a.accountId, "pending_invites"), [
      "account_stopped",
      "outside_working_hours",
      "read_cap_reached",
    ]);
    const after = await row(a.accountId);
    assert.deepEqual(
      [after.pendingInvites, after.pendingInvitesCheckedAt],
      [before.pendingInvites, before.pendingInvitesCheckedAt],
      "the count as it was",
    );
    assert.equal((await days(a.accountId))[0]?.checkedAt, null);

    moveTo(new Date("2026-10-23T09:00:00Z"));
    await hourly();
    const nextCheck = (await days(a.accountId))[1]?.checkAfter ?? null;
    assert.ok(nextCheck !== null);
    const checkedAt = new Date(nextCheck.getTime() + MINUTE_MS);
    moveTo(checkedAt);
    await hourly();
    assert.deepEqual(
      checkCalls().map(({ method }) => method),
      ["listPendingInvites"],
    );
    const counted = await row(a.accountId);
    assert.deepEqual([counted.pendingInvites, counted.pendingInvitesCheckedAt], [0, checkedAt]);
  }));
