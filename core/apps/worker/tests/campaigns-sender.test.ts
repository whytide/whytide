// campaigns' sender end to end (beta-p4-020; core/modules/campaigns/README.md "Worker", docs/flows.md
// "The sender"), on the LinkedIn fake, the slice's Temporal and a schema of its database
// (fixtures/campaigns-sender.ts): an invite and a message sent and settled, the next step due in
// business days, the touch, campaigns.step_sent, sentStep, and a history holding no text, note or
// member ref; the refusals before the call and their retryAt, a paused account's included; an
// invite refused for the pending invitations, with no loop; insufficient_credits; the price from its setting and from credits' override; the last step
// completing the enrollment; a send past its credits' lease logged uncharged; an invite to a person
// who is a connection already skipped, message_1 due, its reason a code in the history
// (connect-already-connected). The safety cases are tests/safety/sender-workflow.test.ts and
// tests/safety/already-connected.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterSend,
  app,
  contacts,
  DAY_MS,
  fake,
  historyOf,
  leasesEnd,
  linkedin,
  logs,
  nextDueAt,
  now,
  sender,
  sends,
  sentStep,
  sha256,
  slotsOf,
  stepOf,
  thenOnce,
  usagesOf,
  useSenderTests,
  writePrices,
} from "./fixtures/campaigns-sender.ts";

useSenderTests();
const NOTE = "Noor, I read your post on pipeline reviews";
const TEXT = "Noor, how does your team review its pipeline each week?";
const sent = (eventName: string, stepExecutionId: string) =>
  app.outboxEntry.count({
    where: { eventName, payload: { path: ["stepExecutionId"], equals: stepExecutionId } },
  });

test("an invite and a message sent and settled: succeeded with executed_at and jit_checks, one charge, the next step due in business days, the touch, campaigns.step_sent once; sentStep; the history holds no text, note or member ref", async () => {
  const s = await sender();
  const invite = await s.ready("invite", "connect", NOTE);
  const message = await s.ready("message", "message_1", TEXT, afterSend());
  const { result, workflowId } = await s.send();

  assert.deepEqual(result, { sent: 2, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(
    sends().map(({ method }) => method),
    ["sendInvite", "sendMessage"],
  );
  for (const [step, approved] of [
    [invite, NOTE],
    [message, TEXT],
  ] as const) {
    const row = await stepOf(step.id);
    assert.equal(row.status, "succeeded");
    assert.equal(row.errorCode, null);
    assert.ok(row.executedAt && row.executedAt <= now());
    const checks = row.jitChecks as { approvalItemId: string; contentHash: string };
    assert.equal(checks.approvalItemId, row.approvalItemId);
    assert.equal(checks.contentHash, sha256(approved));
    assert.deepEqual(await usagesOf(step.id), [":1 committed 1"]);
    assert.deepEqual(await slotsOf(step.id), ["committed"]);
    assert.equal(await s.hasRequest(step.id), false);
    assert.equal(await sent("campaigns.step_sent", step.id), 1);
    const touched: Date | null = await s.run(() => contacts.lastTouchAt(step.personId));
    assert.equal(touched?.getTime(), row.executedAt.getTime());
    assert.deepEqual(await s.run(() => sentStep(step.id)), {
      personId: step.personId,
      senderAccountId: s.accountId,
      actionType: step.id === invite.id ? "invite" : "message",
      executedAt: row.executedAt,
      approvalItemId: row.approvalItemId,
      draftId: row.draftId,
    });
  }
  // message_1 waits for the acceptance; follow_up_1 three business days after message_1, Tuesday.
  assert.equal((await stepOf(invite.steps.message_1 as string)).dueAt, null);
  const { executedAt } = await stepOf(message.id);
  const due = (await stepOf(message.steps.follow_up_1 as string)).dueAt;
  assert.deepEqual(due, nextDueAt("follow_up_1", executedAt, "UTC"));
  assert.equal(due?.toISOString().slice(0, 10), "2026-10-27");
  assert.equal(await s.run(() => sentStep(message.steps.follow_up_1 as string)), null);

  const history = await historyOf(workflowId);
  for (const secret of [NOTE, TEXT, invite.memberRef, message.memberRef]) {
    assert.ok(!history.includes(secret), "the history holds a text, a note or a member ref");
  }
});

test("refusals before the call: one with a retryAt moves due_at and the run goes on; the activity's re-read (a workspace stopped) and a paused account end the run; the credits freed, nothing sent", async () => {
  const hours = await sender();
  // A window opening at 11:00: each refusal's retryAt, and the run goes on to the next step.
  const workingHours = { start: "11:00", end: "17:00", days: [1, 2, 3, 4, 5] };
  await app.senderAccount.update({ where: { id: hours.accountId }, data: { workingHours } });
  const early = [await hours.ready("early-1"), await hours.ready("early-2")];
  assert.deepEqual((await hours.send()).result, {
    sent: 0,
    blocked: 0,
    refused: 2,
    end: "no_step",
  });
  for (const step of early) {
    const row = await stepOf(step.id);
    assert.deepEqual(
      [row.status, row.errorCode, row.scheduledFor],
      ["scheduled", "outside_working_hours", null],
    );
    assert.equal(row.dueAt?.toISOString(), "2026-10-22T11:00:00.000Z");
    assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  }

  const stopped = await sender();
  const step = await stopped.ready("stopped");
  const stop = thenOnce(() => linkedin.setWorkspaceStopped(stopped.workspaceId, "tester"));
  const { result } = await stopped.send({ campaigns_sender_gate: stop });
  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.errorCode], ["scheduled", "workspace_stopped"]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(step.id), ["released"]);

  const paused = await sender();
  const held = await paused.ready("paused");
  await linkedin.setHealth(paused.accountId, "restricted", {
    pausedUntil: new Date(now().getTime() + DAY_MS),
  });
  assert.deepEqual((await paused.send()).result, {
    sent: 0,
    blocked: 0,
    refused: 1,
    end: "refused",
  });
  assert.equal((await stepOf(held.id)).errorCode, "account_paused");
  assert.deepEqual(await slotsOf(held.id), []);
  assert.deepEqual(sends(), []);
});

