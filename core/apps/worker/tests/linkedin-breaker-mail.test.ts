// The fleet breaker's mail to the operator on the worker (beta-p6-030; core/modules/linkedin/README.md
// "Health"), on the fakes, a schema of the slice's database and its Temporal, the app-mail fake set
// before the providers load (the send fixture sets the others): a send's restriction trips the
// breaker, and its linkedin.invites_paused, delivered by the outbox, starts linkedin_notify for the
// operator, which mails LINKEDIN_ALERT_EMAIL once, with the ids, the trigger, the time and the reopen
// command and nothing of the account's or the person's, and sets the marker; a second warning trips
// nothing more; delivered again it starts no second run, and the activity run again after the marker
// sends nothing. With the address empty the breaker still trips, the run answers no_address, and the
// worker logs linkedin_alert_email_missing with the event's id. It lives here: a module never imports
// a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Sender } from "./fixtures/linkedin-send.ts";

process.env.PROVIDER_APP_MAIL = "fake";

const send = await import("./fixtures/linkedin-send.ts");
const { db, fake, linkedin, sender } = send;
const { NativeConnection, Worker } = await import("@temporalio/worker");
const { bindWorkflowStarter, collectLogs, createLogger } = await import("@whytide/platform");
const { appMailPort, getAdapter } = await import("@whytide/providers");
const { hostActivity } = await import("../src/activities.ts");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { startOutboxLoop } = await import("../src/outbox.ts");
const { workflowStarter } = await import("../src/starter.ts");
const { IDENTITY, metricSinks, workflowBundle } = await import("../src/temporal.ts");
const { withTestWorkflowEnvironment } = await import("../testing/index.ts");

send.useSendTests();
const env = withTestWorkflowEnvironment();
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const loaded = await loadModules(moduleLoaders.filter(({ name }) => name === "linkedin"));
await startModules(loaded, log);
/** The app-mail fake's helpers, which the bound adapter keeps (providers/app-mail/README.md). */
type AppMailFake = { sent(): readonly { to: string; subject: string; text: string }[] };
const mails = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;
const OPERATOR = "ops@whytide.test";
const operatorMails = () => mails.sent().filter((mail) => mail.to === OPERATOR);
const TRIPPED = "linkedin.invites_paused";
/** The account's label, the owner's own words: never in the operator's mail. */
const LABEL = "Ada Lovelace's sales account";

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
  linkedin.useAlertEmail(undefined);
  unbind?.();
  worker?.shutdown();
  await running;
  await connection?.close();
});

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

/** A send of the account's, an invite unless told, refused for `code` (`details` the error's): its step. */
async function failedSend(
  a: Sender,
  code: string,
  details?: Record<string, unknown>,
  actionType: "invite" | "message" = "invite",
) {
  const step = await a.step(actionType);
  fake.failNext(code as never, details);
  const call = await a.call(`linkedin_send_${actionType}`, step.input());
  assert.equal((call as { refused?: string }).refused, code);
  return step;
}

/** The account's only health event. */
async function warningOf(a: Sender) {
  const [event, ...more] = await db().senderHealthEvent.findMany({
    where: { senderId: a.accountId },
  });
  assert.ok(event);
  assert.equal(more.length, 0);
  return event;
}

/** The operator's linkedin_notify run for the event, once the outbox has started it: its result. */
async function notified(a: Sender, healthEventId: string) {
  const id = `linkedin.notify:${a.workspaceId}:${healthEventId}:operator`;
  const handle = env.client.workflow.getHandle(id);
  await until(() => handle.describe().catch(() => null));
  return { handle, result: await handle.result() };
}

