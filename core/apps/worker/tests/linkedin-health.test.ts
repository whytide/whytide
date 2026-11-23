// linkedin's account health on the worker (beta-p6-010; core/modules/linkedin/README.md "Health"), on
// the fakes, a schema of the slice's database and its Temporal, the app-mail fake set before the
// providers load (the send fixture sets the others): each typed error of a send and of a read, its
// health in the run that logs it (A.19's account column); the third rate limit or provider error in
// an hour; refreshStatus's crossings; and the owner's mail, through the outbox, linkedin's subscriber
// and linkedin_notify on a worker of the test's queue: one mail per pausing event, none more for a
// second delivery or a retry after the marker, none for a disabled owner, its subject by the trigger,
// and its history replays.
// A signals run on a paused account: signals-run.test.ts. It lives here: a module never imports a
// host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Sender } from "./fixtures/linkedin-send.ts";

process.env.PROVIDER_APP_MAIL = "fake";
const ORIGIN = "https://app.whytide.test";
process.env.APP_PUBLIC_ORIGIN = ORIGIN;

const send = await import("./fixtures/linkedin-send.ts");
const { db, fake, later, linkedin, quota, reservationOf, reserveSend, rowsOf, sender } = send;
const { NativeConnection, Worker } = await import("@temporalio/worker");
const { bindWorkflowStarter, collectLogs, createLogger, newId } = await import("@whytide/platform");
const { appMailPort, getAdapter } = await import("@whytide/providers");
const { hostActivity } = await import("../src/activities.ts");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { startOutboxLoop } = await import("../src/outbox.ts");
const { workflowStarter } = await import("../src/starter.ts");
const { IDENTITY, metricSinks, workflowBundle } = await import("../src/temporal.ts");
const { replayHistories, withTestWorkflowEnvironment } = await import("../testing/index.ts");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const tenancy: TenancyTesting = await import(
  new URL("../../../modules/tenancy/dist/testing/index.js", import.meta.url).href
);

send.useSendTests();
const env = withTestWorkflowEnvironment();
const log = createLogger({ destination: collectLogs().destination });
const loaded = await loadModules(moduleLoaders.filter(({ name }) => name === "linkedin"));
/** The app-mail fake's helpers, which the bound adapter keeps (providers/app-mail/README.md). */
type AppMailFake = { sent(): readonly { to: string; subject: string; text: string }[] };
const mails = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;
const mailsTo = (to: string) => mails.sent().filter((mail) => mail.to === to);
const HISTORY = fileURLToPath(
  new URL(
    "../../../modules/linkedin/workflows/__histories__/linkedin_notify.json",
    import.meta.url,
  ),
);
/** COOLDOWN_HOURS, 72, after the fixture's clock (Thursday 22 October 2026, 10:00 UTC). */
const COOLDOWN_END = new Date(send.THURSDAY.getTime() + 72 * 3_600_000);
/** The start of the next working day after that Thursday, in UTC, the accounts' zone. */
const FRIDAY = new Date("2026-10-23T00:00:00Z");
const PAUSED = "linkedin.account_paused";

/** linkedin's workflows on a worker of the test's queue, and the host's starter on that queue. */
let connection: import("@temporalio/worker").NativeConnection | undefined;
let worker: import("@temporalio/worker").Worker | undefined;
let running: Promise<void> | undefined;
let unbind: (() => void) | undefined;
before(async () => {
  const activities = Object.fromEntries(
    [...loaded.activities].map(([name, definition]) => {
      return [name, hostActivity(name, definition, { client: db(), log })];
    }),
  );
  connection = await NativeConnection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  worker = await Worker.create({
    connection,
    namespace: env.namespace,
    taskQueue: env.taskQueue,
    identity: IDENTITY,
    workflowBundle: await workflowBundle(env.workflowsPath),
    activities,
    sinks: metricSinks(),
  });
  running = worker.run();
  unbind = bindWorkflowStarter(workflowStarter(env.client, loaded.workflows, env.taskQueue));
});
after(async () => {
  unbind?.();
  worker?.shutdown();
  await running;
  await connection?.close();
});

