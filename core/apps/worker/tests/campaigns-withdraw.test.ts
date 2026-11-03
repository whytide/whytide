// campaigns' withdrawals end to end (beta-p4-060; core/modules/campaigns/README.md "Withdrawals",
// docs/flows.md "The withdrawal"), on the LinkedIn fake, the slice's Temporal and a schema of its
// database (fixtures/campaigns-sender.ts, fixtures/campaigns-withdraw.ts): the schedule and the
// tick's starts; the workspace's run, which opens one withdraw step per connection request left
// unaccepted 21 days, and a second run; the sender's withdrawal and its settle; an invitation
// already gone; an acceptance while the withdrawal is on its way. The safety cases are
// tests/safety/withdrawal.test.ts; the replay of the histories is `pnpm -F worker test:replay`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterSend,
  app,
  fake,
  now,
  rowsOf,
  runLoaded,
  sender,
  slotsOf,
  starts,
  stepOf,
  thenOnce,
  usagesOf,
  useSenderTests,
} from "./fixtures/campaigns-sender.ts";
import {
  endOf,
  type Invited,
  invited,
  leadOf,
  moveTo,
  withdrawals,
  withdrawOf,
  withdrawRun,
} from "./fixtures/campaigns-withdraw.ts";

const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");

useSenderTests();
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const loaded = await loadModules(moduleLoaders.filter(({ name }) => name === "campaigns"));
const stepSent = (stepExecutionId: string) =>
  app.outboxEntry.findMany({
    where: {
      eventName: "campaigns.step_sent",
      payload: { path: ["stepExecutionId"], equals: stepExecutionId },
    },
  });
const touchOf = (personId: string): Promise<Date | null> =>
  app.person.findUniqueOrThrow({ where: { id: personId } }).then((row) => row.lastTouchAt);
const withdrawStep = async (lead: { readonly enrollmentId: string }) => {
  const [step] = await withdrawOf(lead.enrollmentId);
  assert.ok(step, "no withdraw step");
  return step;
};

test("the schedule campaigns.withdraw starts the tick daily at 05:00 UTC; the tick starts each workspace's campaigns_withdraw for the day, one at a time by campaigns.withdraw:<workspace>:<date>", async () => {
  assert.deepEqual(
    loaded.schedules.find(({ id }) => id === "campaigns.withdraw"),
    {
      id: "campaigns.withdraw",
      workflow: "campaigns_withdraw_tick",
      spec: { cronExpressions: ["0 5 * * *"], timezone: "UTC" },
      input: {},
    },
  );
  const s = await sender();
  assert.deepEqual(await runLoaded("campaigns_withdraw_tick", {}), { workspaces: 2, started: 2 });
  const ids = starts.map(({ input }) => (input as { workspaceId: string }).workspaceId);
  assert.ok(ids.includes(s.workspaceId));
  const expected = ids.toSorted().map((workspaceId) => ({
    workflow: "campaigns_withdraw",
    input: { workspaceId },
    workflowId: `campaigns.withdraw:${workspaceId}:2026-10-22`,
    oneAtATime: true,
  }));
  assert.deepEqual(starts, expected);
});

