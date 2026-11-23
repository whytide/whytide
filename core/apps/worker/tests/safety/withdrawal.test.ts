// Safety cases of the withdrawals (beta-p4-060; core/modules/campaigns/README.md "Withdrawals",
// docs/flows.md "The withdrawal"), on the LinkedIn fake, the slice's Temporal and a schema of its
// database (fixtures/campaigns-sender.ts, fixtures/campaigns-withdraw.ts). Each case asserts the
// fake's recorded withdrawals: a connection request 20 days old stays, one 21 days old is withdrawn
// once, a second run of the job and a second send included; at most 15 a day, the 16th the next
// working day; withdrawals in the 200; the same reservation's window, weekdays and kill switch; no
// approval and no credits; no withdrawal of an accepted request; and no new enrollment for 90 days,
// contacts' CONTACTS_RECENT_TOUCH_DAYS, whose default and value unset are 90 (env-settings-a).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { newId } from "@whytide/platform";
import {
  afterSend,
  app,
  contacts,
  DAY_MS,
  linkedin,
  now,
  OWNER,
  sender,
  slotsOf,
  stepOf,
  usagesOf,
  useSenderTests,
} from "../fixtures/campaigns-sender.ts";
import {
  endOf,
  invited,
  leadOf,
  moveTo,
  withdrawals,
  withdrawOf,
  withdrawRun,
} from "../fixtures/campaigns-withdraw.ts";

const built = (path: string) =>
  import(new URL(`../../../../modules/${path}`, import.meta.url).href);
