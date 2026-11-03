// campaigns' recovery end to end (beta-p4-040; core/modules/campaigns/README.md "Worker",
// docs/flows.md "The check first", "The error map", "A replaced account"), on the LinkedIn fake,
// the slice's Temporal and a schema of its database (fixtures/campaigns-sender.ts): each row of
// linkedin's error map as the sender settles it, a request off the port's schema, one action's
// refusal leaving the others going, the check before the first claim and its answers, the note
// budget's wait on the step and in "Up next", the day's limits and spacing after an outage,
// linkedin.account_replaced delivered by the worker's outbox loop, then again, and the read before an
// invite's (fixtures/campaigns-member-reference.ts): a settle retried after its files are gone, a
// stored URL off the port's schema, and the read's attempts; the gate's test hook refused outside
// APP_ENV=test. The safety cases are tests/safety/recovery.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  callsOf,
  campaignsTesting,
  profileFiles,
  readCounts,
  seedProfile,
  skipWait,
  storedRef,
  unknownLead,
} from "./fixtures/campaigns-member-reference.ts";
import {
  afterSend,
  app,
  DAY_MS,
  fake,
  leasesEnd,
  linkedin,
  logs,
  MIN_ACTION_GAP_MS,
  now,
  rowsOf,
  type Sender,
  sender,
  senderStart,
  sends,
  skip,
  slotsOf,
  starts,
  stepOf,
  usagesOf,
  useSenderTests,
  type Wrap,
} from "./fixtures/campaigns-sender.ts";

const { outboxWriter, Prisma } = await import("@whytide/db");
const platform = await import("@whytide/platform");
const { startOutboxLoop } = await import("../src/outbox.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const { createApprovalItem } = await import(built("approvals/dist/testing/index.js"));
const { events: linkedinEvents } = await import(built("linkedin/dist/index.js"));

useSenderTests();
const GAP = MIN_ACTION_GAP_MS as number;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** The next quota day's start after THURSDAY, in UTC, the account's zone. */
const FRIDAY = "2026-10-23T00:00:00.000Z";
const REPLACED = "linkedin.account_replaced";
const LATER_STEPS = ["message_1", "follow_up_1", "follow_up_2"] as const;
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const calls = () => fake.recordedCalls.map(({ method }) => method);
type Lead = Awaited<ReturnType<Sender["lead"]>>;

/** The lead's enrollment, its exit, and the lead's outreach status. */
async function endOf(lead: Lead): Promise<unknown[]> {
  const enrollment = await app.enrollment.findUniqueOrThrow({ where: { id: lead.enrollmentId } });
  const row = await app.lead.findFirstOrThrow({ where: { personId: lead.personId } });
  const { status, exitReason, exitDetail } = enrollment;
  return [status, exitReason, exitDetail, row.outreachStatus];
}

/** A pending item in "Up next" for the lead's step `key`: its id. */
const pendingItem = (s: Sender, lead: Lead, key: string): Promise<string> =>
  createApprovalItem({
    ...{ workspaceId: s.workspaceId, personId: lead.personId, senderAccountId: s.accountId },
    ...{ stepExecutionId: lead.steps[key], stepKey: key },
  });
const itemOf = (stepExecutionId: string) =>
  app.approvalItem.findFirstOrThrow({ where: { stepExecutionId, status: "approved" } });

/** The worker's outbox loop, run until linkedin.account_replaced is delivered, then stopped. */
async function deliver(): Promise<void> {
  const loop = startOutboxLoop(app, log);
  try {
    const deadline = Date.now() + 20_000;
    const where = { eventName: REPLACED, deliveredAt: null };
    while ((await app.outboxEntry.count({ where })) > 0) {
      assert.ok(Date.now() < deadline, "delivered in 20 seconds");
      await sleep(50);
    }
  } finally {
    await loop.stop();
  }
}

test("linkedin_rate_limited after the call: the credits released, the step back unplaced with its code, due after the vendor's wait, its wait in Up next, and the run ends", async () => {
  const s = await sender();
  const step = await s.ready("rate-limited");
  const next = await s.ready("rate-limited-next", "connect", "", afterSend());
  fake.failNext("linkedin_rate_limited");
  const before = now().getTime();
  const { result } = await s.send();
  const after = now().getTime();

  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
  const row = await stepOf(step.id);
  assert.deepEqual(
    [row.status, row.errorCode, row.scheduledFor],
    ["scheduled", "linkedin_rate_limited", null],
  );
  const due = row.dueAt?.getTime() ?? 0;
  assert.ok(due >= before + MINUTE_MS && due <= after + MINUTE_MS, "due 60 s after the answer");
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(step.id), ["released"]);
  const item = await itemOf(step.id);
  assert.deepEqual([item.waitCode, item.waitUntil?.getTime()], ["linkedin_rate_limited", due]);
  assert.equal((await stepOf(next.id)).attempt, 0);
  assert.equal(sends().length, 1);
});

