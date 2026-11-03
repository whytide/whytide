// The acceptance rule's safety cases (beta-p6-020; RB-11.3.1, reduced; README.md "Health"), run by
// `pnpm -F @whytide/linkedin test:safety`. The day's check of the pending invitations measures the
// account's acceptance over its last 100 connection requests at least 7 days old, as its last step,
// with no provider call and no read of its own: 19 accepted of 100 pauses its invites (at_risk), with
// one health event and linkedin.account_paused, the owner's mail, while its messages reserve; 99 old
// invites never change the state, and younger ones are not counted; 20 of 100 at a later day's check
// lifts the pause, with no mail; an acceptance the same check finds counts; a restricted, checkpoint
// or disconnected account keeps its state whatever its rate; a retry of a check that failed after
// its count applies the rule the failed attempt missed (beta-p6-040).
import assert from "node:assert/strict";
import test from "node:test";
import { tenantClient } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { findAccount } from "../../domain/accounts.ts";
import { applyAcceptanceRule } from "../../domain/health/acceptance.ts";
import type { HealthState } from "../../domain/health/states.ts";
import { type CheckCalls, checkInvites } from "../../domain/invites/check.ts";
import { remainingToday } from "../../domain/quota/reservations.ts";
import { sendStateRefusal } from "../../domain/send/state.ts";
import {
  createInvites,
  setHealth,
  useClock,
  useLinkedinClient,
  useRandom,
} from "../../testing/index.ts";
import { ALWAYS, granted, sender, THURSDAY } from "../fixtures/send.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
let today = THURSDAY;
useClock(() => today);
useRandom(() => 0.5);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const PAUSED = "linkedin.account_paused";

type Sender = Awaited<ReturnType<typeof sender>>;

test.afterEach(() => {
  today = THURSDAY;
});

/**
 * `count` invites of the account sent `days` days before THURSDAY, a minute apart going back, the
 * first `accepted` of them accepted an hour after; `memberRef`, the first one not accepted's member.
 */
function invites(account: Sender, days: number, count: number, accepted = 0, memberRef?: string) {
  const rows = Array.from({ length: count }, (_, i) => {
    const invitedAt = new Date(THURSDAY.getTime() - days * DAY_MS - i * MINUTE_MS);
    const acceptedAt = i < accepted ? new Date(invitedAt.getTime() + HOUR_MS) : null;
    const member =
      i === accepted && memberRef !== undefined ? { providerMemberRef: memberRef } : {};
    return { invitedAt, acceptedAt, ...member };
  });
  return createInvites(account.workspaceId, account.id, rows);
}

/** Today's row made, at `day`, and the clock moved a minute past its check_after: the check due. */
async function checkDue(account: Sender, day = THURSDAY): Promise<Date> {
  today = day;
  await account.run(() => remainingToday(account.id));
  const checkAfter = (await account.days()).at(-1)?.checkAfter ?? null;
  assert.ok(checkAfter !== null && checkAfter >= day, "the day's check lies ahead");
  today = new Date(checkAfter.getTime() + MINUTE_MS);
  return today;
}

/** The day's check, the vendor listing no invitation and answering every relation connected. */
async function check(account: Sender) {
  const called: string[] = [];
  const calls: CheckCalls = {
    tenant: (fn) => account.run(fn),
    listPendingInvites: async () => {
      called.push("listPendingInvites");
      return { ok: { invites: [], nextCursor: null } };
    },
    getRelation: async () => {
      called.push("getRelation");
      return { ok: { connected: true, invitationPending: false } };
    },
  };
  return { answer: await checkInvites(calls, account.id), called };
}

