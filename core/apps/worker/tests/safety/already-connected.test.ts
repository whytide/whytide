// Safety cases of a connection request to a person who is a connection already
// (connect-already-connected; core/modules/campaigns README.md "Acceptance and the first message",
// docs/flows.md "The error map", "The read before an invite"), on the LinkedIn fake, the slice's
// Temporal and a schema of its database (fixtures/campaigns-sender.ts,
// fixtures/campaigns-member-reference.ts): an invite LinkedIn refuses so makes one call, its step
// skipped and message_1 due by the first-message rule, the enrollment and the lead as they were;
// message_1 then goes only approved and through the gate; any other refusal still ends the
// enrollment; a pause during the call keeps the due time and sends nothing, an end gets none; and a
// person with no member id who is a connection is read once and never invited.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  callsOf,
  MIN_MINUTES_AFTER_PROFILE_READ,
  MINUTE_MS,
  readCounts,
  readRows,
  seedProfile,
  skipWait,
  storedRef,
  unknownLead,
} from "../fixtures/campaigns-member-reference.ts";
import {
  app,
  contacts,
  fake,
  linkedin,
  now,
  OWNER,
  type Sender,
  sender,
  sends,
  skip,
  slotsOf,
  stepOf,
  thenOnce,
  usagesOf,
  useSenderTests,
} from "../fixtures/campaigns-sender.ts";

const { AppError } = await import("@whytide/platform");
const campaigns = await import(
  new URL("../../../../modules/campaigns/dist/index.js", import.meta.url).href
);

useSenderTests();
const HOUR_MS = 60 * MINUTE_MS;
const WAIT_MS = (MIN_MINUTES_AFTER_PROFILE_READ as number) * MINUTE_MS;
const TEXT = "Noor, how does your team review its pipeline each week?";
const OPT_OUT = { source: "manual", createdBy: OWNER };
const methods = () => sends().map(({ method }) => method);
type Lead = Awaited<ReturnType<Sender["ready"]>>;

/** The lead's enrollment status and the lead's outreach status. */
async function stateOf(lead: Lead): Promise<unknown[]> {
  const enrollment = await app.enrollment.findUniqueOrThrow({ where: { id: lead.enrollmentId } });
  const row = await app.lead.findFirstOrThrow({ where: { personId: lead.personId } });
  return [enrollment.status, row.outreachStatus];
}

/** The step's campaigns.step_sent events. */
const stepSent = (stepExecutionId: string) =>
  app.outboxEntry.count({
    where: {
      eventName: "campaigns.step_sent",
      payload: { path: ["stepExecutionId"], equals: stepExecutionId },
    },
  });

/**
 * message_1 of the lead `planned` and due by the first-message rule after a settle between `from`
 * and `to`: 1 to 3 hours after it, so never under 10 minutes, the account's hours every day here.
 */
async function assertFirstMessageDue(lead: Lead, from: number, to: number): Promise<number> {
  const message = await stepOf(lead.steps.message_1 as string);
  assert.equal(message.status, "planned");
  const due = message.dueAt?.getTime() ?? 0;
  assert.ok(
    due >= from + HOUR_MS && due <= to + 3 * HOUR_MS,
    `due ${message.dueAt?.toISOString()}`,
  );
  assert.ok(due - to >= 10 * MINUTE_MS);
  return due;
}

/** A new lead whose person is a relation of the account's, its connection request sent and settled. */
async function connectedLead(s: Sender, slug: string) {
  const lead = await s.ready(slug);
  fake.seedRelation(s.ref, lead.memberRef);
  const from = now().getTime();
  const { result } = await s.send();
  return { lead, result, from, to: now().getTime() };
}

test("an invite LinkedIn refuses as already connected: one call, never a second; the connect step skipped already_connected, its credits released, its slot counted with no invitation pending; message_1 due 1 to 3 hours later, never on a weekend; the enrollment and the lead as they were; no touch, no step_sent", async () => {
  const s = await sender();
  const { lead, result, from, to } = await connectedLead(s, "already-connected");

  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "no_step" });
  assert.deepEqual(methods(), ["sendInvite"]);
  const connect = await stepOf(lead.id);
  assert.deepEqual(
    [connect.status, connect.skipReason, connect.executedAt],
    ["skipped", "already_connected", null],
  );
  assert.deepEqual(await usagesOf(lead.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(lead.id), ["committed"]);
  const account = await app.senderAccount.findUniqueOrThrow({ where: { id: s.accountId } });
  assert.equal(account.pendingInvites, 0);
  // No outreach row: the daily check of pending invitations and the acceptance rate never read it.
  assert.equal(await app.senderOutreach.count({ where: { personId: lead.personId } }), 0);
  await assertFirstMessageDue(lead, from, to);
  assert.deepEqual(await stateOf(lead), ["active", "in_campaign"]);
  assert.equal(await s.run(() => contacts.lastTouchAt(lead.personId)), null);
  assert.equal(await stepSent(lead.id), 0);

  // Never a second call: the plan and the next run find nothing to send.
  await s.plan();
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(methods(), ["sendInvite"]);

  // Settled on a Friday night: message_1 at Monday's window start, never on the weekend.
  skip(Date.parse("2026-10-23T23:30:00Z") - now().getTime());
  const friday = await connectedLead(s, "already-connected-friday");
  assert.equal(friday.result.refused, 1);
  const message = await stepOf(friday.lead.steps.message_1 as string);
  assert.equal(message.dueAt?.toISOString(), "2026-10-26T00:00:00.000Z");
});