/** The account's health, its events as `from>to:trigger`, and the events linkedin.account_paused names. */
async function healthOf(account: { workspaceId: string; accountId: string }) {
  const row = await db().senderAccount.findUniqueOrThrow({ where: { id: account.accountId } });
  const rows = await db().senderHealthEvent.findMany({
    where: { senderId: account.accountId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const paused = await db().outboxEntry.findMany({
    where: { workspaceId: account.workspaceId, eventName: PAUSED },
    orderBy: { id: "asc" },
  });
  return {
    state: row.healthState,
    pausedUntil: row.pausedUntil,
    retryAt: row.retryAt,
    events: rows.map((event) => `${event.fromState}>${event.toState}:${event.trigger}`),
    rows,
    announced: paused.map(
      (entry) => (entry.payload as { health_event_id: string }).health_event_id,
    ),
  };
}

/** A sender whose owner is a user, a Member of its workspace, as a connect leaves it: the mail's recipient. */
async function owned() {
  const a = await sender();
  const { id: userId, email } = await tenancy.createUser();
  await tenancy.createMembership({ userId, workspaceId: a.workspaceId, role: "Member" });
  await db().senderAccount.update({ where: { id: a.accountId }, data: { ownerUserId: userId } });
  return { ...a, userId, email };
}

/** A send of the account's refused for `code` (`details` the error's): its step. */
async function failedSend(a: Sender, code: string, details?: Record<string, unknown>) {
  const step = await a.step("invite");
  fake.failNext(code as never, details);
  const answer = (await a.call("linkedin_send_invite", step.input())) as { refused?: string };
  assert.equal(answer.refused, code);
  return step;
}

/** A post the fake knows, with no engager: its URL, an activity's number as LinkedIn's. */
let posts = 0;
function postOf(): string {
  posts += 1;
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${Date.now()}${posts}`;
  fake.seedPost(postUrl, []);
  return postUrl;
}

/** The first truthy answer of `probe`, asked every 50 ms for 30 seconds at most. */
async function until<T>(probe: () => Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 30 seconds");
    await sleep(50);
  }
}

test("a send's warnings give A.19's health in the run that logs them, with their event and linkedin.account_paused, the account's other open sends released and the next send refused account_paused; a refused or not-found send changes none", async () => {
  const warnings = [
    ["linkedin_limit_reached", undefined, "restricted", "limit_reached"],
    ["linkedin_account_disconnected", { reason: "checkpoint" }, "checkpoint", "checkpoint"],
    ["linkedin_account_disconnected", { reason: "restricted" }, "restricted", "limit_reached"],
    [
      "linkedin_account_disconnected",
      { reason: "credentials_required" },
      "disconnected",
      "session_invalid",
    ],
    ["linkedin_account_disconnected", undefined, "disconnected", "session_invalid"],
  ] as const;
  for (const [code, details, state, trigger] of warnings) {
    const label = `${code} ${details?.reason ?? ""}`;
    // A restriction or a checkpoint trips the fleet breaker (linkedin-breaker-mail.test.ts): lifted
    // as the operator's reopen leaves it, so that each case's invite reserves.
    await linkedin.setPlatformControls({ invitesPaused: false });
    const a = await sender();
    const open = await a.step("message");
    const step = await failedSend(a, code, details);
    assert.deepEqual(await rowsOf(step.stepExecutionId), [`invite:${code}`], label);
    const health = await healthOf(a);
    const until = state === "disconnected" ? null : COOLDOWN_END;
    assert.deepEqual(
      [health.state, health.pausedUntil, health.events],
      [state, until, [`healthy>${state}:${trigger}`]],
      label,
    );
    assert.deepEqual(health.announced, [health.rows[0]?.id], label);
    // The error map's slot (a limit counts the send, a disconnect frees it); the other one released.
    const own = code === "linkedin_limit_reached" ? "committed" : "released";
    assert.equal((await reservationOf(step.reservationId)).status, own, label);
    assert.equal((await reservationOf(open.reservationId)).status, "released", label);
    const next = { accountId: a.accountId, actionType: "message" as const, idempotencyKey: label };
    const refused = { refused: "account_paused", retryAt: null };
    assert.deepEqual(await a.run(() => reserveSend(next)), refused, label);
  }
  await linkedin.setPlatformControls({ invitesPaused: false });
  for (const code of ["linkedin_send_refused", "linkedin_not_found"]) {
    const a = await sender();
    await failedSend(a, code);
    const health = await healthOf(a);
    assert.deepEqual([health.state, health.events, health.announced], ["healthy", [], []], code);
  }
});

test("a read's warnings: the account checkpointed or restricted on LinkedIn's side makes the engagers' read refused and the account paused in the read's run; LinkedIn's limit on a profile's read throws, retried, and restricts it; the next read is refused account_paused", async () => {
  for (const [status, trigger] of [
    ["checkpoint", "checkpoint"],
    ["restricted", "limit_reached"],
  ] as const) {
    const a = await sender();
    const postUrl = postOf();
    fake.emitAccountStatus(a.ref, status); // the vendor's side only: no webhook reaches the app
    const rawKey = `raw/linkedin/health/${randomUUID()}.json`;
    const input = {
      workspaceId: a.workspaceId,
      accountId: a.accountId,
      postUrl,
      limit: 10,
      rawKey,
    };
    const refused = { refused: "linkedin_account_disconnected" };
    assert.deepEqual(await a.call("linkedin_read_post_engagers", input), refused, status);
    assert.deepEqual(await rowsOf(postUrl), ["read_engagers:linkedin_account_disconnected"]);
    const health = await healthOf(a);
    assert.deepEqual(
      [health.state, health.pausedUntil, health.events, health.announced.length],
      [status, COOLDOWN_END, [`healthy>${status}:${trigger}`], 1],
    );
    const read = { accountId: a.accountId, count: 1, kind: "read_profile" } as const;
    const paused = { refused: "account_paused", retryAt: null };
    assert.deepEqual(await a.run(() => quota.reserveReads(read)), paused, status);
  }

  const b = await sender();
  const requestKey = await b.writeFile({ profileUrl: "https://www.linkedin.com/in/health-test" });
  const rawKey = `raw/linkedin/health/${randomUUID()}.json`;
  const profile = { workspaceId: b.workspaceId, accountId: b.accountId, requestKey, rawKey };
  fake.failNext("linkedin_limit_reached");
  const limited = { code: "linkedin_limit_reached" };
  await assert.rejects(b.call("linkedin_read_profile", profile), limited);
  const health = await healthOf(b);
  assert.deepEqual(
    [health.state, health.events],
    ["restricted", ["healthy>restricted:limit_reached"]],
  );
});

test("the third rate limit or provider error in an hour, sends' and a read's, pauses the account until its next working day: retry_at Friday 00:00 in its zone, one event rate_limit_errors with the count, linkedin.account_paused, the health as it was; two do nothing", async () => {
  const a = await sender();
  const first = await a.step("invite");
  fake.failNext("linkedin_rate_limited");
  await a.call("linkedin_send_invite", first.input());
  later(61_000); // past the rate limit's retryAfterSec
  const postUrl = postOf();
  const rawKey = `raw/linkedin/health/${randomUUID()}.json`;
  const read = { workspaceId: a.workspaceId, accountId: a.accountId, postUrl, limit: 10, rawKey };
  fake.failNext("linkedin_rate_limited");
  const limited = { code: "linkedin_rate_limited" };
  await assert.rejects(a.call("linkedin_read_post_engagers", read), limited);
  const two = await healthOf(a);
  assert.deepEqual([two.events, two.announced], [[], []], "two errors");

  later(61_000);
  const third = await a.step("message");
  fake.failNext("linkedin_provider_error");
  const answer = await a.call("linkedin_send_message", third.input());
  assert.deepEqual(answer, { refused: "linkedin_provider_error" });
  const health = await healthOf(a);
  assert.deepEqual(
    [health.state, health.pausedUntil, health.retryAt, health.events],
    ["healthy", null, FRIDAY, ["healthy>healthy:rate_limit_errors"]],
  );
  const [event] = health.rows;
  assert.deepEqual(
    [event?.metrics, event?.pausedUntil, event?.automaticAction, event?.ackRequired],
    [{ errors: 3, windowMinutes: 60 }, FRIDAY, "paused_all_actions", false],
  );
  assert.deepEqual(health.announced, [event?.id]);
  const next = { accountId: a.accountId, actionType: "invite" as const, idempotencyKey: "next" };
  const refused = { refused: "rate_limited", retryAt: FRIDAY };
  assert.deepEqual(await a.run(() => reserveSend(next)), refused);
});

test("refreshStatus's crossings: LinkedIn's credentials_required, or an account it no longer knows, is a lost session (disconnected, session_invalid, linkedin.account_paused); its connected again a reconnect (healthy, manual); a restricted account logged out and back in stays restricted", async () => {
  const a = await sender();
  const refresh = (b: Sender) =>
    b.call("linkedin_refresh_status", { workspaceId: b.workspaceId, accountId: b.accountId });
  fake.emitWebhook("account.credentials_required", a.ref); // the vendor's side only
  assert.equal(((await refresh(a)) as { status: string }).status, "credentials_required");
  const lost = await healthOf(a);
  assert.deepEqual(
    [lost.state, lost.events, lost.announced.length],
    ["disconnected", ["healthy>disconnected:session_invalid"], 1],
  );
  fake.emitWebhook("account.connected", a.ref);
  assert.equal(((await refresh(a)) as { status: string }).status, "connected");
  const back = await healthOf(a);
  const events = ["healthy>disconnected:session_invalid", "disconnected>healthy:manual"];
  assert.deepEqual([back.state, back.events, back.announced.length], ["healthy", events, 1]);

  const gone = await sender();
  fake.failNext("linkedin_not_found");
  assert.equal(((await refresh(gone)) as { status: string }).status, "disconnected");
  const unknown = await healthOf(gone);
  assert.deepEqual(
    [unknown.state, unknown.events],
    ["disconnected", ["healthy>disconnected:session_invalid"]],
  );

  const kept = await sender();
  await linkedin.setHealth(kept.accountId, "restricted", { pausedUntil: COOLDOWN_END });
  fake.emitWebhook("account.disconnected", kept.ref);
  assert.equal(((await refresh(kept)) as { status: string }).status, "disconnected");
  fake.emitWebhook("account.connected", kept.ref);
  assert.equal(((await refresh(kept)) as { status: string }).status, "connected");
  const restricted = await healthOf(kept);
  assert.deepEqual(
    [restricted.state, restricted.pausedUntil, restricted.events],
    ["restricted", COOLDOWN_END, []],
  );
});

test("the owner's mail: a warning's linkedin.account_paused, delivered by the outbox, starts linkedin_notify, which mails the account's owner once, with the cool-down's end and the link, no person data, and sets the marker; delivered again it starts no second run, and the activity run again after the marker sends nothing; a disabled owner gets none, and the workflow ends without an error", async () => {
  const outbox = startOutboxLoop(db(), log);
  try {
    const a = await owned();
    const step = await failedSend(a, "linkedin_limit_reached");
    const [event] = (await healthOf(a)).rows;
    assert.ok(event);
    const id = `linkedin.notify:${a.workspaceId}:${event.id}:owner`;
    const handle = env.client.workflow.getHandle(id);
    await until(() => handle.describe().catch(() => null));
    assert.deepEqual(await handle.result(), { sent: true });
    const [mail, ...more] = mailsTo(a.email);
    assert.ok(mail);
    assert.equal(more.length, 0, "one mail");
    assert.equal(mail.subject, "Whytide paused your LinkedIn account");
    assert.match(mail.text, /^LinkedIn restricted your LinkedIn account/);
    assert.match(
      mail.text,
      /until Sunday, October 25, 2026 at 10:00\s?AM \(UTC\), the end of its cool-down/,
    );
    const link = `${ORIGIN}/w/${a.workspaceId}/linkedin`;
    assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [link], "the LinkedIn page's link alone");
    const kept = [a.ref, a.accountId, step.memberRef, step.personId, step.stepExecutionId];
    for (const value of kept) assert.ok(!`${mail.subject}\n${mail.text}`.includes(value), value);
    const marked = await db().senderHealthEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.ok(marked.ownerNotifiedAt instanceof Date, "owner_notified_at is set");

    const [entry] = await db().outboxEntry.findMany({
      where: { workspaceId: a.workspaceId, eventName: PAUSED },
    });
    assert.ok(entry);
    const { runId } = await handle.describe();
    await db().outboxEntry.update({ where: { id: entry.id }, data: { deliveredAt: null } });
    await until(async () => {
      return (await db().outboxEntry.findUniqueOrThrow({ where: { id: entry.id } })).deliveredAt;
    });
    assert.equal((await handle.describe()).runId, runId, "the same run, none after it");
    const input = { workspaceId: a.workspaceId, healthEventId: event.id, recipient: "owner" };
    const already = { sent: false, reason: "already_sent" };
    assert.deepEqual(await a.call("linkedin_mail_health", input), already);
    assert.equal(mailsTo(a.email).length, 1, "still one mail");

    const b = await owned();
    await db().user.update({ where: { id: b.userId }, data: { disabledAt: new Date() } });
    await linkedin.setPlatformControls({ invitesPaused: false }); // the breaker a's limit tripped
    await failedSend(b, "linkedin_account_disconnected", { reason: "checkpoint" });
    const [disabled] = (await healthOf(b)).rows;
    assert.ok(disabled);
    const notify = env.client.workflow.getHandle(
      `linkedin.notify:${b.workspaceId}:${disabled.id}:owner`,
    );
    await until(() => notify.describe().catch(() => null));
    assert.deepEqual(await notify.result(), { sent: false, reason: "owner_unavailable" });
    assert.deepEqual(mailsTo(b.email), [], "no mail");
    const unmarked = await db().senderHealthEvent.findUniqueOrThrow({ where: { id: disabled.id } });
    assert.equal(unmarked.ownerNotifiedAt, null, "no marker: no mail went");
  } finally {
    await outbox.stop();
  }
});

test("linkedin_notify run by itself mails once, the third error's words with the next working day: the run whose history is recorded", async (t) => {
  const a = await owned();
  for (const code of [
    "linkedin_rate_limited",
    "linkedin_rate_limited",
    "linkedin_provider_error",
  ]) {
    await failedSend(a, code);
    later(61_000);
  }
  const [event] = (await healthOf(a)).rows;
  assert.equal(event?.trigger, "rate_limit_errors");
  const workflowId = `linkedin_notify-${randomUUID()}`;
  const input = { workspaceId: a.workspaceId, healthEventId: event?.id, recipient: "owner" };
  const result = await env.client.workflow.execute("linkedin_notify", {
    args: [input],
    taskQueue: env.taskQueue,
    workflowId,
  });
  assert.deepEqual(result, { sent: true });
  // The run whose history is workflows/__histories__/linkedin_notify.json (history:record).
  t.diagnostic(`linkedin_notify ran as ${workflowId}`);
  const [mail] = mailsTo(a.email);
  assert.match(mail?.text ?? "", /^LinkedIn answered your LinkedIn account with errors again/);
  assert.match(mail?.text ?? "", /until Friday, October 23, 2026 at 12:00\s?AM \(UTC\)/);
});

test("the owner's mail's subject follows the trigger: an at_risk account's third error says the account is paused, as its body does; acceptance_rate says its connection requests", async () => {
  const a = await owned();
  await linkedin.setHealth(a.accountId, "at_risk");
  for (const code of [
    "linkedin_rate_limited",
    "linkedin_rate_limited",
    "linkedin_provider_error",
  ]) {
    const step = await a.step("message"); // an at_risk account's invites are refused
    fake.failNext(code as never);
    const answer = (await a.call("linkedin_send_message", step.input())) as { refused?: string };
    assert.equal(answer.refused, code);
    later(61_000);
  }
  const [third] = (await healthOf(a)).rows;
  assert.deepEqual([third?.toState, third?.trigger], ["at_risk", "rate_limit_errors"]);
  const rate = await db().senderHealthEvent.create({
    data: {
      id: newId("she"),
      workspaceId: a.workspaceId,
      senderId: a.accountId,
      fromState: "healthy",
      toState: "at_risk",
      trigger: "acceptance_rate",
      metrics: {},
      automaticAction: "paused_invites",
      ackRequired: false,
      createdAt: send.THURSDAY,
    },
  });
  for (const event of [third, rate]) {
    const input = { workspaceId: a.workspaceId, healthEventId: event?.id, recipient: "owner" };
    assert.deepEqual(await a.call("linkedin_mail_health", input), { sent: true });
  }
  assert.deepEqual(
    mailsTo(a.email).map((mail) => mail.subject),
    [
      "Whytide paused your LinkedIn account",
      "Whytide paused the connection requests of your LinkedIn account",
    ],
  );
});

test("a removed member gets no mail (gamma-p6-070): the account's owner no longer an active member of the workspace answers owner_unavailable, sends nothing and sets no marker; an active member's event of the same kind is mailed", async () => {
  /** A health event of the account's, as a warning writes it: linkedin_mail_health's input. */
  const eventOf = async (a: Sender) => {
    const event = await db().senderHealthEvent.create({
      data: {
        id: newId("she"),
        workspaceId: a.workspaceId,
        senderId: a.accountId,
        fromState: "healthy",
        toState: "at_risk",
        trigger: "acceptance_rate",
        metrics: {},
        automaticAction: "paused_invites",
        ackRequired: false,
        createdAt: send.THURSDAY,
      },
    });
    return { workspaceId: a.workspaceId, healthEventId: event.id, recipient: "owner" };
  };
  const removed = await owned();
  const where = { workspaceId: removed.workspaceId, role: "Owner" as const };
  const { userId: removedBy } = await db().membership.findFirstOrThrow({ where });
  await db().membership.updateMany({
    where: { workspaceId: removed.workspaceId, userId: removed.userId },
    data: { removedAt: new Date(), removedBy },
  });
  const input = await eventOf(removed);
  const unavailable = { sent: false, reason: "owner_unavailable" };
  assert.deepEqual(await removed.call("linkedin_mail_health", input), unavailable);
  assert.deepEqual(mailsTo(removed.email), [], "no mail");
  const marked = { where: { id: input.healthEventId } };
  const row = await db().senderHealthEvent.findUniqueOrThrow(marked);
  assert.equal(row.ownerNotifiedAt, null, "no marker: no mail went");

  const active = await owned();
  const mailed = await active.call("linkedin_mail_health", await eventOf(active));
  assert.deepEqual(mailed, { sent: true });
  assert.equal(mailsTo(active.email).length, 1, "the active owner's mail");
});

test("the recorded history of linkedin_notify replays", () =>
  replayHistories(env.workflowsPath, [HISTORY]));