test("an unknown outcome (linkedin_provider_error, a vendor's answer off the schema, an error the boundary does not know): the step stays executing with its credits, its slot and its file, due for its check, and the run ends", async () => {
  const answers = [
    ["linkedin_provider_error", () => fake.failNext("linkedin_provider_error")],
    ["linkedin_output_invalid", () => fake.answerNext("sendInvite", { invalid: true })],
    ["linkedin_error_unmapped", () => fake.answerNext("sendInvite", new Error("vendor"))],
  ] as const;
  for (const [code, answer] of answers) {
    const s = await sender();
    const step = await s.ready(code);
    const next = await s.ready(`${code}-next`, "connect", "", afterSend());
    answer();
    const { result } = await s.send();

    assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "unsettled" }, code);
    const row = await stepOf(step.id);
    assert.deepEqual([row.status, row.errorCode, row.dueAt], ["executing", code, null], code);
    assert.deepEqual(await usagesOf(step.id), [":1 reserved 1"], code);
    assert.deepEqual(await slotsOf(step.id), ["reserved"], code);
    assert.equal(await s.hasRequest(step.id), true, code);
    assert.equal((await stepOf(next.id)).attempt, 0, code);
  }
});

test("linkedin_send_refused, linkedin_not_found and linkedin_input_invalid fail the step and end its enrollment send_refused, its pending steps and items cancelled and its lead finished; the run goes on to the next step", async () => {
  const s = await sender();
  const refused = await s.ready("send-refused");
  const item = await pendingItem(s, refused, "message_1");
  const gone = await s.ready("not-found", "connect", "", afterSend());
  const invalid = await s.ready("input-invalid", "connect", "", afterSend(2));
  const last = await s.ready("goes-on", "connect", "", afterSend(3));
  fake.failNext("linkedin_send_refused");
  fake.failNext("linkedin_not_found");
  fake.answerNext("sendInvite", new platform.AppError("linkedin_input_invalid"));
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 3, end: "no_step" });
  assert.equal(sends().length, 4);
  const failed = [
    [refused, "linkedin_send_refused", null],
    [gone, "linkedin_not_found", null],
    [invalid, "linkedin_input_invalid", "linkedin_input_invalid"],
  ] as const;
  for (const [lead, code, detail] of failed) {
    const row = await stepOf(lead.id);
    assert.deepEqual([row.status, row.errorCode], ["failed", code], code);
    assert.deepEqual(await endOf(lead), ["exited", "send_refused", detail, "finished"], code);
    for (const key of LATER_STEPS) {
      const pending = await stepOf(lead.steps[key] as string);
      assert.deepEqual([pending.status, pending.skipReason], ["cancelled", code], key);
    }
    assert.deepEqual(await usagesOf(lead.id), [":1 released 1"], code);
  }
  assert.equal(
    (await app.approvalItem.findUniqueOrThrow({ where: { id: item } })).status,
    "blocked",
  );
  assert.equal((await stepOf(last.id)).status, "succeeded");
});