test("a send's restriction trips the breaker, and its linkedin.invites_paused mails the operator once through linkedin_notify: the ids, the trigger, the time and the reopen command, nothing of the account's or the person's, the marker set; a second account's warning mails nothing more; delivered again it starts no second run, and the activity run again after the marker sends nothing", async () => {
  linkedin.useAlertEmail(OPERATOR);
  const outbox = startOutboxLoop(db(), log);
  try {
    const a = await sender();
    await db().senderAccount.update({ where: { id: a.accountId }, data: { label: LABEL } });
    const step = await failedSend(a, "linkedin_limit_reached");
    const event = await warningOf(a);
    const { handle, result } = await notified(a, event.id);
    assert.deepEqual(result, { sent: true });
    const [mail, ...more] = operatorMails();
    assert.ok(mail);
    assert.equal(more.length, 0, "one mail");
    assert.equal(
      mail.subject,
      "Whytide paused the connection requests of every LinkedIn account on the instance",
    );
    assert.match(mail.text, /^LinkedIn restricted a LinkedIn account on this Whytide instance/);
    for (const line of [
      `Workspace: ${a.workspaceId}`,
      `Account: ${a.accountId}`,
      "Trigger: limit_reached",
      "breaker reopen --operator your-name",
    ]) {
      assert.ok(mail.text.includes(line), line);
    }
    assert.match(mail.text, /Time: Thursday, October 22, 2026 at 10:00:00\sAM UTC/);
    const kept = [a.ref, "Ada", step.memberRef, step.personId, step.stepExecutionId];
    for (const value of kept) assert.ok(!`${mail.subject}\n${mail.text}`.includes(value), value);
    assert.doesNotMatch(mail.text, /https?:\/\//, "no link");
    const marked = await db().senderHealthEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.ok(marked.operatorNotifiedAt instanceof Date, "operator_notified_at is set");

    const b = await sender();
    // Its message: the trip refuses every account's invites.
    await failedSend(b, "linkedin_account_disconnected", { reason: "checkpoint" }, "message");
    const tripped = await db().outboxEntry.findMany({ where: { eventName: TRIPPED } });
    assert.deepEqual(
      tripped.map((entry) => entry.payload),
      [{ sender_account_id: a.accountId, health_event_id: event.id }],
      "one trip",
    );

    const [entry] = tripped;
    assert.ok(entry);
    const { runId } = await handle.describe();
    await db().outboxEntry.update({ where: { id: entry.id }, data: { deliveredAt: null } });
    await until(async () => {
      return (await db().outboxEntry.findUniqueOrThrow({ where: { id: entry.id } })).deliveredAt;
    });
    assert.equal((await handle.describe()).runId, runId, "the same run, none after it");
    const input = { workspaceId: a.workspaceId, healthEventId: event.id, recipient: "operator" };
    const already = { sent: false, reason: "already_sent" };
    assert.deepEqual(await a.call("linkedin_mail_health", input), already);
    assert.equal(operatorMails().length, 1, "still one mail");
  } finally {
    await outbox.stop();
  }
});

test("with LINKEDIN_ALERT_EMAIL empty the breaker still trips: the operator's run answers no_address, the worker logs linkedin_alert_email_missing with the event's id, no mail goes and no marker is set", async () => {
  linkedin.useAlertEmail(null);
  const before = mails.sent().length;
  const outbox = startOutboxLoop(db(), log);
  try {
    const a = await sender();
    await failedSend(a, "linkedin_limit_reached");
    const event = await warningOf(a);
    const { result } = await notified(a, event.id);
    assert.deepEqual(result, { sent: false, reason: "no_address" });
    const row = await db().linkedinPlatformControl.findFirstOrThrow();
    assert.deepEqual([row.invitesPaused, row.invitesPausedReason], [true, "limit_reached"]);
    const lines = logs.lines().filter((line) => line.code === "linkedin_alert_email_missing");
    assert.deepEqual(
      lines.map((line) => [line.level, line.health_event_id]),
      [["warn", event.id]],
    );
    const unmarked = await db().senderHealthEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(unmarked.operatorNotifiedAt, null, "no marker: no mail went");
    const owner = `linkedin.notify:${a.workspaceId}:${event.id}:owner`;
    await until(() =>
      env.client.workflow
        .getHandle(owner)
        .describe()
        .catch(() => null),
    );
    await env.client.workflow.getHandle(owner).result();
    assert.equal(mails.sent().length, before, "no mail: the owner is no user either");
  } finally {
    await outbox.stop();
  }
});