test("an invite refused for the pending invitations, unknown at the claim or over the limit at the call's re-read, waits unplaced until the refusal's time, its credits freed, and the run goes on to a message; the plan and the next run then place and claim nothing", async () => {
  const s = await sender();
  const dayEnd = "2026-10-23T00:00:00.000Z";
  const account = { where: { id: s.accountId } };
  await app.senderAccount.update({ ...account, data: { pendingInvites: null } });
  const unknown = await s.ready("pending-unknown");
  await s.ready("pending-message", "message_1", TEXT, afterSend());
  const before = now().getTime();
  assert.deepEqual((await s.send()).result, { sent: 1, blocked: 0, refused: 1, end: "no_step" });
  const waiting = await stepOf(unknown.id);
  assert.deepEqual(
    [waiting.status, waiting.errorCode, waiting.scheduledFor],
    ["scheduled", "pending_invites_unknown", null],
  );
  // Until the day's check, or the next quota day's start.
  const due = waiting.dueAt?.getTime() ?? 0;
  assert.ok(due > before && due <= Date.parse(dayEnd), `due ${waiting.dueAt?.toISOString()}`);
  assert.deepEqual(await usagesOf(unknown.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(unknown.id), []);

  const counted = { pendingInvites: 0, pendingInvitesCheckedAt: now() };
  await app.senderAccount.update({ ...account, data: counted });
  const over = await s.ready("pending-over", "connect", "", afterSend());
  const limit = thenOnce(() =>
    app.senderAccount.update({ ...account, data: { pendingInvites: 401 } }),
  );
  const refused = await s.send({ campaigns_sender_prepare: limit });
  assert.deepEqual(refused.result, { sent: 0, blocked: 0, refused: 1, end: "no_step" });
  const row = await stepOf(over.id);
  assert.deepEqual(
    [row.status, row.errorCode, row.scheduledFor, row.dueAt?.toISOString()],
    ["scheduled", "pending_invites_over_limit", null, dayEnd],
  );
  assert.deepEqual(await usagesOf(over.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(over.id), ["released"]);

  // No loop: neither invite is placed again before its time, and a new run claims nothing.
  await s.plan();
  for (const id of [unknown.id, over.id]) assert.equal((await stepOf(id)).scheduledFor, null);
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(await usagesOf(unknown.id), [":1 released 1"]);
  assert.deepEqual(
    sends().map(({ method }) => method),
    ["sendMessage"],
  );
});

test("insufficient_credits: the step waits unplaced with the code, no slot taken, and the run ends", async () => {
  const s = await sender(0);
  const step = await s.ready("no-credits");
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
  const row = await stepOf(step.id);
  assert.deepEqual(
    [row.status, row.errorCode, row.scheduledFor, row.attempt],
    ["scheduled", "insufficient_credits", null, 0],
  );
  assert.deepEqual(await usagesOf(step.id), []);
  assert.deepEqual(await slotsOf(step.id), []);
  assert.deepEqual(sends(), []);
});

test("the price: CAMPAIGNS_CREDITS_PER_LINKEDIN_SEND=3 commits 3 for a send, and credits' PRICE_CAMPAIGNS_LINKEDIN_SEND=2 overrides it", async () => {
  const setting = { CAMPAIGNS_CREDITS_PER_LINKEDIN_SEND: "3" };
  const s = await sender(100, setting);
  const first = await s.ready("price-3");
  assert.equal((await s.send()).result.sent, 1);
  assert.deepEqual(await usagesOf(first.id), [":1 committed 3"]);

  // A drop applies at once; a rise would wait its 30 days' notice (credits' README "Decided here").
  await writePrices({ ...setting, PRICE_CAMPAIGNS_LINKEDIN_SEND: "2" });
  const second = await s.ready("price-2", "connect", "", afterSend());
  assert.equal((await s.send()).result.sent, 1);
  assert.deepEqual(await usagesOf(second.id), [":1 committed 2"]);
});

test("follow_up_2 sent completes the enrollment and finishes the lead", async () => {
  const s = await sender();
  const step = await s.ready("last", "follow_up_2", TEXT);
  assert.equal((await s.send()).result.sent, 1);
  const enrollment = await app.enrollment.findUniqueOrThrow({ where: { id: step.enrollmentId } });
  assert.equal(enrollment.status, "completed");
  assert.equal(enrollment.endedAt?.getTime(), (await stepOf(step.id)).executedAt?.getTime());
  const lead = await app.lead.findFirstOrThrow({ where: { personId: step.personId } });
  assert.equal(lead.outreachStatus, "finished");
  assert.equal(await sent("campaigns.step_sent", step.id), 1);
});

test("a send that went out past its credits' lease stays succeeded and is logged send_uncharged", async () => {
  const s = await sender();
  const step = await s.ready("uncharged");
  const lapse = thenOnce(() => leasesEnd());
  assert.equal((await s.send({ linkedin_send_invite: lapse })).result.sent, 1);
  const row = await stepOf(step.id);
  assert.equal(row.status, "succeeded");
  const line = logs.lines().find(({ msg }) => msg === "campaigns: send_uncharged");
  assert.ok(line, "no send_uncharged line");
  assert.equal(line.level, "warn");
  assert.equal(line.step_execution_id, step.id);
  assert.equal(line.credit_usage_id, row.creditUsageId);
});

test("an invite to a person who is a connection already: one call, the step skipped already_connected, message_1 due an hour or more after it, no invitation pending; the history holds the reason as a code, no note and no member ref", async () => {
  const s = await sender();
  const lead = await s.ready("connected", "connect", NOTE);
  fake.seedRelation(s.ref, lead.memberRef);
  const at = now().getTime();
  const { result, workflowId } = await s.send();

  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "no_step" });
  assert.deepEqual(
    sends().map(({ method }) => method),
    ["sendInvite"],
  );
  const row = await stepOf(lead.id);
  assert.deepEqual(
    [row.status, row.skipReason, row.errorCode],
    ["skipped", "already_connected", null],
  );
  const message = await stepOf(lead.steps.message_1 as string);
  assert.ok((message.dueAt?.getTime() ?? 0) >= at + 60 * 60_000, "message_1 not due after an hour");
  const account = await app.senderAccount.findUniqueOrThrow({ where: { id: s.accountId } });
  assert.equal(account.pendingInvites, 0);
  const history = await historyOf(workflowId);
  assert.ok(history.includes('"refused":"linkedin_send_refused","reason":"already_connected"'));
  for (const secret of [NOTE, lead.memberRef]) {
    assert.ok(!history.includes(secret), "the history holds a note or a member ref");
  }
});
