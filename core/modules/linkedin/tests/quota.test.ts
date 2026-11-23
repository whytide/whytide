// The read quota, the day's budgets and the action log end to end (alpha-p7-040; beta-p1-020,
// acceptance criteria 3, 4 and 8 to 10; README.md "Budgets"), in this file's schema of the worktree's
// database, each call in a tenant run as `app`, on a clock and a random source the test sets: the cap
// with release, commit and the hour's sweep; the smaller of the day's read allowance and the cap, a
// lowered cap at once and a raised one the next quota day; the quota day in two time zones, and west
// of UTC across daylight saving; the working hours; twenty reservations on twenty connections; the
// 200; one draw a day; remainingToday and the week's 100; senderOf; the log's rows. A page of posts
// (`read_posts`), the reads `keep` leaves, alone and at once on fifteen connections, and
// readsLeftToday (gamma-p5-015).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createDbClient, type PrismaClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, recordedMetrics, servicePrincipal } from "@whytide/platform";
import { senderOf, updateSettings } from "../domain/accounts.ts";
import { logAction } from "../domain/action-log/log.ts";
import { RESERVATION_MS } from "../domain/quota/constants.ts";
import {
  commitReads,
  type Refusal,
  type Reservation,
  readsLeftToday,
  readUsage,
  releaseReads,
  remainingToday,
  reserveReads,
} from "../domain/quota/reservations.ts";
import type { WorkingHours } from "../domain/working-hours.ts";
import { ids } from "../ids.ts";
import type { ActionOutcome } from "../schemas/quota.ts";
import {
  createConnectedAccount,
  openSending,
  setAccountPaused,
  setHealth,
  setPlatformControls,
  setWorkspaceStopped,
  useClock,
  useLinkedinClient,
  useRandom,
} from "../testing/index.ts";

const db = withTestDb();
const app = asRole("app");
useLinkedinClient(app);
const principal = servicePrincipal("linkedin_test");
let at = new Date();
useClock(() => at);
/** Every draw at the top of its range: the limits are the targets, 5 and 10 by default. */
const TOP = 0.999;
useRandom(() => TOP);
const OFFICE: WorkingHours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
const ALWAYS: WorkingHours = { start: "00:00", end: "23:59", days: [1, 2, 3, 4, 5, 6, 7] };
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000";

/** A workspace of its own, its connected account in the zone and hours, and a run in it; sending open. */
async function account(timeZone: string, workingHours: WorkingHours, ownerUserId?: string) {
  const workspaceId = `wsp_test${randomBytes(6).toString("hex")}`;
  const { id } = await createConnectedAccount(workspaceId, { timeZone, workingHours, ownerUserId });
  await openSending();
  const run = <T>(fn: () => Promise<T>, client: PrismaClient = app) =>
    withTenant({ workspaceId, principal }, fn, { client, timeout: 30_000 });
  const reserve = (count: number, client?: PrismaClient) =>
    run(() => reserveReads({ accountId: id, count, kind: "read_profile" }), client);
  return { id, workspaceId, run, reserve };
}

function granted(answer: Reservation | Refusal): string {
  assert.ok("reservationId" in answer, `refused: ${JSON.stringify(answer)}`);
  return answer.reservationId;
}

const refusal = (refused: Refusal["refused"], retryAt: string) => ({
  refused,
  retryAt: new Date(retryAt),
});

const days = async (accountId: string) =>
  (await app.senderQuotaUsage.findMany({ where: { senderAccountId: accountId } }))
    .map(({ quotaDay, readsReserved, readsCommitted }) => [quotaDay, readsReserved, readsCommitted])
    .sort();

/** A read of `count` pages of posts for the account, keeping `keep`, in its run. */
const posts = (
  owner: Awaited<ReturnType<typeof account>>,
  options: { count?: number; keep?: number } = {},
  client?: PrismaClient,
) => {
  const { count = 1, keep } = options;
  const input = { accountId: owner.id, count, kind: "read_posts", keep } as const;
  return owner.run(() => reserveReads(input), client);
};

