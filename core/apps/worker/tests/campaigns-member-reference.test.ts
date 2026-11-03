// The member reference before an invite (beta-p4-030; core/modules/campaigns/README.md "Worker",
// docs/flows.md "The read before an invite"), on the LinkedIn fake, the slice's Temporal and a schema
// of its database (fixtures/campaigns-sender.ts, fixtures/campaigns-member-reference.ts), the wait
// after the read shortened by useProfileReadWait: the read, the member ref stored on the person at
// its stored URL, the invite after the wait, the files gone, and no ref in the history, a log line
// or an event; a person with a ref invited with no read; a read refused before its call, outside
// working hours or on a stopped account; linkedin_not_found failing the step and ending the
// enrollment while the run goes on; a read with no answer; a slot refused after the wait; the hook
// refused outside APP_ENV=test. The safety cases are tests/safety/profile-read-before-invite.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  callsOf,
  campaignsTesting,
  noAnswer,
  profileFiles,
  readCounts,
  readRows,
  seedProfile,
  storedRef,
  unknownLead,
  useProfileReadWait,
} from "./fixtures/campaigns-member-reference.ts";
import {
  afterSend,
  app,
  historyOf,
  linkedin,
  logs,
  sender,
  sends,
  slotsOf,
  stepOf,
  thenOnce,
  usagesOf,
  useSenderTests,
} from "./fixtures/campaigns-sender.ts";

useSenderTests();
/** The wait after a read in this file, in ms, instead of the 3 minutes. */
const WAIT_MS = 300;
useProfileReadWait(WAIT_MS);
const NOTE = "Noor, I read your post on pipeline reviews";
const outcomes = async (accountId: string) =>
  (await readRows(accountId)).map(({ outcome }) => outcome);

test("a person with no member ref: one read, the ref stored on the person at its stored URL, the invite after the wait carrying it; the files gone; no ref in the history, a log line or an event", async () => {
  const s = await sender();
  const step = await unknownLead(s, "unknown", NOTE);
  seedProfile(step);
  const { result, workflowId } = await s.send();

  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.equal(callsOf("getProfile").length, 1);
  const [invite, ...more] = sends();
  assert.deepEqual(more, []);
  assert.equal((invite?.input as { memberRef: string }).memberRef, step.memberRef);
  assert.equal(await storedRef(step.personId), step.memberRef);
  const person = await app.person.findUniqueOrThrow({ where: { id: step.personId } });
  assert.deepEqual([person.linkedinUrl, person.title], [step.linkedinUrl, "Head of Sales"]);
  assert.equal(await app.person.count({ where: { workspaceId: s.workspaceId } }), 1);
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.errorCode, row.attempt], ["succeeded", null, 1]);
  const [, made] = await readRows(s.accountId);
  assert.ok((row.executedAt?.getTime() ?? 0) - (made?.at.getTime() ?? 0) >= WAIT_MS);
  assert.deepEqual(await usagesOf(step.id), [":1 committed 1"]);
  assert.deepEqual(await slotsOf(step.id), ["committed"]);
  assert.deepEqual(await profileFiles(s.workspaceId, step.id), []);
  assert.equal(await s.hasRequest(step.id), false);

  const history = await historyOf(workflowId);
  for (const secret of [step.memberRef, step.linkedinUrl, "Head of Sales", NOTE]) {
    assert.ok(!history.includes(secret), "the history holds the ref, the URL or the profile");
  }
  assert.ok(history.includes("member-reference"), "no patch marker");
  assert.ok(!JSON.stringify(logs.lines()).includes(step.memberRef), "a log line holds the ref");
  const events = await app.outboxEntry.findMany({ where: { workspaceId: s.workspaceId } });
  assert.ok(events.length > 0);
  assert.ok(!JSON.stringify(events).includes(step.memberRef), "an event holds the ref");
});

