// The safety cases of the ramp (beta-p1-080; docs/security.md "Budgets"), run by
// `pnpm -F @whytide/linkedin test:safety` and not by `test`: over seeded random sequences of quota
// days, committed sends, switch states, statuses, health states and repeated runs of the daily
// job's ramp on the database, no target leaves 5 to 15 and 10 to 40; nothing rises while the account
// cannot act, and a change then is a fall; no target rises without a send of its type since the last
// step, nor twice within 2 quota days; none falls but after 14 quota days without a send, and then to
// 7 and 20 at most, whether it can act or not; a repeat the same day changes nothing. An account kept
// closed for 20 quota days opens at 5 and 10, and ten runs racing on one account give one step.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createDbClient, type PrismaClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, quotaDay, servicePrincipal, synthetic } from "@whytide/platform";
import type { SenderAccountStatus } from "../../domain/accounts.ts";
import type { HealthState } from "../../domain/health/states.ts";
import { DAY_MS, INVITES_PER_DAY, MESSAGES_PER_DAY } from "../../domain/quota/constants.ts";
import { quotaDayBefore } from "../../domain/quota/limits.ts";
import { remainingToday } from "../../domain/quota/reservations.ts";
import { rampAccount } from "../../domain/ramp/account.ts";
import { RAMP_EVERY_DAYS, RAMP_IDLE_DAYS } from "../../domain/ramp/constants.ts";
import type { WorkingHours } from "../../domain/working-hours.ts";
import { ids } from "../../ids.ts";
import {
  createConnectedAccount,
  setAccountPaused,
  setHealth,
  setPlatformControls,
  setWorkspaceStopped,
  useClock,
  useLinkedinClient,
  useRandom,
} from "../../testing/index.ts";

const db = withTestDb();
const app = asRole("app");
useLinkedinClient(app);
const principal = servicePrincipal("linkedin_safety");
const ALWAYS: WorkingHours = { start: "00:00", end: "23:59", days: [1, 2, 3, 4, 5, 6, 7] };
const ZONES = ["UTC", "America/Los_Angeles", "Europe/Paris", "Pacific/Auckland", "Asia/Kolkata"];
const STATUSES: SenderAccountStatus[] = ["connected", "credentials_required", "disconnected"];
const UNHEALTHY: HealthState[] = ["at_risk", "restricted", "checkpoint", "disconnected"];
const SEEDS = [1, 2, 3, 4, 5, 6];
const DAYS = 45;
/** An even seed's quota days without a send: longer than RAMP_IDLE_DAYS. */
const IDLE_FROM = 5;
const IDLE_UNTIL = 30;
const MINUTE_MS = 60_000;
/** The schedule's time, 00:30 UTC, on Monday 2 November 2026. */
const FIRST_RUN = Date.UTC(2026, 10, 2, 0, 30);
/** Where an idle account restarts: half of 15 and 40, rounded down (docs/concepts.md "Ramp"). */
const RESTART = { invites: 7, messages: 20 };

type Switches = {
  sendingOpen: boolean;
  platformStopped: boolean;
  workspaceStopped: boolean;
  paused: boolean;
  status: SenderAccountStatus;
  health: HealthState;
};

const readAccount = (id: string) =>
  app.senderAccount.findUniqueOrThrow({
    where: { id },
    select: { inviteTarget: true, messageTarget: true, rampUpdatedOn: true },
  });
const inRun = <T>(workspaceId: string, fn: () => Promise<T>, client: PrismaClient = app) =>
  withTenant({ workspaceId, principal }, fn, { client, timeout: 30_000 });
/** A connected account of a new workspace, in the zone, open all week. */
async function account(timeZone = "UTC") {
  const workspaceId = `wsp_safety${randomBytes(6).toString("hex")}`;
  const { id } = await createConnectedAccount(workspaceId, { timeZone, workingHours: ALWAYS });
  return { id, workspaceId };
}
/** Sends committed on the account's quota day, its usage row made when missing. */
async function commit(
  workspaceId: string,
  senderAccountId: string,
  day: { quotaDay: string; timeZone: string },
  invites: number,
  messages: number,
) {
  const key = { workspaceId, senderAccountId, quotaDay: day.quotaDay };
  await app.senderQuotaUsage.upsert({
    where: { workspaceId_senderAccountId_quotaDay: key },
    create: {
      id: newId(ids.sender_quota_usage),
      workspaceId,
      senderAccountId,
      ...day,
      invitesCommitted: invites,
      messagesCommitted: messages,
    },
    update: {
      invitesCommitted: { increment: invites },
      messagesCommitted: { increment: messages },
    },
  });
}
/** Whether a send of the type was committed on a quota day after `after`, up to `today`. */
async function sentSince(
  accountId: string,
  after: string,
  today: string,
  type: "invite" | "message",
) {
  const committed =
    type === "invite" ? { invitesCommitted: { gt: 0 } } : { messagesCommitted: { gt: 0 } };
  const row = await app.senderQuotaUsage.findFirst({
    where: { senderAccountId: accountId, quotaDay: { gt: after, lte: today }, ...committed },
  });
  return row !== null;
}
/** Whether a send was committed in the RAMP_IDLE_DAYS quota days before `today`. */
async function sentBefore(accountId: string, today: string) {
  const row = await app.senderQuotaUsage.findFirst({
    where: {
      senderAccountId: accountId,
      quotaDay: { gte: quotaDayBefore(today, RAMP_IDLE_DAYS), lt: today },
      OR: [{ invitesCommitted: { gt: 0 } }, { messagesCommitted: { gt: 0 } }],
    },
  });
  return row !== null;
}
const canAct = (state: Switches) =>
  state.sendingOpen &&
  !state.platformStopped &&
  !state.workspaceStopped &&
  !state.paused &&
  state.status === "connected" &&
  state.health === "healthy";