/** The account's row of the quota day, its counters set as the sends of the day left them. */
async function sendsOn(accountId: string, quotaDay: string, counted: Record<string, number>) {
  const row = await app.senderQuotaUsage.findFirstOrThrow({
    where: { senderAccountId: accountId, quotaDay },
  });
  await app.senderQuotaUsage.update({ where: { id: row.id }, data: counted });
}

test("cap 100: three reservations of thirty succeed, a fourth answers read_cap_reached with the next day's start, and succeeds once one is released; a commit answers as the first; an hour on, the sweep frees the rest", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
  const [first, second] = [granted(await paris.reserve(30)), granted(await paris.reserve(30))];
  granted(await paris.reserve(30));
  const midnight = "2026-10-22T22:00:00.000Z"; // Friday 00:00 in Paris
  assert.deepEqual(await paris.reserve(30), refusal("read_cap_reached", midnight));

  await paris.run(() => releaseReads(first));
  await paris.run(() => releaseReads(first));
  granted(await paris.reserve(30));
  const committed = { reservationId: second, committed: 25 };
  assert.deepEqual(await paris.run(() => commitReads(second, 25)), committed);
  assert.deepEqual(await paris.run(() => commitReads(second, 10)), committed);
  await assert.rejects(
    paris.run(() => releaseReads(second)),
    { code: "reservation_not_open" },
  );
  assert.deepEqual(await days(paris.id), [["2026-10-22", 60, 25]]);

  at = new Date(at.getTime() + RESERVATION_MS);
  granted(await paris.reserve(75));
  assert.deepEqual(await days(paris.id), [["2026-10-22", 75, 25]]);
});

test("the smaller of the day's read allowance and the cap: a cap lowered from 100 to 40 holds from the next reservation, raised back to 100 the same day too; a day begun at 40 keeps its allowance of 40 though the cap is raised, and reads 100 the next day", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
  granted(await paris.reserve(30));
  await paris.run(() => updateSettings(paris.id, { dailyReadCap: 40 }));
  const midnight = "2026-10-22T22:00:00.000Z"; // Friday 00:00 in Paris
  assert.deepEqual(await paris.reserve(20), refusal("read_cap_reached", midnight));
  granted(await paris.reserve(10));
  await paris.run(() => updateSettings(paris.id, { dailyReadCap: 100 }));
  granted(await paris.reserve(20));
  assert.deepEqual(await days(paris.id), [["2026-10-22", 60, 0]]);

  const narrow = await account("Europe/Paris", OFFICE);
  await narrow.run(() => updateSettings(narrow.id, { dailyReadCap: 40 }));
  granted(await narrow.reserve(40));
  await narrow.run(() => updateSettings(narrow.id, { dailyReadCap: 100 }));
  assert.deepEqual(await narrow.reserve(1), refusal("read_cap_reached", midnight));
  assert.equal((await narrow.run(() => readUsage(narrow.id))).readAllowance, 40);
  at = new Date("2026-10-23T10:00:00Z"); // Friday 12:00 in Paris
  granted(await narrow.reserve(100));
  assert.deepEqual(await days(narrow.id), [
    ["2026-10-22", 40, 0],
    ["2026-10-23", 100, 0],
  ]);
});