test("the workspace's run opens one withdraw step per connection request sent 21 days ago or more and not accepted: the request's hash, its key and :withdraw, scheduled and due now, no item; 20 days, a minute short of 21, accepted, ended or never sent: none; a second run opens none", async () => {
  const s = await sender();
  const due = [await invited(s, "day-21", 21), await invited(s, "day-30", 30)];
  const young = await invited(s, "day-20", 20);
  const short = await invited(s, "short", 21);
  const shortAt = new Date(short.sentAt.getTime() + MINUTE_MS);
  await app.stepExecution.update({ where: { id: short.connect }, data: { executedAt: shortAt } });
  const accepted = await invited(s, "accepted", 25);
  await app.stepExecution.update({ where: { id: accepted.connect }, data: { acceptedAt: now() } });
  const ended = await invited(s, "ended", 25);
  const exited = { status: "exited", exitReason: "removed", endedAt: now() } as const;
  await app.enrollment.update({ where: { id: ended.enrollmentId }, data: exited });
  const unsent = await s.lead("unsent");
  const before = now();

  assert.deepEqual(await withdrawRun(s), { opened: 2 });
  for (const lead of due) {
    const connect = await app.stepExecution.findUniqueOrThrow({ where: { id: lead.connect } });
    const step = await withdrawStep(lead);
    assert.deepEqual(
      [step.stepKey, step.position, step.actionType, step.status, step.personId],
      ["withdraw", 1, "withdraw", "scheduled", lead.personId],
    );
    assert.deepEqual(
      [step.stepTemplateHash, step.idempotencyKey, step.senderAccountId, step.templateId],
      [
        connect.stepTemplateHash,
        `${connect.idempotencyKey}:withdraw`,
        s.accountId,
        "linkedin_default",
      ],
    );
    assert.deepEqual([step.approvalItemId, step.draftId, step.scheduledFor], [null, null, null]);
    assert.ok(step.dueAt && step.dueAt >= before && step.dueAt <= now());
  }
  for (const lead of [young, short, accepted, ended, unsent]) {
    assert.deepEqual(await withdrawOf(lead.enrollmentId), []);
  }
  assert.equal(await app.approvalItem.count(), 0);
  assert.deepEqual(await withdrawRun(s), { opened: 0 });
  assert.equal(await app.stepExecution.count({ where: { stepKey: "withdraw" } }), 2);
});

test("the sender's withdrawal: a connection request the sender sent is withdrawn 21 days later through the plan and the sender, with the invitation's ref; the step succeeded, its slot committed, no credits, no file; the touch, campaigns.step_sent; the enrollment exited not_accepted, its later steps cancelled, the lead finished", async () => {
  const s = await sender();
  const invite = await s.ready("end-to-end");
  assert.equal((await s.send()).result.sent, 1);
  const where = { senderAccountId: s.accountId, personId: invite.personId };
  const { providerInvitationRef } = await app.senderOutreach.findFirstOrThrow({ where });
  assert.ok(providerInvitationRef);
  moveTo(new Date(now().getTime() + 21 * DAY_MS + MINUTE_MS));

  assert.deepEqual(await withdrawRun(s), { opened: 1 });
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 1 });
  assert.deepEqual((await s.send()).result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(
    withdrawals().map(({ input }) => input),
    [{ providerAccountRef: s.ref, invitationRef: providerInvitationRef }],
  );
  const { id } = await withdrawStep(invite);
  const row = await stepOf(id);
  assert.deepEqual([row.status, row.errorCode, row.creditUsageId], ["succeeded", null, null]);
  assert.ok(row.executedAt);
  const checks = row.jitChecks as Record<string, unknown>;
  assert.deepEqual(
    [checks.invite, checks.approval, checks.approvalItemId, checks.contentHash],
    [{ acceptedAt: null }, undefined, null, null],
  );
  assert.deepEqual(await usagesOf(id), []);
  assert.deepEqual(await slotsOf(id), ["committed"]);
  assert.deepEqual(await rowsOf(id), ["withdraw:ok"]);
  assert.equal(await s.hasRequest(id), false);
  assert.equal((await touchOf(invite.personId))?.getTime(), row.executedAt.getTime());
  assert.deepEqual(
    (await stepSent(id)).map(({ payload }) => payload),
    [{ stepExecutionId: id, personId: invite.personId, actionType: "withdraw" }],
  );
  const { enrollment, steps } = await endOf(invite.enrollmentId);
  assert.deepEqual(enrollment, ["exited", "not_accepted"]);
  assert.deepEqual(steps, {
    connect: ["succeeded", null],
    message_1: ["cancelled", "not_accepted"],
    follow_up_1: ["cancelled", "not_accepted"],
    follow_up_2: ["cancelled", "not_accepted"],
    withdraw: ["succeeded", null],
  });
  const ended = await app.enrollment.findUniqueOrThrow({ where: { id: invite.enrollmentId } });
  assert.equal(ended.endedAt?.getTime(), row.executedAt.getTime());
  assert.equal(await leadOf(invite.personId), "finished");
  assert.ok((await app.senderOutreach.findFirstOrThrow({ where })).withdrawnAt);
});