test("linkedin_account_disconnected and linkedin_limit_reached release the credits; the step waits unplaced for the next quota day, and the run ends", async () => {
  try {
    // The restriction last: it trips the fleet breaker (linkedin's README "Health").
    for (const code of ["linkedin_account_disconnected", "linkedin_limit_reached"] as const) {
      const s = await sender();
      const step = await s.ready(code);
      const next = await s.ready(`${code}-next`, "connect", "", afterSend());
      fake.failNext(code);
      const { result } = await s.send();

      assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "refused" }, code);
      const row = await stepOf(step.id);
      assert.deepEqual(
        [row.status, row.errorCode, row.scheduledFor, row.dueAt?.toISOString()],
        ["scheduled", code, null, FRIDAY],
        code,
      );
      assert.deepEqual(await usagesOf(step.id), [":1 released 1"], code);
      assert.equal((await stepOf(next.id)).attempt, 0, code);
    }
  } finally {
    await linkedin.setPlatformControls({ invitesPaused: false });
  }
});

test("a request off the port's schema, a note over its 300 characters, is a defect: no call, the holds freed, the step failed linkedin_input_invalid and its enrollment ended", async () => {
  const s = await sender();
  const step = await s.ready("long-note", "connect", "n".repeat(400));
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  assert.deepEqual(sends(), []);
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.errorCode], ["failed", "linkedin_input_invalid"]);
  const ended = ["exited", "send_refused", "linkedin_input_invalid", "finished"];
  assert.deepEqual(await endOf(step), ended);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(step.id), ["released"]);
  assert.equal(await s.hasRequest(step.id), false);
});

test("invites paused refuse a connection request with no time and leave the account's messages going: the run goes on", async () => {
  const s = await sender();
  const invite = await s.ready("paused-invite");
  const message = await s.ready("paused-message", "message_1", "Noor, a question", afterSend());
  await linkedin.setPlatformControls({ invitesPaused: true });
  try {
    const { result } = await s.send();
    assert.deepEqual(result, { sent: 1, blocked: 0, refused: 1, end: "no_step" });
  } finally {
    await linkedin.setPlatformControls({ invitesPaused: false });
  }
  const row = await stepOf(invite.id);
  assert.deepEqual(
    [row.status, row.errorCode, row.scheduledFor],
    ["scheduled", "invites_paused", null],
  );
  assert.equal((await stepOf(message.id)).status, "succeeded");
  assert.deepEqual(
    sends().map(({ method }) => method),
    ["sendMessage"],
  );
});