test("an account in Pacific/Auckland and one in America/Los_Angeles: the same instant in different quota days, counters apart; the day rolls over at local midnight", async () => {
  const auckland = await account("Pacific/Auckland", ALWAYS);
  const angeles = await account("America/Los_Angeles", ALWAYS);
  at = new Date("2026-10-22T17:00:00Z"); // Friday 06:00 in Auckland, Thursday 10:00 in Los Angeles
  const read = granted(await auckland.reserve(60));
  granted(await angeles.reserve(60));
  await auckland.run(() => commitReads(read, 60));
  assert.deepEqual(await days(auckland.id), [["2026-10-23", 0, 60]]);
  assert.deepEqual(await days(angeles.id), [["2026-10-22", 60, 0]]);

  at = new Date("2026-10-23T10:58:00Z"); // Friday 23:58 in Auckland
  const midnight = "2026-10-23T11:00:00.000Z";
  assert.deepEqual(await auckland.reserve(50), refusal("read_cap_reached", midnight));
  at = new Date(midnight);
  granted(await auckland.reserve(50));
  assert.deepEqual(await days(auckland.id), [
    ["2026-10-23", 0, 60],
    ["2026-10-24", 50, 0],
  ]);
  assert.deepEqual(await days(angeles.id), [["2026-10-22", 60, 0]]);
});

test("working hours 08:30 to 18:00: at 19:00 local, outside_working_hours with 08:30 the next working day; on Saturday, Monday 08:30", async () => {
  const angeles = await account("America/Los_Angeles", OFFICE);
  at = new Date("2026-10-23T02:00:00Z"); // Thursday 19:00 in Los Angeles
  const friday = "2026-10-23T15:30:00.000Z";
  assert.deepEqual(await angeles.reserve(1), refusal("outside_working_hours", friday));
  at = new Date("2026-10-24T17:00:00Z"); // Saturday 10:00
  const monday = "2026-10-26T15:30:00.000Z";
  assert.deepEqual(await angeles.reserve(1), refusal("outside_working_hours", monday));
  assert.deepEqual(await days(angeles.id), []);
});

test("west of UTC across daylight saving: a window start that the spring-forward skips opens an hour later, never before the change; a quota day whose midnight is skipped starts at 01:00, never on the day before", async () => {
  const early: WorkingHours = { start: "02:30", end: "18:00", days: [1, 2, 3, 4, 5, 6, 7] };
  const angeles = await account("America/Los_Angeles", early);
  at = new Date("2026-03-08T08:00:00Z"); // Sunday 00:00 PST; 02:00 becomes 03:00 PDT
  const opens = "2026-03-08T10:30:00.000Z"; // 03:30 PDT, not 01:30 PST
  assert.deepEqual(await angeles.reserve(1), refusal("outside_working_hours", opens));

  const santiago = await account("America/Santiago", ALWAYS);
  at = new Date("2026-09-05T20:00:00Z"); // Saturday 16:00 at -04; Sunday's 00:00 is skipped
  granted(await santiago.reserve(100));
  const sunday = "2026-09-06T04:00:00.000Z"; // Sunday 01:00 at -03
  assert.deepEqual(await santiago.reserve(1), refusal("read_cap_reached", sunday));
  at = new Date(sunday);
  granted(await santiago.reserve(1));
  assert.deepEqual(await days(santiago.id), [
    ["2026-09-05", 100, 0],
    ["2026-09-06", 1, 0],
  ]);
});