test("message_1 after the skip goes only with its approved item and through the gate as any message: not without its item; an opt-out, a reply, sending closed and a kill switch stop it; approved, it is sent once", async () => {
  const s = await sender();
  const skipped = async (slug: string) => (await connectedLead(s, `first-${slug}`)).lead;
  const bare = await skipped("bare");
  const optedOut = await skipped("opted-out");
  const replied = await skipped("replied");
  const closed = await skipped("closed");
  const approved = await skipped("approved");
  const switched = await skipped("switched");
  const invites = Array.from({ length: 6 }, () => "sendInvite");
  assert.deepEqual(methods(), invites);
  skip(3 * HOUR_MS + MINUTE_MS);
  const messageOf = (lead: Lead) => lead.steps.message_1 as string;
  const run = async (lead: Lead, stop?: () => Promise<unknown>) => {
    await s.approve(messageOf(lead), TEXT);
    await s.place(messageOf(lead));
    await stop?.();
    return (await s.send()).result;
  };

  // Due, but with no approved item: the gate skips it, no call.
  await app.stepExecution.update({ where: { id: messageOf(bare) }, data: { status: "scheduled" } });
  await s.place(messageOf(bare));
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  const unapproved = await stepOf(messageOf(bare));
  assert.deepEqual([unapproved.status, unapproved.skipReason], ["skipped", "not_approved"]);

  const optOut = () => s.run(() => contacts.addOptOut(optedOut.personId, OPT_OUT));
  assert.equal((await run(optedOut, optOut)).blocked, 1);
  const out = await stepOf(messageOf(optedOut));
  assert.deepEqual([out.status, out.skipReason], ["skipped", "opted_out"]);

  const reply = async () => {
    const row = { senderAccountId: s.accountId, personId: replied.personId };
    const { id } = await linkedin.createOutreach(s.workspaceId, row);
    await app.senderOutreach.update({ where: { id }, data: { lastInboundAt: now() } });
  };
  assert.equal((await run(replied, reply)).blocked, 1);
  const held = await stepOf(messageOf(replied));
  assert.deepEqual([held.status, held.skipReason], ["held", "replied"]);

  const close = () => linkedin.setPlatformControls({ sendingOpen: false });
  assert.equal((await run(closed, close)).refused, 1);
  const waiting = await stepOf(messageOf(closed));
  assert.deepEqual([waiting.status, waiting.errorCode], ["scheduled", "sending_closed"]);
  await linkedin.openSending();

  const stop = () => linkedin.setAccountPaused(s.accountId, "tester");
  assert.equal((await run(switched, stop)).refused, 1);
  const stopped = await stepOf(messageOf(switched));
  assert.deepEqual([stopped.status, stopped.errorCode], ["scheduled", "account_stopped"]);
  await linkedin.setAccountPaused(s.accountId, null);

  // Approved, with nothing in the way: sent once.
  assert.deepEqual(await run(approved), { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.equal((await stepOf(messageOf(approved))).status, "succeeded");

  assert.deepEqual(methods(), [...invites, "sendMessage"]);
});

test("an invite refused for another reason, and a message refused as already connected or for another reason, still fail the step and end the enrollment send_refused", async () => {
  const s = await sender();
  const invited = await s.ready("refused-invited");
  fake.failNext("linkedin_send_refused", { method: "sendInvite", reason: "already_invited" });
  assert.equal((await s.send()).result.refused, 1);
  const messages: Lead[] = [];
  for (const reason of ["already_connected", "not_connected"]) {
    const lead = await s.ready(`refused-${reason}`, "message_1", TEXT);
    const details = { method: "sendMessage", reason };
    fake.answerNext("sendMessage", new AppError("linkedin_send_refused", { details }));
    assert.equal((await s.send()).result.refused, 1, reason);
    messages.push(lead);
  }

  for (const lead of [invited, ...messages]) {
    const row = await stepOf(lead.id);
    assert.deepEqual([row.status, row.errorCode], ["failed", "linkedin_send_refused"]);
    assert.deepEqual(await stateOf(lead), ["exited", "finished"]);
    const enrollment = await app.enrollment.findUniqueOrThrow({ where: { id: lead.enrollmentId } });
    assert.equal(enrollment.exitReason, "send_refused");
    const next = await stepOf(lead.steps.follow_up_1 as string);
    assert.deepEqual([next.status, next.skipReason], ["cancelled", "linkedin_send_refused"]);
  }
  const message = await stepOf(invited.steps.message_1 as string);
  assert.deepEqual([message.status, message.dueAt], ["cancelled", null]);
  assert.deepEqual(methods(), ["sendInvite", "sendMessage", "sendMessage"]);
});

test("an enrollment paused during the call keeps its pause and gets message_1's due time, and nothing goes while it is paused; one ended during the call gets nothing", async () => {
  const s = await sender();
  const paused = await s.ready("paused-connected");
  fake.seedRelation(s.ref, paused.memberRef);
  const pause = thenOnce(() =>
    s.run(() => campaigns.pauseEnrollment(paused.enrollmentId, { reason: "user" })),
  );
  const from = now().getTime();
  const first = await s.send({ linkedin_send_invite: pause });
  assert.equal(first.result.refused, 1);
  const skipped = await stepOf(paused.id);
  assert.deepEqual([skipped.status, skipped.skipReason], ["skipped", "already_connected"]);
  await assertFirstMessageDue(paused, from, now().getTime());
  assert.deepEqual(await stateOf(paused), ["paused", "in_campaign"]);

  skip(3 * HOUR_MS + MINUTE_MS);
  const message = paused.steps.message_1 as string;
  await s.approve(message, TEXT);
  await s.place(message);
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  const waiting = await stepOf(message);
  assert.deepEqual([waiting.status, waiting.errorCode], ["scheduled", "enrollment_paused"]);

  const ended = await s.ready("ended-connected");
  fake.seedRelation(s.ref, ended.memberRef);
  const hold = thenOnce(() => s.run(() => campaigns.holdForReply(ended.personId, { at: now() })));
  assert.equal((await s.send({ linkedin_send_invite: hold })).result.refused, 1);
  const connect = await stepOf(ended.id);
  assert.deepEqual([connect.status, connect.skipReason], ["skipped", "already_connected"]);
  const gone = await stepOf(ended.steps.message_1 as string);
  assert.deepEqual([gone.status, gone.dueAt], ["held", null]);
  assert.deepEqual(await stateOf(ended), ["replied", "replied"]);
  assert.deepEqual(methods(), ["sendInvite", "sendInvite"]);
});

test("a person with no member id who is a connection: one read, reserved and logged as before, no slot and no invite call; the member id stored, the connect step skipped, message_1 due by the rule; one who is not is invited after the read and its wait", async () => {
  const s = await sender();
  const connected = await unknownLead(s, "read-connected");
  seedProfile(connected);
  fake.seedRelation(s.ref, connected.memberRef);
  const waits: number[] = [];
  const from = now().getTime();
  const { result } = await s.send({ campaigns_profile_settle: skipWait(waits) });

  assert.deepEqual(result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  assert.deepEqual(waits, []);
  assert.equal(callsOf("getProfile").length, 1);
  assert.deepEqual(sends(), []);
  const [reserved, made, ...more] = await readRows(s.accountId);
  assert.deepEqual(more, []);
  assert.deepEqual([reserved?.outcome, reserved?.objectRef], ["reserved", connected.id]);
  assert.deepEqual([made?.outcome, made?.objectRef], ["ok", null]);
  assert.deepEqual(await readCounts(s.accountId), { reserved: 0, committed: 1, actions: 1 });
  assert.deepEqual(await slotsOf(connected.id), []);
  const row = await stepOf(connected.id);
  assert.deepEqual([row.status, row.skipReason], ["skipped", "already_connected"]);
  assert.deepEqual(await usagesOf(connected.id), [":1 released 1"]);
  assert.equal(await storedRef(connected.personId), connected.memberRef);
  await assertFirstMessageDue(connected, from, now().getTime());
  assert.deepEqual(await stateOf(connected), ["active", "in_campaign"]);

  const stranger = await unknownLead(s, "read-stranger");
  seedProfile(stranger);
  const second = await s.send({ campaigns_profile_settle: skipWait(waits) });
  assert.deepEqual(second.result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(waits, [WAIT_MS]);
  assert.equal(callsOf("getProfile").length, 2);
  assert.deepEqual(methods(), ["sendInvite"]);
  const [, , , read] = await readRows(s.accountId);
  const { executedAt } = await stepOf(stranger.id);
  const gap = (executedAt?.getTime() ?? 0) - (read?.at.getTime() ?? 0);
  assert.ok(gap >= WAIT_MS, `invited ${gap} ms after the read`);
  assert.deepEqual(await slotsOf(stranger.id), ["committed"]);
});