test("a step left executing is checked before any new claim: not_sent releases its credits and puts it back for the plan, and the run goes on", async () => {
  const s = await sender();
  const left = await s.ready("left-unsent");
  const stopped: Wrap = () => () => Promise.reject(new Error("stopped"));
  assert.equal((await s.send({ linkedin_send_invite: stopped })).result.end, "unsettled");
  const next = await s.ready("after-the-check");
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(calls(), ["getRelation", "sendInvite"]);
  const row = await stepOf(left.id);
  assert.deepEqual(
    [row.status, row.scheduledFor, row.errorCode, row.attempt],
    ["scheduled", null, null, 1],
  );
  assert.deepEqual(await usagesOf(left.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(left.id), ["released"]);
  assert.equal((await stepOf(next.id)).status, "succeeded");
});

test("a step left executing whose request cannot be written again is checked with the file its send left; with none, no call went out: it is put back, its credits released, and nothing is read", async () => {
  const stopped: Wrap = () => () => Promise.reject(new Error("stopped"));
  const unref = (personId: string) =>
    app.person.update({ where: { id: personId }, data: { providerRefs: Prisma.DbNull } });
  const nothing = { sent: 0, blocked: 0, refused: 0, end: "no_step" };
  // The member ref gone since the send: its file still names the member the send went to.
  const s = await sender();
  const kept = await s.ready("file-kept");
  assert.equal((await s.send({ linkedin_send_invite: stopped })).result.end, "unsettled");
  await unref(kept.personId);
  assert.deepEqual((await s.send()).result, nothing);
  assert.deepEqual(calls(), ["getRelation"]);
  const checked = await stepOf(kept.id);
  assert.deepEqual(
    [checked.status, checked.scheduledFor, checked.errorCode],
    ["scheduled", null, null],
  );
  assert.deepEqual(await usagesOf(kept.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(kept.id), ["released"]);

  // No file either, as for a step charged before its profile read: no send could read one.
  const t = await sender();
  const gone = await t.ready("file-gone");
  assert.equal((await t.send({ linkedin_send_invite: stopped })).result.end, "unsettled");
  await unref(gone.personId);
  await t.dropRequest(gone.id);
  assert.deepEqual((await t.send()).result, nothing);
  assert.deepEqual(calls(), ["getRelation"]);
  const back = await stepOf(gone.id);
  assert.deepEqual(
    [back.status, back.scheduledFor, back.errorCode],
    ["scheduled", null, "member_ref_unknown"],
  );
  assert.deepEqual(await usagesOf(gone.id), [":1 released 1"]);
  // linkedin's slot for the key: its next claim takes it again, or it expires.
  assert.deepEqual(await slotsOf(gone.id), ["reserved"]);
});

test("the check's other answers: a refusal with no call waits for its retryAt, a port error for the next quota day; a send found out settles the step succeeded, logged uncharged past its credits' lease", async () => {
  const s = await sender();
  const step = await s.ready("checked");
  fake.failNext("linkedin_provider_error");
  await s.send();
  const { retryAt } = await app.senderAccount.findUniqueOrThrow({ where: { id: s.accountId } });
  assert.ok(retryAt, "linkedin's pause");

  skip(10 * MINUTE_MS);
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "unsettled" });
  let row = await stepOf(step.id);
  assert.deepEqual([row.status, row.dueAt?.getTime()], ["executing", retryAt.getTime()]);
  assert.deepEqual(calls(), ["sendInvite"]);

  skip(HOUR_MS);
  fake.failNext("linkedin_provider_error");
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "unsettled" });
  row = await stepOf(step.id);
  assert.deepEqual([row.status, row.dueAt?.toISOString()], ["executing", FRIDAY]);

  skip(DAY_MS);
  fake.seedRelation(s.ref, step.memberRef);
  leasesEnd();
  assert.deepEqual((await s.send()).result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(calls(), ["sendInvite", "getRelation", "getRelation"]);
  row = await stepOf(step.id);
  assert.deepEqual([row.status, row.errorCode], ["succeeded", null]);
  assert.deepEqual(
    (await rowsOf(step.id)).filter((logged) => logged === "invite:ok"),
    ["invite:ok"],
  );
  const line = logs.lines().find(({ msg }) => msg === "campaigns: send_uncharged");
  assert.ok(line, "no send_uncharged line");
  assert.deepEqual([line.step_execution_id, line.credit_usage_id], [step.id, row.creditUsageId]);
});

test("an invite over the note budget waits until the oldest counted note leaves the 30 days: the code on the step for the lead page, the code and time on its item for Up next, cleared when the sender claims it again", async () => {
  const s = await sender();
  const step = await s.ready("note-budget", "connect", "Noor, glad to connect");
  // Three notes sent in the 30 days, the oldest 22 days ago: it leaves them on a Friday.
  const at = now().getTime();
  const until = new Date(at - 22 * DAY_MS + 30 * DAY_MS);
  await app.senderActionLog.createMany({
    data: [22, 10, 5].map((days) => ({
      ...{ id: platform.newId("sal"), workspaceId: s.workspaceId, senderAccountId: s.accountId },
      ...{ kind: "invite", count: 1, outcome: "ok", withNote: true },
      at: new Date(at - days * DAY_MS),
    })),
  });
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 1, end: "no_step" });
  const row = await stepOf(step.id);
  assert.deepEqual(
    [row.status, row.errorCode, row.scheduledFor, row.dueAt?.getTime()],
    ["scheduled", "invite_note_budget", null, until.getTime()],
  );
  const waiting = await itemOf(step.id);
  assert.deepEqual(
    [waiting.waitCode, waiting.waitUntil?.getTime()],
    ["invite_note_budget", until.getTime()],
  );
  assert.deepEqual(sends(), []);

  skip(until.getTime() - now().getTime() + MINUTE_MS);
  await s.place(step.id);
  assert.equal((await s.send()).result.sent, 1);
  const cleared = await itemOf(step.id);
  assert.deepEqual([cleared.waitCode, cleared.waitUntil], [null, null]);
  assert.equal((await stepOf(step.id)).status, "succeeded");
});