test("twenty reservations of ten at once, on twenty connections, against a cap of 100: exactly ten granted", async () => {
  const london = await account("Europe/London", ALWAYS);
  at = new Date("2026-10-22T12:00:00Z");
  const clients = Array.from({ length: 20 }, () => createDbClient("app", { schema: db.schema }));
  try {
    const answers = await Promise.all(clients.map((client) => london.reserve(10, client)));
    const outcomes = answers.map((answer) => ("refused" in answer ? answer.refused : "granted"));
    assert.deepEqual(outcomes.sort(), [
      ...Array(10).fill("granted"),
      ...Array(10).fill("read_cap_reached"),
    ]);
    assert.deepEqual(await days(london.id), [["2026-10-22", 100, 0]]);
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
});

test("the 200: with 195 actions of sends counted today, a reservation of 10 reads answers daily_actions_cap_reached with the next quota day's start, though 100 reads are left; 5 are granted, and remainingToday then answers no send", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
  await paris.run(() => remainingToday(paris.id));
  const counted = { invitesCommitted: 60, messagesCommitted: 120, withdrawalsCommitted: 15 };
  await sendsOn(paris.id, "2026-10-22", counted);
  const midnight = "2026-10-22T22:00:00.000Z"; // Friday 00:00 in Paris
  assert.deepEqual(await paris.reserve(10), refusal("daily_actions_cap_reached", midnight));
  granted(await paris.reserve(5));
  const none = {
    invites: 0,
    messages: 0,
    withdrawals: 0,
    actions: 0,
    windowEnd: new Date("2026-10-22T16:00:00Z"),
  };
  assert.deepEqual(await paris.run(() => remainingToday(paris.id)), none);
  const usage = await paris.run(() => readUsage(paris.id));
  assert.deepEqual(
    [usage.actions, usage.reserved, usage.readAllowance],
    [{ used: 200, max: 200 }, 5, 100],
  );
  const outcomes = await app.senderActionLog.findMany({
    where: { senderAccountId: paris.id },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(
    outcomes.map(({ count, outcome }) => [count, outcome]),
    [
      [10, "daily_actions_cap_reached"],
      [5, "reserved"],
    ],
  );
});

test("one draw a day: the reservation that makes the day's row draws its limits, three numbers; a second reservation, remainingToday and the usage read the same limits and draw none; the next day draws again", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  await app.senderAccount.update({
    where: { id: paris.id },
    data: { inviteTarget: 15, messageTarget: 40 },
  });
  const sources = [0, TOP, 0.5, TOP, 0, 0.5];
  let drawn = 0;
  useRandom(() => sources[drawn++ % sources.length] ?? 0);
  try {
    at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
    granted(await paris.reserve(1));
    assert.equal(drawn, 3);
    granted(await paris.reserve(1));
    const left = await paris.run(() => remainingToday(paris.id));
    const usage = await paris.run(() => readUsage(paris.id));
    assert.equal(drawn, 3);
    // 15 at 0: 12; 40 at 0.999: 32 + 8 = 40.
    assert.deepEqual([left.invites, left.messages], [12, 40]);
    assert.deepEqual(
      [usage.invites, usage.messages],
      [
        { used: 0, limit: 12 },
        { used: 0, limit: 40 },
      ],
    );
    const [row] = await app.senderQuotaUsage.findMany({ where: { senderAccountId: paris.id } });
    assert.deepEqual([row?.inviteLimit, row?.messageLimit, row?.readAllowance], [12, 40, 100]);
    // The check's instant, at 0.5 of the first two hours left of the window: 12:00 to 14:00 in Paris.
    assert.equal(row?.checkAfter?.toISOString(), "2026-10-22T11:00:00.000Z");

    at = new Date("2026-10-23T10:00:00Z"); // Friday 12:00 in Paris
    await paris.run(() => remainingToday(paris.id));
    assert.equal(drawn, 6);
    const friday = await paris.run(() => readUsage(paris.id));
    // 15 at 0.999: 12 + 3 = 15; 40 at 0: 32.
    assert.deepEqual([friday.invites.limit, friday.messages.limit], [15, 32]);
  } finally {
    useRandom(() => TOP);
  }
});

test("remainingToday: the day's limits less what is reserved and made, and the window's end; the week's 100 over the six quota days before, the seventh not counted, leaves 2 of a limit of 5; outside the window, no end", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
  const end = new Date("2026-10-22T16:00:00Z"); // 18:00 in Paris
  const remaining = () => paris.run(() => remainingToday(paris.id));
  assert.deepEqual(await remaining(), {
    invites: 5,
    messages: 10,
    withdrawals: 15,
    actions: 200,
    windowEnd: end,
  });
  await sendsOn(paris.id, "2026-10-22", {
    invitesReserved: 1,
    invitesCommitted: 2,
    messagesCommitted: 4,
    withdrawalsReserved: 3,
  });
  // 10 actions counted of the 200.
  const after = { invites: 2, messages: 6, withdrawals: 12, actions: 190, windowEnd: end };
  assert.deepEqual(await remaining(), after);

  const week = await account("Europe/Paris", OFFICE);
  const before = [
    ["2026-10-15", 50], // seven quota days before: outside the week
    ["2026-10-16", 20],
    ["2026-10-17", 18],
    ["2026-10-19", 20],
    ["2026-10-20", 20],
    ["2026-10-21", 20],
  ] as const;
  for (const [quotaDay, invitesCommitted] of before) {
    await app.senderQuotaUsage.create({
      data: {
        id: newId(ids.sender_quota_usage),
        workspaceId: week.workspaceId,
        senderAccountId: week.id,
        quotaDay,
        timeZone: "Europe/Paris",
        invitesCommitted,
      },
    });
  }
  const thisWeek = () => week.run(() => remainingToday(week.id));
  // The six days' connection requests bound the week's, never today's 200.
  const fresh = { invites: 2, messages: 10, withdrawals: 15, actions: 200, windowEnd: end };
  assert.deepEqual(await thisWeek(), fresh);
  await sendsOn(week.id, "2026-10-22", { invitesReserved: 1 });
  assert.equal((await thisWeek()).invites, 1);
  const usage = await week.run(() => readUsage(week.id));
  assert.deepEqual(
    [usage.invites, usage.weekInvites],
    [
      { used: 1, limit: 5 },
      { used: 99, cap: 100 },
    ],
  );

  at = new Date("2026-10-22T17:00:00Z"); // 19:00 in Paris
  assert.equal((await remaining()).windowEnd, null);
});