/** The account's state, its events (`rows`, and `from>to:trigger`) and the events announced. */
async function healthOf(account: Sender) {
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  const rows = await app.senderHealthEvent.findMany({
    where: { senderId: account.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const paused = await app.outboxEntry.findMany({
    where: { workspaceId: account.workspaceId, eventName: PAUSED },
  });
  return {
    state: row.healthState,
    rows,
    events: rows.map((event) => `${event.fromState}>${event.toState}:${event.trigger}`),
    announced: paused.map(
      (entry) => (entry.payload as { health_event_id: string }).health_event_id,
    ),
  };
}

/** The send activity's re-read just before the port call (domain/send/gate.ts). */
const gate = (account: Sender, type: "invite" | "message") =>
  account.run(async () => sendStateRefusal(await findAccount(account.id), type, today));

test("19 accepted of the last 100 invites at least 7 days old pause the account's invites at the day's check, its last step: at_risk, one health event acceptance_rate with the three numbers and linkedin.account_paused; the next invite is refused invites_paused by the reservation and by the gate, a message reserves; younger invites are not counted; no provider call and no read of its own", async () => {
  const account = await sender("UTC", ALWAYS);
  await invites(account, 8, 100, 19);
  // Younger than 7 days, every one accepted: not counted.
  await createInvites(account.workspaceId, account.id, [
    { invitedAt: new Date(THURSDAY.getTime() - 6 * DAY_MS), acceptedAt: THURSDAY },
  ]);
  const checkedAt = await checkDue(account);
  const { answer, called } = await check(account);
  const acceptance = { sample: 100, accepted: 19, rate: 0.19 };
  assert.deepEqual(answer, { due: true, pending: 0, accepted: 0, checked: 0, acceptance });
  assert.deepEqual(called, ["listPendingInvites"], "the list's page only: the rule calls nothing");
  const [day] = await account.days();
  assert.deepEqual([day?.readsCommitted, day?.readsReserved], [1, 0], "the list's read only");

  const health = await healthOf(account);
  assert.deepEqual([health.state, health.events], ["at_risk", ["healthy>at_risk:acceptance_rate"]]);
  const [event] = health.rows;
  assert.ok(event !== undefined);
  assert.deepEqual(
    [event.metrics, event.automaticAction, event.pausedUntil, event.createdAt],
    [acceptance, "paused_invites", null, checkedAt],
  );
  assert.deepEqual(health.announced, [event.id], "one linkedin.account_paused: the owner's mail");

  assert.deepEqual(await account.send("invite-after", "invite"), {
    refused: "invites_paused",
    retryAt: null,
  });
  assert.deepEqual(await gate(account, "invite"), { refused: "invites_paused", retryAt: null });
  granted(await account.send("message-after", "message"));
  assert.equal(await gate(account, "message"), null);
  assert.equal((await account.run(() => remainingToday(account.id))).invites, 0);

  // Another run that day: the check is not due, and the rule does not run again.
  assert.deepEqual((await check(account)).answer, { due: false });
  assert.equal((await healthOf(account)).events.length, 1);
});

test("99 old invites never change the state, whatever the rate: a healthy account none accepted stays healthy, an at_risk one all accepted stays at_risk; the rate is null and no event is written", async () => {
  const cases = [
    ["healthy", 0],
    ["at_risk", 99],
  ] as const;
  for (const [state, accepted] of cases) {
    const account = await sender("UTC", ALWAYS);
    if (state === "at_risk") await setHealth(account.id, "at_risk");
    await invites(account, 8, 99, accepted);
    await checkDue(account);
    // One more, accepted, a minute short of 7 days old at the check: not in the sample.
    const young = new Date(today.getTime() - 7 * DAY_MS + MINUTE_MS);
    await createInvites(account.workspaceId, account.id, [{ invitedAt: young, acceptedAt: today }]);
    const { answer } = await check(account);
    assert.deepEqual(
      answer,
      {
        due: true,
        pending: 0,
        accepted: 0,
        checked: 0,
        acceptance: { sample: 99, accepted, rate: null },
      },
      state,
    );
    const health = await healthOf(account);
    assert.deepEqual([health.state, health.events, health.announced], [state, [], []], state);
  }
});

test("20 accepted of 100 at a later day's check lift at_risk back to healthy: a health event acceptance_rate with the numbers, no second linkedin.account_paused; invites reserve again", async () => {
  const account = await sender("UTC", ALWAYS);
  const rows = await invites(account, 8, 100, 19);
  await checkDue(account);
  await check(account);
  assert.equal((await healthOf(account)).state, "at_risk");

  // One more accepted meanwhile, as the receiver records a webhook's acceptance.
  const late = rows[50];
  assert.ok(late !== undefined);
  await app.senderOutreach.update({ where: { id: late.id }, data: { acceptedAt: today } });
  const friday = await checkDue(account, new Date(THURSDAY.getTime() + DAY_MS));
  const { answer } = await check(account);
  const acceptance = { sample: 100, accepted: 20, rate: 0.2 };
  assert.deepEqual(answer, { due: true, pending: 0, accepted: 0, checked: 0, acceptance });
  const health = await healthOf(account);
  assert.equal(health.state, "healthy");
  assert.deepEqual(health.events, [
    "healthy>at_risk:acceptance_rate",
    "at_risk>healthy:acceptance_rate",
  ]);
  const [, lifted] = health.rows;
  assert.ok(lifted !== undefined);
  assert.deepEqual(
    [lifted.metrics, lifted.automaticAction, lifted.createdAt],
    [acceptance, "resumed", friday],
  );
  assert.equal(health.announced.length, 1, "no mail for the lift");
  granted(await account.send("invite-again", "invite"));
});

test("an acceptance found by the same day's missed-acceptance pass counts: 19 accepted and one the vendor says is connected make 20 of 100, and the account stays healthy", async () => {
  const account = await sender("UTC", ALWAYS);
  await invites(account, 8, 100, 19, "member-missed");
  await checkDue(account);
  const { answer, called } = await check(account);
  const acceptance = { sample: 100, accepted: 20, rate: 0.2 };
  assert.deepEqual(answer, { due: true, pending: 0, accepted: 1, checked: 1, acceptance });
  assert.deepEqual(called, ["listPendingInvites", "getRelation"]);
  const health = await healthOf(account);
  assert.deepEqual([health.state, health.events], ["healthy", []]);
});

test("a restricted, checkpoint or disconnected account keeps its state whatever its rate: the day's check is refused its reads before the rule, and the rule itself moves none of them, at 0 or 100 accepted of 100", async () => {
  const states: HealthState[] = ["restricted", "checkpoint", "disconnected"];
  for (const state of states) {
    const account = await sender("UTC", ALWAYS);
    const rows = await invites(account, 8, 100, 0);
    await checkDue(account);
    const cooldown = state === "disconnected" ? null : new Date(today.getTime() + 72 * HOUR_MS);
    await setHealth(account.id, state, { pausedUntil: cooldown });
    const { answer, called } = await check(account);
    assert.deepEqual(answer, { due: true, refused: "account_paused" }, state);
    assert.deepEqual(called, [], state);

    const rule = () => account.run(() => applyAcceptanceRule(tenantClient, account.id, today));
    assert.deepEqual(await rule(), { sample: 100, accepted: 0, rate: 0 }, state);
    const ids = rows.map(({ id }) => id);
    await app.senderOutreach.updateMany({
      where: { id: { in: ids } },
      data: { acceptedAt: today },
    });
    assert.deepEqual(await rule(), { sample: 100, accepted: 100, rate: 1 }, state);
    const health = await healthOf(account);
    assert.deepEqual([health.state, health.events, health.announced], [state, [], []], state);
  }
});

test("a retry of a check that failed once its count was written applies the rule the failed attempt missed: the day checked, the account healthy; the retry, the check not due, pauses its invites with one event; a later run's first attempt applies nothing, a third attempt changes nothing", async () => {
  const account = await sender("UTC", ALWAYS);
  await invites(account, 8, 100, 19, "member-gone");
  await checkDue(account);
  const calls: CheckCalls = {
    tenant: (fn) => account.run(fn),
    listPendingInvites: async () => ({ ok: { invites: [], nextCursor: null } }),
    getRelation: async () => {
      throw new Error("the worker lost its connection");
    },
  };
  await assert.rejects(checkInvites(calls, account.id), /lost its connection/);
  assert.ok((await account.days()).at(-1)?.checkedAt, "the count and checked_at written");
  assert.deepEqual((await healthOf(account)).events, [], "the rule not applied");

  const acceptance = { sample: 100, accepted: 19, rate: 0.19 };
  assert.deepEqual(await checkInvites(calls, account.id, 2), { due: false, acceptance });
  const health = await healthOf(account);
  assert.deepEqual([health.state, health.events], ["at_risk", ["healthy>at_risk:acceptance_rate"]]);
  assert.equal(health.announced.length, 1, "the owner's mail, once");

  assert.deepEqual(await checkInvites(calls, account.id), { due: false });
  assert.deepEqual(await checkInvites(calls, account.id, 3), { due: false, acceptance });
  assert.deepEqual(await healthOf(account), health, "nothing more");
});