test("linkedin.account_replaced, delivered by the outbox: the account's active enrollments end no_sender (account_replaced), their open steps and items cancelled, their leads finished; an executing step is left to the sender; another account's enrollment and a redelivery change nothing", async () => {
  const s = await sender();
  const scheduled = await s.ready("replaced-scheduled");
  const item = await pendingItem(s, scheduled, "message_1");
  const flying = await s.lead("replaced-in-flight");
  const inFlight = flying.steps.connect as string;
  await app.stepExecution.update({
    where: { id: inFlight },
    data: { status: "executing", attempt: 1 },
  });
  const other = await linkedin.createConnectedAccount(s.workspaceId);
  const kept = await s.lead("another-account");
  const moved = { senderAccountId: other.id };
  await app.enrollment.update({ where: { id: kept.enrollmentId }, data: moved });
  await app.stepExecution.updateMany({ where: { enrollmentId: kept.enrollmentId }, data: moved });
  await s.run((tx) =>
    platform.publish(outboxWriter(tx, s.workspaceId), linkedinEvents[REPLACED], {
      sender_account_id: s.accountId,
    }),
  );
  await deliver();

  const detail = ["exited", "no_sender", "account_replaced", "finished"];
  for (const lead of [scheduled, flying]) assert.deepEqual(await endOf(lead), detail);
  for (const key of ["connect", ...LATER_STEPS]) {
    const row = await stepOf(scheduled.steps[key] as string);
    assert.deepEqual([row.status, row.skipReason], ["cancelled", "account_replaced"], key);
  }
  for (const key of LATER_STEPS) {
    assert.equal((await stepOf(flying.steps[key] as string)).status, "cancelled", key);
  }
  const executing = await stepOf(inFlight);
  assert.deepEqual([executing.status, executing.skipReason], ["executing", null]);
  assert.equal(
    (await app.approvalItem.findUniqueOrThrow({ where: { id: item } })).status,
    "blocked",
  );
  const untouched = await app.enrollment.findUniqueOrThrow({ where: { id: kept.enrollmentId } });
  assert.equal(untouched.status, "active");
  assert.equal((await stepOf(kept.steps.connect as string)).status, "planned");

  const where = { workspaceId: s.workspaceId };
  const rows = async () => [
    await app.enrollment.findMany({ where, orderBy: { id: "asc" } }),
    await app.stepExecution.findMany({ where, orderBy: { id: "asc" } }),
    await app.approvalItem.findMany({ where, orderBy: { id: "asc" } }),
    await app.lead.findMany({ where, orderBy: { personId: "asc" } }),
  ];
  const once = await rows();
  await app.outboxEntry.updateMany({
    where: { eventName: REPLACED },
    data: { deliveredAt: null, nextAttemptAt: new Date(0) },
  });
  await deliver();
  assert.deepEqual(await rows(), once);
});