/** The switches, the status and the health written as the operator, the tester, the provider and a warning leave them. */
async function write(workspaceId: string, accountId: string, state: Switches) {
  await setPlatformControls({ sendingOpen: state.sendingOpen, stopped: state.platformStopped });
  await setWorkspaceStopped(workspaceId, state.workspaceStopped ? "tester" : null);
  await setAccountPaused(accountId, state.paused ? "operator" : null);
  await app.senderAccount.update({ where: { id: accountId }, data: { status: state.status } });
  await setHealth(accountId, state.health);
}

/**
 * One seeded sequence on an account of its own, its targets anywhere within the bounds at first,
 * some with sends the day before: each quota day, the switches and the status change now and then,
 * the ramp runs one to three times, and then the day's sends are committed, some days none, some days
 * connection requests or messages only. After each day's runs: the bounds; no rise while the account
 * cannot act, and a change then only a fall; a rise only with a send of its type since the last step,
 * and never within 2 quota days of the last rise; a fall only after 14 quota days without a send, to
 * 7 and 20 at most; the repeats change nothing.
 */
async function sequence(seed: number): Promise<{ rises: number; restarts: number }> {
  const s = synthetic(`linkedin-ramp-bounds-${seed}`);
  const timeZone = s.pick(ZONES);
  const { id, workspaceId } = await account(timeZone);
  const inviteTarget =
    INVITES_PER_DAY.start + s.int(INVITES_PER_DAY.target - INVITES_PER_DAY.start + 1);
  const messageTarget =
    MESSAGES_PER_DAY.start + s.int(MESSAGES_PER_DAY.target - MESSAGES_PER_DAY.start + 1);
  await app.senderAccount.update({ where: { id }, data: { inviteTarget, messageTarget } });
  if (s.int(2) === 0) {
    const yesterday = quotaDayBefore(quotaDay(new Date(FIRST_RUN), timeZone), 1);
    await commit(workspaceId, id, { quotaDay: yesterday, timeZone }, 1, 1);
  }
  const state: Switches = {
    sendingOpen: s.int(2) === 0,
    platformStopped: false,
    workspaceStopped: false,
    paused: false,
    status: "connected",
    health: "healthy",
  };
  let lastRise: string | undefined;
  const counts = { rises: 0, restarts: 0 };
  for (let n = 0; n < DAYS; n += 1) {
    if (s.int(4) === 0) state.sendingOpen = !state.sendingOpen;
    state.platformStopped = s.int(12) === 0;
    state.workspaceStopped = s.int(12) === 0;
    state.paused = s.int(10) === 0;
    state.status = s.int(8) === 0 ? s.pick(STATUSES) : "connected";
    state.health = s.int(8) === 0 ? s.pick(UNHEALTHY) : "healthy";
    await write(workspaceId, id, state);
    const at = new Date(FIRST_RUN + n * DAY_MS);
    const today = quotaDay(at, timeZone);
    const before = await readAccount(id);
    const first = await inRun(workspaceId, () => rampAccount(id, at));
    const after = await readAccount(id);
    for (let again = s.int(3); again > 0; again -= 1) {
      const later = new Date(at.getTime() + s.int(30) * MINUTE_MS);
      assert.equal(await inRun(workspaceId, () => rampAccount(id, later)), null, "a repeat");
    }
    const label = `seed ${seed}, day ${n} (${today} in ${timeZone})`;
    assert.deepEqual(await readAccount(id), after, `${label}: the repeats changed nothing`);
    assert.ok(after.inviteTarget >= INVITES_PER_DAY.start, label);
    assert.ok(after.inviteTarget <= INVITES_PER_DAY.target, label);
    assert.ok(after.messageTarget >= MESSAGES_PER_DAY.start, label);
    assert.ok(after.messageTarget <= MESSAGES_PER_DAY.target, label);
    const invitesRose = after.inviteTarget > before.inviteTarget;
    const messagesRose = after.messageTarget > before.messageTarget;
    const lowered =
      after.inviteTarget < before.inviteTarget || after.messageTarget < before.messageTarget;
    if (!canAct(state)) {
      assert.ok(!invitesRose && !messagesRose, `${label}: no rise while it cannot act`);
      if (first !== null) assert.ok(lowered, `${label}: a change while it cannot act, no fall`);
      else assert.deepEqual(after, before, label);
    }
    if (invitesRose || messagesRose) {
      assert.ok(canAct(state), `${label}: a rise while it cannot act`);
      assert.ok(before.rampUpdatedOn !== null, `${label}: a rise before the ramp's first day`);
      if (lastRise !== undefined) {
        assert.ok(lastRise <= quotaDayBefore(today, RAMP_EVERY_DAYS), `${label}: two rises`);
      }
      lastRise = today;
      counts.rises += 1;
    }
    for (const [rose, type] of [
      [invitesRose, "invite"],
      [messagesRose, "message"],
    ] as const) {
      if (!rose || before.rampUpdatedOn === null) continue;
      const sent = await sentSince(id, before.rampUpdatedOn, today, type);
      assert.ok(sent, `${label}: a ${type} rise with no ${type} committed since the last step`);
    }
    if (lowered) {
      assert.ok(
        !(await sentBefore(id, today)),
        `${label}: a fall with a send in the 14 days before`,
      );
      assert.deepEqual(
        [after.inviteTarget, after.messageTarget],
        [
          Math.min(before.inviteTarget, RESTART.invites),
          Math.min(before.messageTarget, RESTART.messages),
        ],
        `${label}: the restart's targets`,
      );
      counts.restarts += 1;
    }
    // The day's sends, after its runs: none on a fifth of the days, and none from day 5 to day 29
    // of an even seed, so that the account idles past the 14 quota days too.
    const idle = s.int(5) === 0 || (seed % 2 === 0 && n >= IDLE_FROM && n < IDLE_UNTIL);
    if (!idle) {
      const day = { quotaDay: today, timeZone };
      await commit(workspaceId, id, day, s.int(3), s.int(4));
    }
  }
  return counts;
}

