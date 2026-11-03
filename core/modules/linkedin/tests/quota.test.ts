// The read quota and the action log end to end (alpha-p7-040, acceptance criteria 1 to 5; README.md
// "Read quota"), in this file's schema of the worktree's database, each call in a tenant run as
// `app`, on a clock the test sets: the cap with release, commit and the hour's sweep; a raised cap on
// the same day (fix-read-cap, criterion 4); the quota day in two time zones; the working hours; twenty
// reservations on twenty connections; the log's rows.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createDbClient, type PrismaClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { recordedMetrics, servicePrincipal } from "@whytide/platform";
import { updateSettings } from "../domain/accounts.ts";
import { logAction } from "../domain/action-log/log.ts";
import {
  commitReads,
  RESERVATION_MS,
  type Refusal,
  type Reservation,
  releaseReads,
  reserveReads,
} from "../domain/quota/reservations.ts";
import type { WorkingHours } from "../domain/working-hours.ts";
import { createConnectedAccount, useClock, useLinkedinClient } from "../testing/index.ts";

const db = withTestDb();
const app = asRole("app");
useLinkedinClient(app);
const principal = servicePrincipal("linkedin_test");
let at = new Date();
useClock(() => at);
const OFFICE: WorkingHours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
const ALWAYS: WorkingHours = { start: "00:00", end: "23:59", days: [1, 2, 3, 4, 5, 6, 7] };
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000";

/** A workspace of its own, its connected account in the zone and hours, and a run in it. */
async function account(timeZone: string, workingHours: WorkingHours) {
  const workspaceId = `wsp_test${randomBytes(6).toString("hex")}`;
  const { id } = await createConnectedAccount(workspaceId, { timeZone, workingHours });
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

test("a cap raised from 100 to 150 holds from the next reservation: the read it refused is granted on the same quota day", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
  granted(await paris.reserve(100));
  const midnight = "2026-10-22T22:00:00.000Z"; // Friday 00:00 in Paris
  assert.deepEqual(await paris.reserve(1), refusal("read_cap_reached", midnight));
  await paris.run(() => updateSettings(paris.id, { dailyReadCap: 150 }));
  granted(await paris.reserve(1));
  assert.deepEqual(await days(paris.id), [["2026-10-22", 101, 0]]);
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

test("every reservation and every read writes one action-log row with its count and outcome; never a profile's URL", async () => {
  const paris = await account("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T10:00:00Z");
  const reserved = await paris.run(() =>
    reserveReads({ accountId: paris.id, count: 2, kind: "read_engagers", objectRef: POST }),
  );
  granted(reserved);
  const person = "per_01JABCDEFGHJKMNPQRSTVWXYZ0";
  const read = (kind: "read_engagers" | "read_profile", objectRef: string, outcome: string) =>
    paris.run(() => logAction({ accountId: paris.id, kind, objectRef, count: 1, outcome }));
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
  const labels = recordedMetrics().get("linkedin.actions") ?? [];
  assert.ok(labels.some((set) => set.kind === "read_engagers" && set.outcome === "ok"));
});