const { enrollApproved } = await built("campaigns/dist/domain/enroll/enroll.js");
const { RECENT_TOUCH_DAYS } = await built("contacts/dist/domain/suppression/constants.js");
/** CONTACTS_RECENT_TOUCH_DAYS as contacts' build reads it with the variable unset, in a process of its own. */
function recentTouchDaysUnset(): number {
  const env = { ...process.env };
  delete env.CONTACTS_RECENT_TOUCH_DAYS;
  const href = new URL("../../../../modules/contacts/dist/settings.js", import.meta.url).href;
  const script = `const { touchSettings } = await import(${JSON.stringify(href)});
console.log(touchSettings.CONTACTS_RECENT_TOUCH_DAYS);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return Number(child.stdout);
}
const { remainingToday } = await built("linkedin/dist/index.js");

useSenderTests();
const waiting = (id: string) => stepOf(id).then((row) => [row.status, row.errorCode]);
const scheduledWithdrawal = async () =>
  app.stepExecution.findFirstOrThrow({ where: { stepKey: "withdraw", status: "scheduled" } });

test("a connection request 20 days old stays; one 21 days old is withdrawn once, a second run of the job and a second send making no second call", async () => {
  const s = await sender();
  const kept = await invited(s, "day-20", 20);
  const due = await invited(s, "day-21", 21);
  assert.deepEqual(await withdrawRun(s), { opened: 1 });
  assert.deepEqual(await withdrawRun(s), { opened: 0 });
  assert.deepEqual(await withdrawOf(kept.enrollmentId), []);

  assert.deepEqual(await s.plan(), { accounts: 1, placed: 1 });
  assert.deepEqual((await s.send()).result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(await withdrawRun(s), { opened: 0 });
  assert.deepEqual(await s.plan(), { accounts: 0, placed: 0 });
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });

  assert.equal(withdrawals().length, 1);
  const [step, ...more] = await withdrawOf(due.enrollmentId);
  assert.ok(step);
  assert.deepEqual(more, []);
  assert.equal(step.status, "succeeded");
  assert.deepEqual(await slotsOf(step.id), ["committed"]);
  assert.equal((await endOf(kept.enrollmentId)).enrollment[0], "active");
});

test("at most 15 withdrawals a day: with 16 due, 15 go out today and one the next working day; the 16th placed by hand today is refused at the reservation", async () => {
  const s = await sender();
  for (let n = 1; n <= 16; n += 1) await invited(s, `cap-${n}`, 21);
  assert.deepEqual(await withdrawRun(s), { opened: 16 });
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 15 });
  assert.deepEqual((await s.send()).result, { sent: 15, blocked: 0, refused: 0, end: "no_step" });
  assert.equal(withdrawals().length, 15);

  const left = await scheduledWithdrawal();
  await s.place(left.id, afterSend());
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 1, end: "no_step" });
  assert.deepEqual(await waiting(left.id), ["scheduled", "withdrawal_cap_reached"]);
  assert.equal(withdrawals().length, 15);

  // Friday, the next working day.
  moveTo(new Date("2026-10-23T10:00:00Z"));
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 1 });
  assert.equal((await s.send()).result.sent, 1);
  assert.equal(withdrawals().length, 16);
  assert.equal((await stepOf(left.id)).executedAt?.toISOString().slice(0, 10), "2026-10-23");
});

test("withdrawals count in the 200: with 198 of the day's actions used, two go out and the third is refused daily_actions_cap_reached at the reservation", async () => {
  const s = await sender();
  for (const slug of ["busy-1", "busy-2", "busy-3"]) await invited(s, slug, 21);
  assert.deepEqual(await withdrawRun(s), { opened: 3 });
  // The day's row as linkedin makes it, then 198 of its 200 actions used.
  await s.run(() => remainingToday(s.accountId));
  const where = { senderAccountId: s.accountId };
  assert.equal(
    (await app.senderQuotaUsage.updateMany({ where, data: { readsCommitted: 198 } })).count,
    1,
  );

  assert.deepEqual(await s.plan(), { accounts: 1, placed: 2 });
  assert.deepEqual((await s.send()).result, { sent: 2, blocked: 0, refused: 0, end: "no_step" });
  const left = await scheduledWithdrawal();
  await s.place(left.id, afterSend());
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 1, end: "no_step" });
  assert.deepEqual(await waiting(left.id), ["scheduled", "daily_actions_cap_reached"]);
  assert.equal(withdrawals().length, 2);
  const day = await app.senderQuotaUsage.findFirstOrThrow({ where });
  assert.equal(day.withdrawalsCommitted, 2);
});

test("a withdrawal goes out only inside the working window, on a weekday, never under a kill switch: the plan places none, and a time placed by hand is refused at the reservation", async () => {
  const s = await sender();
  await invited(s, "window", 21);
  await withdrawRun(s);
  const step = await scheduledWithdrawal();
  const refusedAs = async (code: string) => {
    assert.deepEqual(await s.plan(), { accounts: 1, placed: 0 });
    await s.place(step.id);
    assert.equal((await s.send()).result.refused, 1);
    assert.deepEqual(await waiting(step.id), ["scheduled", code]);
    assert.deepEqual(withdrawals(), []);
  };
  // Thursday 10:00, before a window from 11:00 to 17:00.
  const workingHours = { start: "11:00", end: "17:00", days: [1, 2, 3, 4, 5] };
  await app.senderAccount.update({ where: { id: s.accountId }, data: { workingHours } });
  await refusedAs("outside_working_hours");
  // Saturday noon, every day of the week listed.
  const always = { start: "00:00", end: "23:59", days: [1, 2, 3, 4, 5, 6, 7] };
  await app.senderAccount.update({ where: { id: s.accountId }, data: { workingHours: always } });
  moveTo(new Date("2026-10-24T12:00:00Z"));
  await refusedAs("outside_working_hours");
  // Monday noon, the account's kill switch on; then lifted, it goes.
  moveTo(new Date("2026-10-26T12:00:00Z"));
  await linkedin.setAccountPaused(s.accountId, "tester");
  await refusedAs("account_stopped");
  await linkedin.setAccountPaused(s.accountId, null);
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 1 });
  assert.equal((await s.send()).result.sent, 1);
  assert.equal(withdrawals().length, 1);
});

test("a withdrawal needs no approval and no credits: on an empty balance and with no item it goes, while a connection request waits insufficient_credits", async () => {
  const s = await sender(0);
  const lead = await invited(s, "free", 21);
  await withdrawRun(s);
  const [step] = await withdrawOf(lead.enrollmentId);
  assert.ok(step);
  await s.place(step.id);
  const invite = await s.ready("broke", "connect", "", afterSend());
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 1, end: "refused" });
  assert.equal(withdrawals().length, 1);
  const row = await stepOf(step.id);
  assert.deepEqual(
    [row.status, row.approvalItemId, row.draftId, row.creditUsageId],
    ["succeeded", null, null, null],
  );
  assert.equal(await app.approvalItem.count({ where: { stepExecutionId: step.id } }), 0);
  assert.deepEqual(await usagesOf(step.id), []);
  assert.deepEqual(await waiting(invite.id), ["scheduled", "insufficient_credits"]);
});

test("an accepted connection request is never withdrawn: accepted before the job, none is opened; accepted after it, the gate cancels the withdrawal before its slot, and the enrollment goes on", async () => {
  const s = await sender();
  const before = await invited(s, "accepted-before", 22);
  await app.stepExecution.update({ where: { id: before.connect }, data: { acceptedAt: now() } });
  const after = await invited(s, "accepted-after", 22);
  assert.deepEqual(await withdrawRun(s), { opened: 1 });
  // As beta-p4-050's subscriber records the acceptance detected once the job ran.
  await app.stepExecution.update({ where: { id: after.connect }, data: { acceptedAt: now() } });
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 1 });
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });

  assert.deepEqual(withdrawals(), []);
  assert.deepEqual(await withdrawOf(before.enrollmentId), []);
  const [step] = await withdrawOf(after.enrollmentId);
  assert.ok(step);
  assert.deepEqual([step.status, step.skipReason], ["cancelled", "invite_accepted"]);
  assert.deepEqual(await slotsOf(step.id), []);
  const { enrollment, steps } = await endOf(after.enrollmentId);
  assert.deepEqual(enrollment, ["active", null]);
  assert.deepEqual(steps.message_1, ["planned", null]);
});

test("a withdrawn person is refused a new enrollment for 90 days: the touch at the withdrawal, recently_contacted, an exited enrollment and no step", async () => {
  // contacts reads the real clock: the withdrawal on the latest weekday before today, at 10:00 UTC.
  const day = new Date(Date.now() - DAY_MS);
  day.setUTCHours(10, 0, 0, 0);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
  const s = await sender();
  moveTo(day);
  const lead = await invited(s, "cool-down", 21);
  await withdrawRun(s);
  await s.plan();
  assert.equal((await s.send()).result.sent, 1);
  const [step] = await withdrawOf(lead.enrollmentId);
  assert.ok(step?.executedAt);
  assert.deepEqual((await endOf(lead.enrollmentId)).enrollment, ["exited", "not_accepted"]);
  assert.equal(await leadOf(lead.personId), "finished");

  const touched: Date | null = await s.run(() => contacts.lastTouchAt(lead.personId));
  assert.equal(touched?.getTime(), step.executedAt.getTime());
  assert.equal(RECENT_TOUCH_DAYS.default, 90);
  assert.equal(recentTouchDaysUnset(), 90);
  const suppression = await s.run(() =>
    contacts.suppressionOf(lead.personId, { newEnrollment: true }),
  );
  assert.deepEqual(suppression, { suppressed: true, reason: "recently_contacted" });
  const approval = { sourceEventId: newId("obx"), personId: lead.personId, approvedBy: OWNER };
  assert.equal(await s.run((tx) => enrollApproved(tx, approval)), "suppressed");
  const latest = await app.enrollment.findFirstOrThrow({
    where: { personId: lead.personId, id: { not: lead.enrollmentId } },
  });
  assert.deepEqual(
    [latest.status, latest.exitReason, latest.exitDetail],
    ["exited", "suppressed", "recently_contacted"],
  );
  assert.equal(await app.stepExecution.count({ where: { enrollmentId: latest.id } }), 0);
});