test("an invitation already gone, none pending (linkedin_not_found) or refused (linkedin_send_refused): the step failed with the code, its slot counted, the touch recorded all the same, the enrollment exited not_accepted, the lead finished, no campaigns.step_sent; the run goes on", async () => {
  const s = await sender();
  const gone = await invited(s, "gone", 21, { gone: true });
  const refused = await invited(s, "refused", 21);
  assert.deepEqual(await withdrawRun(s), { opened: 2 });
  await s.place((await withdrawStep(gone)).id);
  await s.place((await withdrawStep(refused)).id, afterSend());
  const refuseNext = thenOnce(() => fake.failNext("linkedin_send_refused"));
  const { result } = await s.send({ campaigns_sender_settle: refuseNext });

  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 2, end: "no_step" });
  assert.equal(withdrawals().length, 2);
  for (const [lead, code] of [
    [gone, "linkedin_not_found"],
    [refused, "linkedin_send_refused"],
  ] as const) {
    const step = await withdrawStep(lead);
    assert.deepEqual([step.status, step.errorCode], ["failed", code]);
    assert.ok(step.executedAt);
    assert.deepEqual(await slotsOf(step.id), ["committed"]);
    assert.deepEqual(await rowsOf(step.id), [`withdraw:${code}`]);
    assert.equal(await s.hasRequest(step.id), false);
    assert.equal((await touchOf(lead.personId))?.getTime(), step.executedAt.getTime());
    assert.deepEqual(await stepSent(step.id), []);
    const { enrollment, steps } = await endOf(lead.enrollmentId);
    assert.deepEqual(enrollment, ["exited", "not_accepted"]);
    assert.deepEqual(steps.message_1, ["cancelled", "not_accepted"]);
    assert.equal(await leadOf(lead.personId), "finished");
  }
});

test("an acceptance on the way: between the claim and the call, the gate cancels the withdrawal and frees its slot, no call; after a call answered linkedin_not_found, the step failed and the enrollment goes on, no touch", async () => {
  const s = await sender();
  const late = await invited(s, "accepted-late", 21);
  // Accepted: no invitation pending any more, so the call finds none.
  const racing = await invited(s, "accepted-racing", 21, { gone: true });
  assert.deepEqual(await withdrawRun(s), { opened: 2 });
  await s.place((await withdrawStep(late)).id);
  await s.place((await withdrawStep(racing)).id, afterSend());
  const accept = (lead: Invited) => () =>
    app.stepExecution.update({ where: { id: lead.connect }, data: { acceptedAt: now() } });
  const { result } = await s.send({
    campaigns_sender_prepare: thenOnce(accept(late)),
    linkedin_withdraw_invite: thenOnce(accept(racing)),
  });

  assert.deepEqual(result, { sent: 0, blocked: 1, refused: 1, end: "no_step" });
  assert.equal(withdrawals().length, 1);
  const cancelled = await withdrawStep(late);
  assert.deepEqual([cancelled.status, cancelled.skipReason], ["cancelled", "invite_accepted"]);
  assert.deepEqual(await slotsOf(cancelled.id), ["released"]);
  const failed = await withdrawStep(racing);
  assert.deepEqual([failed.status, failed.errorCode], ["failed", "linkedin_not_found"]);
  for (const lead of [late, racing]) {
    const { enrollment, steps } = await endOf(lead.enrollmentId);
    assert.deepEqual(enrollment, ["active", null]);
    assert.deepEqual(steps.message_1, ["planned", null]);
    assert.equal(await leadOf(lead.personId), "in_campaign");
    assert.equal((await touchOf(lead.personId))?.getTime(), lead.sentAt.getTime());
  }
});