test("senderOf: the user's connected account in the run's workspace; null for a pending or disconnected account, another user's account, or another workspace", async () => {
  const mine = await account("Europe/Paris", OFFICE, "usr_sender_mine");
  const inWorkspace = (userId: string) => mine.run(() => senderOf(userId));
  assert.equal((await inWorkspace("usr_sender_mine"))?.id, mine.id);
  assert.equal(await inWorkspace("usr_sender_other"), null);
  for (const status of ["pending", "disconnected"] as const) {
    await app.senderAccount.update({ where: { id: mine.id }, data: { status } });
    assert.equal(await inWorkspace("usr_sender_mine"), null, status);
  }
  const elsewhere = await account("Europe/Paris", OFFICE, "usr_sender_elsewhere");
  assert.equal(await mine.run(() => senderOf("usr_sender_elsewhere")), null);
  assert.equal((await elsewhere.run(() => senderOf("usr_sender_elsewhere")))?.id, elsewhere.id);
});

test("every reservation and every read writes one action-log row with its count and outcome; never a profile's URL", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z");
  const reserved = await paris.run(() =>
    reserveReads({ accountId: paris.id, count: 2, kind: "read_engagers", objectRef: POST }),
  );
  granted(reserved);
  const person = "per_01JABCDEFGHJKMNPQRSTVWXYZ0";
  const read = (
    kind: "read_engagers" | "read_profile",
    objectRef: string,
    outcome: ActionOutcome,
  ) => paris.run(() => logAction({ accountId: paris.id, kind, objectRef, count: 1, outcome }));
  await read("read_engagers", POST, "ok");
  await read("read_profile", person, "linkedin_rate_limited");
  at = new Date("2026-10-22T17:00:00Z"); // 19:00 in Paris
  await paris.reserve(1);
  await assert.rejects(read("read_profile", "https://www.linkedin.com/in/someone", "ok"), {
    code: "read_input_invalid",
    details: { fields: ["objectRef"] },
  });

  const rows = await app.senderActionLog.findMany({
    where: { senderAccountId: paris.id },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(
    rows.map(({ kind, objectRef, count, outcome }) => [kind, objectRef, count, outcome]),
    [
      ["read_engagers", POST, 2, "reserved"],
      ["read_engagers", POST, 1, "ok"],
      ["read_profile", person, 1, "linkedin_rate_limited"],
      ["read_profile", null, 1, "outside_working_hours"],
    ],
  );
  // The rows count in the table only: linkedin's activities add the metric after their run.
  assert.equal(recordedMetrics().get("linkedin.actions"), undefined);
});

test("read_posts: a page counts one read of the day, its row with no object; past the cap read_cap_reached and past the 200 daily_actions_cap_reached, each with the next quota day's start; outside the hours outside_working_hours with the next window's", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
  granted(await posts(paris));
  assert.deepEqual(await days(paris.id), [["2026-10-22", 1, 0]]);
  granted(await paris.reserve(99));
  const midnight = "2026-10-22T22:00:00.000Z"; // Friday 00:00 in Paris
  assert.deepEqual(await posts(paris), refusal("read_cap_reached", midnight));
  at = new Date("2026-10-22T17:00:00Z"); // 19:00 in Paris
  const friday = "2026-10-23T06:30:00.000Z"; // Friday 08:30 in Paris
  assert.deepEqual(await posts(paris), refusal("outside_working_hours", friday));
  const rows = await app.senderActionLog.findMany({
    where: { senderAccountId: paris.id, kind: "read_posts" },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(
    rows.map(({ objectRef, count, outcome }) => [objectRef, count, outcome]),
    [
      [null, 1, "reserved"],
      [null, 1, "read_cap_reached"],
      [null, 1, "outside_working_hours"],
    ],
  );

  const busy = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z");
  await busy.run(() => remainingToday(busy.id));
  const counted = { invitesCommitted: 60, messagesCommitted: 120, withdrawalsCommitted: 15 };
  await sendsOn(busy.id, "2026-10-22", { ...counted, readsCommitted: 5 });
  assert.deepEqual(await posts(busy), refusal("daily_actions_cap_reached", midnight));
});

test("read_posts under each kill switch, the account not connected, its health's pause and its retry_at: refused with the code, no read counted, and readsLeftToday answers 0; lifted, the page is granted", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
  const retryAt = new Date("2026-10-22T11:00:00Z");
  const status = (value: "connected" | "disconnected") => () =>
    app.senderAccount.update({ where: { id: paris.id }, data: { status: value } });
  const retry = (value: Date | null) => () =>
    app.senderAccount.update({ where: { id: paris.id }, data: { retryAt: value } });
  const pausedUntil = new Date("2026-10-23T10:00:00Z");
  const platform = (stopped: boolean) => () => setPlatformControls({ stopped });
  const workspace = (on: boolean) => () =>
    setWorkspaceStopped(paris.workspaceId, on ? "operator" : null);
  const stop = (on: boolean) => () => setAccountPaused(paris.id, on ? "tester" : null);
  const health = (on: boolean) => () =>
    on ? setHealth(paris.id, "restricted", { pausedUntil }) : setHealth(paris.id, "healthy");
  const holds = [
    ["platform_stopped", null, platform(true), platform(false)],
    ["workspace_stopped", null, workspace(true), workspace(false)],
    ["account_stopped", null, stop(true), stop(false)],
    ["linkedin_account_disconnected", null, status("disconnected"), status("connected")],
    ["account_paused", null, health(true), health(false)],
    ["rate_limited", retryAt, retry(retryAt), retry(null)],
  ] as const;
  for (const [refused, retryAtOf, on, off] of holds) {
    await on();
    assert.deepEqual(await posts(paris), { refused, retryAt: retryAtOf }, refused);
    assert.equal((await paris.run(() => readsLeftToday(paris.id))).left, 0, refused);
    await off();
  }
  assert.deepEqual(await days(paris.id), [["2026-10-22", 0, 0]]);
  granted(await posts(paris));
  assert.deepEqual(await days(paris.id), [["2026-10-22", 1, 0]]);
});

test("keep: with 25 reads left, a page of 5 keeping 20 is granted, and the next of 1 is refused read_cap_reached with the next window's start; without keep it is granted; keep counts the 200 too", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
  granted(await paris.reserve(75));
  granted(await posts(paris, { count: 5, keep: 20 }));
  const friday = "2026-10-23T06:30:00.000Z"; // Friday 08:30 in Paris, the next window's start
  assert.deepEqual(await posts(paris, { keep: 20 }), refusal("read_cap_reached", friday));
  granted(await posts(paris));
  assert.deepEqual(await days(paris.id), [["2026-10-22", 81, 0]]);

  // 100 reads left by the budget, 6 by the 200: keeping 6, no read is left to take.
  const busy = await account("Europe/Paris", OFFICE);
  await busy.run(() => remainingToday(busy.id));
  const counted = { invitesCommitted: 60, messagesCommitted: 119, withdrawalsCommitted: 15 };
  await sendsOn(busy.id, "2026-10-22", counted);
  assert.deepEqual(await posts(busy, { keep: 6 }), refusal("read_cap_reached", friday));
  granted(await posts(busy, { keep: 5 }));
});