test("after a day's outage the steps left executing are checked first, found unsent and placed again within the day's limits: no burst, the sends a gap apart", async () => {
  const s = await sender();
  // The lowest target: a day's limit of 4 or 5 connection requests, fewer than the steps.
  await app.senderAccount.update({ where: { id: s.accountId }, data: { inviteTarget: 5 } });
  const left: string[] = [];
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const { id } = await s.ready(`outage-${n}`);
    await app.stepExecution.update({ where: { id }, data: { status: "executing", attempt: 1 } });
    left.push(id);
  }
  skip(DAY_MS);
  // The plan starts the sender of an account whose steps are due for their check.
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 0 });
  assert.deepEqual(starts, [senderStart(s.workspaceId, s.accountId)]);
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });
  for (const id of left) assert.equal((await stepOf(id)).status, "scheduled");

  await s.plan();
  await s.send();
  const where = { senderAccountId: s.accountId, quotaDay: FRIDAY.slice(0, 10) };
  const { inviteLimit } = await app.senderQuotaUsage.findFirstOrThrow({ where });
  assert.ok(inviteLimit >= 4 && inviteLimit <= 5, `the day's limit ${inviteLimit}`);
  assert.equal(sends().length, inviteLimit);
  const times = (await Promise.all(left.map((id) => stepOf(id))))
    .flatMap(({ executedAt }) => (executedAt === null ? [] : [executedAt.getTime()]))
    .sort((a, b) => a - b);
  assert.equal(times.length, inviteLimit);
  for (let n = 1; n < times.length; n += 1) {
    const gap = (times[n] ?? 0) - (times[n - 1] ?? 0);
    assert.ok(gap >= GAP, `two sends ${gap} ms apart`);
  }
});

test("a profile settle whose answer is lost after it deleted its files answers again from the person: one read, the ref stored, one invite charged once", async () => {
  const s = await sender();
  const step = await unknownLead(s, "lost-settle");
  seedProfile(step);
  let lost = false;
  const lostOnce: Wrap = (run) => async (input, context) => {
    const answer = await run(input, context);
    if (lost) return answer;
    lost = true;
    throw new Error("the settle's answer lost");
  };
  const settle: Wrap = (run) => skipWait()(lostOnce(run));
  const { result } = await s.send({ campaigns_profile_settle: settle });
  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.ok(lost);
  assert.equal(callsOf("getProfile").length, 1);
  assert.equal(sends().length, 1);
  assert.equal(await storedRef(step.personId), step.memberRef);
  assert.deepEqual(await usagesOf(step.id), [":1 committed 1"]);
  assert.deepEqual(await readCounts(s.accountId), { reserved: 0, committed: 1, actions: 2 });
  assert.deepEqual(await profileFiles(s.workspaceId, step.id), []);
});

test("a stored URL off the port's schema reserves no read: the credits freed, the step failed linkedin_input_invalid, its enrollment ended, and the run goes on", async () => {
  const s = await sender();
  const step = await unknownLead(s, "off-schema-url");
  const linkedinUrl = "http://www.linkedin.com/in/off-schema-url";
  await app.person.update({ where: { id: step.personId }, data: { linkedinUrl } });
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  assert.deepEqual(callsOf("getProfile"), []);
  assert.deepEqual(await readCounts(s.accountId), { reserved: 0, committed: 0, actions: 0 });
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.errorCode], ["failed", "linkedin_input_invalid"]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  const { status, exitReason, exitDetail } = await app.enrollment.findUniqueOrThrow({
    where: { id: step.enrollmentId },
  });
  assert.deepEqual(
    [status, exitReason, exitDetail],
    ["exited", "send_refused", "linkedin_input_invalid"],
  );
});

test("linkedin's profile read failing on every attempt gets linkedin's three, not the worker's five: no answer, the read released, the credits freed, the step waiting member_ref_unknown", async () => {
  const s = await sender();
  const step = await unknownLead(s, "read-fails");
  seedProfile(step);
  const attempts: number[] = [];
  const failing: Wrap = () => async (_input, context) => {
    attempts.push(context.attempt);
    throw new Error("the profile read failed");
  };
  const { result } = await s.send({ linkedin_read_profile: failing });
  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
  assert.deepEqual(attempts, [1, 2, 3]);
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.errorCode], ["scheduled", "member_ref_unknown"]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await readCounts(s.accountId), { reserved: 0, committed: 0, actions: 0 });
});

test("useGateFreshMs is refused in any environment but test", () => {
  const script = `const { useGateFreshMs } = await import(${JSON.stringify(campaignsTesting)});\nuseGateFreshMs(1);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { APP_ENV: "development" },
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /useGateFreshMs: only under APP_ENV=test/);
});