test("a person with a member ref is invited with no read", async () => {
  const s = await sender();
  const step = await s.ready("known");
  assert.deepEqual((await s.send()).result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(callsOf("getProfile"), []);
  assert.deepEqual(await readRows(s.accountId), []);
  assert.equal((await stepOf(step.id)).status, "succeeded");
});

test("a read refused before its call: outside working hours the step waits for the window and the run goes on; on a stopped account the run ends; the credits freed, no call", async () => {
  const hours = await sender();
  const workingHours = { start: "11:00", end: "17:00", days: [1, 2, 3, 4, 5] };
  await app.senderAccount.update({ where: { id: hours.accountId }, data: { workingHours } });
  const early = await unknownLead(hours, "early");
  seedProfile(early);
  assert.deepEqual((await hours.send()).result, {
    sent: 0,
    blocked: 0,
    refused: 1,
    end: "no_step",
  });
  const waiting = await stepOf(early.id);
  assert.deepEqual(
    [waiting.status, waiting.errorCode, waiting.scheduledFor, waiting.dueAt?.toISOString()],
    ["scheduled", "outside_working_hours", null, "2026-10-22T11:00:00.000Z"],
  );
  assert.deepEqual(await outcomes(hours.accountId), ["outside_working_hours"]);
  assert.deepEqual(await usagesOf(early.id), [":1 released 1"]);

  const stopped = await sender();
  const step = await unknownLead(stopped, "stopped");
  seedProfile(step);
  await linkedin.setAccountPaused(stopped.accountId, "tester");
  assert.deepEqual((await stopped.send()).result, {
    sent: 0,
    blocked: 0,
    refused: 1,
    end: "refused",
  });
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.errorCode], ["scheduled", "account_stopped"]);
  assert.deepEqual(await outcomes(stopped.accountId), ["account_stopped"]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(step.id), []);
  assert.deepEqual(callsOf("getProfile"), []);
  assert.deepEqual(sends(), []);
});

test("linkedin_not_found: the read made and counted, the step failed with profile_unreadable, the enrollment exited send_refused with its pending steps cancelled and the lead finished, the credits freed; the run goes on to the next step", async () => {
  const s = await sender();
  const gone = await unknownLead(s, "gone");
  const next = await s.ready("next", "connect", "", afterSend());
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 1, blocked: 1, refused: 0, end: "no_step" });
  assert.equal(callsOf("getProfile").length, 1);
  assert.deepEqual(
    sends().map(({ input }) => (input as { memberRef: string }).memberRef),
    [next.memberRef],
  );
  const row = await stepOf(gone.id);
  assert.deepEqual([row.status, row.errorCode], ["failed", "profile_unreadable"]);
  for (const key of ["message_1", "follow_up_1", "follow_up_2"]) {
    const other = await stepOf(gone.steps[key] as string);
    assert.deepEqual([other.status, other.skipReason], ["cancelled", "profile_unreadable"], key);
  }
  const enrollment = await app.enrollment.findUniqueOrThrow({ where: { id: gone.enrollmentId } });
  assert.deepEqual([enrollment.status, enrollment.exitReason], ["exited", "send_refused"]);
  assert.ok(enrollment.endedAt);
  const lead = await app.lead.findFirstOrThrow({ where: { personId: gone.personId } });
  assert.equal(lead.outreachStatus, "finished");
  assert.deepEqual(await usagesOf(gone.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(gone.id), []);
  assert.equal(await storedRef(gone.personId), null);
  assert.deepEqual((await readCounts(s.accountId)).committed, 1);
  assert.deepEqual(await profileFiles(s.workspaceId, gone.id), []);
  assert.equal((await stepOf(next.id)).status, "succeeded");
});

test("a read with no answer past its attempts: the read released, the credits freed, the step waits member_ref_unknown and the run ends", async () => {
  const s = await sender();
  const step = await unknownLead(s, "silent");
  seedProfile(step);
  const { result } = await s.send({ linkedin_read_profile: noAnswer });

  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
  assert.deepEqual(callsOf("getProfile"), []);
  const row = await stepOf(step.id);
  assert.deepEqual(
    [row.status, row.errorCode, row.scheduledFor],
    ["scheduled", "member_ref_unknown", null],
  );
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await readCounts(s.accountId), { reserved: 0, committed: 0, actions: 0 });
  assert.deepEqual(await profileFiles(s.workspaceId, step.id), []);
});

test("a slot refused after the wait frees the credits; placed again, the step is invited with no second read and one send charged", async () => {
  const s = await sender();
  const step = await unknownLead(s, "closed");
  seedProfile(step);
  const close = thenOnce(() => linkedin.setPlatformControls({ sendingOpen: false }));
  const refused = await s.send({ campaigns_profile_settle: close });
  assert.deepEqual(refused.result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.errorCode], ["scheduled", "sending_closed"]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(step.id), []);
  assert.equal(await storedRef(step.personId), step.memberRef);

  await linkedin.openSending();
  await s.place(step.id);
  assert.deepEqual((await s.send()).result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.equal(callsOf("getProfile").length, 1);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1", ":2 committed 1"]);
});

test("useProfileReadWait is refused in any environment but test", () => {
  const script = `const { useProfileReadWait } = await import(${JSON.stringify(campaignsTesting)});\nuseProfileReadWait(1);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { APP_ENV: "development" },
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /useProfileReadWait: only under APP_ENV=test/);
});