test("keep at once: fifteen pages keeping 20, on fifteen connections, with 30 reads left: exactly ten granted, and 20 left", async () => {
  const london = await account("Europe/London", ALWAYS);
  at = new Date("2026-10-22T12:00:00Z");
  granted(await london.reserve(70));
  const clients = Array.from({ length: 15 }, () => createDbClient("app", { schema: db.schema }));
  try {
    const answers = await Promise.all(clients.map((client) => posts(london, { keep: 20 }, client)));
    const outcomes = answers.map((answer) => ("refused" in answer ? answer.refused : "granted"));
    assert.deepEqual(outcomes.sort(), [
      ...Array(10).fill("granted"),
      ...Array(5).fill("read_cap_reached"),
    ]);
    assert.deepEqual(await days(london.id), [["2026-10-22", 80, 0]]);
    assert.equal((await london.run(() => readsLeftToday(london.id))).left, 20);
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
});

test("readsLeftToday: the usage route's read limit less its reserved and made reads, within the 200, as reserveReads grants them; outside the window the same reads, the window closed; it makes the day's row", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
  const left = () => paris.run(() => readsLeftToday(paris.id));
  const fromUsage = async () => {
    const usage = await paris.run(() => readUsage(paris.id));
    const reads = Math.min(usage.readAllowance, usage.cap) - usage.reserved - usage.committed;
    return Math.min(reads, usage.actions.max - usage.actions.used);
  };
  const friday = new Date("2026-10-23T06:30:00Z"); // Friday 08:30 in Paris
  const open = { quotaDay: "2026-10-22", left: 100, windowOpen: true, nextWindowAt: friday };
  assert.deepEqual(await left(), open);
  assert.deepEqual(await days(paris.id), [["2026-10-22", 0, 0]]);
  const read = granted(await paris.reserve(30));
  await paris.run(() => commitReads(read, 20));
  granted(await posts(paris));
  assert.deepEqual([(await left()).left, await fromUsage()], [79, 79]);
  await paris.run(() => updateSettings(paris.id, { dailyReadCap: 40 }));
  assert.deepEqual([(await left()).left, await fromUsage()], [19, 19]);
  await sendsOn(paris.id, "2026-10-22", { invitesCommitted: 60, messagesCommitted: 110 });
  assert.deepEqual([(await left()).left, await fromUsage()], [9, 9]);
  at = new Date("2026-10-22T17:00:00Z"); // 19:00 in Paris
  const closed = { quotaDay: "2026-10-22", left: 9, windowOpen: false, nextWindowAt: friday };
  assert.deepEqual(await left(), closed);
  at = new Date("2026-10-22T10:00:00Z");
  const midnight = "2026-10-22T22:00:00.000Z"; // Friday 00:00 in Paris
  assert.deepEqual(
    await posts(paris, { count: 10 }),
    refusal("daily_actions_cap_reached", midnight),
  );
  granted(await posts(paris, { count: 9 }));
  assert.equal((await left()).left, 0);
});