test("seeded sequences of quota days, sends, switch states, statuses, health states and repeated runs: the targets stay within 5 to 15 and 10 to 40, nothing rises while the account cannot act and a change then is a fall, a target rises only with a send of its type since the last step and never twice within 2 quota days, falls only after 14 quota days without a send and to 7 and 20 at most, and a repeat the same day changes nothing", async () => {
  const totals = { rises: 0, restarts: 0 };
  for (const seed of SEEDS) {
    const counts = await sequence(seed);
    totals.rises += counts.rises;
    totals.restarts += counts.restarts;
  }
  // The sequences reach both kinds of change, so the checks above ran on rises and on restarts.
  assert.ok(totals.rises >= SEEDS.length, `rises: ${totals.rises}`);
  assert.ok(totals.restarts >= 1, `restarts: ${totals.restarts}`);
});

test("an account connected for 20 quota days while sending was closed, a send counted on each, opens at 5 and 10: on the day sending opens, its targets and the limits that day draws are 5 and 10", async () => {
  const { id, workspaceId } = await account();
  for (let n = 0; n < 20; n += 1) {
    const at = new Date(FIRST_RUN + n * DAY_MS);
    assert.equal(await inRun(workspaceId, () => rampAccount(id, at)), null, `day ${n}`);
    await commit(workspaceId, id, { quotaDay: quotaDay(at, "UTC"), timeZone: "UTC" }, 1, 1);
  }
  const closed = await readAccount(id);
  assert.deepEqual(
    [closed.inviteTarget, closed.messageTarget, closed.rampUpdatedOn],
    [5, 10, null],
  );

  // Sunday 22 November: the operator opens sending; Monday's run, then Monday's first sends.
  await setPlatformControls({ sendingOpen: true });
  const monday = new Date(FIRST_RUN + 21 * DAY_MS);
  const opened = await inRun(workspaceId, () => rampAccount(id, monday));
  assert.deepEqual(opened, { inviteTarget: 5, messageTarget: 10, rampUpdatedOn: "2026-11-23" });
  useClock(() => monday);
  useRandom(() => 0.999); // the top of the draw: the targets themselves
  try {
    const left = await inRun(workspaceId, () => remainingToday(id));
    assert.deepEqual([left.invites, left.messages], [5, 10]);
  } finally {
    useClock(undefined);
    useRandom(undefined);
  }
});

test("ten runs racing on one account due a step, each on its own connection: one step", async () => {
  const { id, workspaceId } = await account();
  await setPlatformControls({ sendingOpen: true });
  const at = new Date(FIRST_RUN);
  const today = quotaDay(at, "UTC");
  await app.senderAccount.update({
    where: { id },
    data: { rampUpdatedOn: quotaDayBefore(today, RAMP_EVERY_DAYS) },
  });
  const yesterday = { quotaDay: quotaDayBefore(today, 1), timeZone: "UTC" };
  await commit(workspaceId, id, yesterday, 1, 1);
  const clients = Array.from({ length: 10 }, () => createDbClient("app", { schema: db.schema }));
  try {
    const answers = await Promise.all(
      clients.map((client) => inRun(workspaceId, () => rampAccount(id, at), client)),
    );
    const step = { inviteTarget: 7, messageTarget: 15, rampUpdatedOn: today };
    assert.deepEqual(
      answers.filter((answer) => answer !== null),
      [step],
    );
    assert.deepEqual(await readAccount(id), step);
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
});
