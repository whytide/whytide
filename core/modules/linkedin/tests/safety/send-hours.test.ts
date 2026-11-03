// The safety cases of the send hours (beta-p1-030; docs/security.md "Budgets"), run by
// `pnpm -F @whytide/linkedin test:safety` and not by `test`: no send on Saturday or Sunday in the
// account's zone, whatever days it lists, while a read that day is reserved; retry_at holds sends and
// reads; and a time-zone change in the middle of a day opens no second day's budgets, east or west,
// nor does a day's row the previous release inserts without its zone.
import assert from "node:assert/strict";
import test from "node:test";
import { tenantClient } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { updateSettings } from "../../domain/accounts.ts";
import { readUsage, remainingToday } from "../../domain/quota/reservations.ts";
import { ids } from "../../ids.ts";
import { useClock, useLinkedinClient, useRandom } from "../../testing/index.ts";
import { ALWAYS, granted, sender, THURSDAY } from "../fixtures/send.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
let at = THURSDAY;
useClock(() => at);
useRandom(() => 0.999); // the day's limits are the targets: 5 connection requests, 10 messages

test("an account whose working days include Saturday is refused a send that Saturday, outside_working_hours with Monday's window start, and logged; a read is reserved; remainingToday answers no send; an account of the weekend alone is refused with no time", async () => {
  const hours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5, 6] };
  const angeles = await sender("America/Los_Angeles", hours);
  at = new Date("2026-10-24T17:00:00Z"); // Saturday 10:00 in Los Angeles
  const monday = new Date("2026-10-26T15:30:00Z"); // Monday 08:30 in Los Angeles
  const refused = { refused: "outside_working_hours", retryAt: monday };
  assert.deepEqual(await angeles.send("key-saturday"), refused);
  granted(await angeles.read());
  const none = { invites: 0, messages: 0, withdrawals: 0, actions: 0, windowEnd: null };
  assert.deepEqual(await angeles.run(() => remainingToday(angeles.id)), none);
  const rows = await app.senderActionLog.findMany({
    where: { senderAccountId: angeles.id },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(
    rows.map(({ kind, count, outcome }) => [kind, count, outcome]),
    [
      ["invite", 1, "outside_working_hours"],
      ["send_check", 1, "reserved"],
    ],
  );

  const weekend = await sender("UTC", { ...ALWAYS, days: [6, 7] });
  const never = { refused: "outside_working_hours", retryAt: null };
  assert.deepEqual(await weekend.send("key-weekend", "message"), never);
});

test("while retry_at lies ahead, sends and reads are refused rate_limited with that time, even outside the hours; from it, they reserve again", async () => {
  const hours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
  const account = await sender("UTC", hours);
  at = new Date("2026-10-22T07:00:00Z"); // Thursday, before the window
  const retryAt = new Date("2026-10-22T09:00:00Z");
  await app.senderAccount.update({ where: { id: account.id }, data: { retryAt } });
  assert.deepEqual(await account.send("key-paused"), { refused: "rate_limited", retryAt });
  assert.deepEqual(await account.read(), { refused: "rate_limited", retryAt });
  at = retryAt;
  granted(await account.send("key-paused"));
  granted(await account.read());
});

test("a zone moved east in the middle of a day opens no second day: the reservations, remainingToday and the usage keep the day's row until it ends in its own zone, then the new zone's day begins", async () => {
  const account = await sender("UTC");
  at = new Date("2026-10-22T20:00:00Z"); // Thursday 20:00 in UTC
  for (let i = 0; i < 5; i++) granted(await account.send(`key-east-${i}`));
  const midnight = new Date("2026-10-23T00:00:00Z");
  const full = { refused: "invite_cap_reached", retryAt: midnight };
  assert.deepEqual(await account.send("key-east-5"), full);
  // Friday 10:00 in Kiritimati, UTC+14: a fresh date there.
  await account.run(() => updateSettings(account.id, { timeZone: "Pacific/Kiritimati" }));
  assert.deepEqual(await account.send("key-east-5"), full);
  assert.equal((await account.run(() => remainingToday(account.id))).invites, 0);
  assert.equal((await account.run(() => readUsage(account.id))).quotaDay, "2026-10-22");
  at = midnight; // Friday 14:00 in Kiritimati
  granted(await account.send("key-east-5"));
  assert.deepEqual(
    (await account.days()).map((day) => [day.quotaDay, day.timeZone, day.invitesReserved]),
    [
      ["2026-10-22", "UTC", 5],
      ["2026-10-23", "Pacific/Kiritimati", 1],
    ],
  );
});

test("a zone moved west in the middle of a day goes back to no earlier date: the day's row lasts until its date is over in the new zone too", async () => {
  const account = await sender("UTC");
  at = new Date("2026-10-23T00:30:00Z"); // Friday 00:30 in UTC
  for (let i = 0; i < 5; i++) granted(await account.send(`key-west-${i}`));
  // Thursday 17:30 in Los Angeles, whose Friday ends at Saturday 07:00 UTC.
  await account.run(() => updateSettings(account.id, { timeZone: "America/Los_Angeles" }));
  const ends = new Date("2026-10-24T07:00:00Z");
  const full = { refused: "invite_cap_reached", retryAt: ends };
  assert.deepEqual(await account.send("key-west-5"), full);
  assert.deepEqual(
    (await account.days()).map((day) => [day.quotaDay, day.timeZone, day.invitesReserved]),
    [["2026-10-23", "UTC", 5]],
  );
});

test("a day's row inserted without its zone, as the previous release does while an upgrade runs, takes the account's zone", async () => {
  const account = await sender("Europe/Paris");
  const id = newId(ids.sender_quota_usage);
  await account.run(
    () => tenantClient.$executeRaw`
      INSERT INTO sender_quota_usage (id, workspace_id, sender_account_id, quota_day)
      VALUES (${id}, ${account.workspaceId}, ${account.id}, '2026-10-22')`,
  );
  const days = await account.days();
  assert.deepEqual(
    days.map((day) => [day.id, day.timeZone]),
    [[id, "Europe/Paris"]],
  );
});
