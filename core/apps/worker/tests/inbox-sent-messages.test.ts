// inbox's store of the account's own messages (beta-p5-020; core/modules/inbox/README.md "The
// platform's own messages", docs/flows.md), end to end on the fakes, on the slice's Temporal and a
// schema of its database: campaigns' sender sends a step through the LinkedIn fake
// (fixtures/campaigns-sender.ts); the outbox delivers campaigns.step_sent to inbox's subscriber, one
// pass of the worker's loop at a time; linkedin's receiver keeps the provider's report of the
// account's message (the parsed webhook: the fake's own webhook names no ref of a message it sent),
// and the inbox_store_message its event starts runs on Temporal, inbox's activity through the host's
// wrapper. A message step sent, then its echo; the echo first, then the step's event; a redelivery
// of each; a message the tester typed on the platform's thread, whose touch the gate reads
// (touched_today); an invite step. No provider ref and no text in an event, a workflow input, an
// activity result or a log line. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import {
  app,
  contacts,
  DAY_MS,
  logs,
  now,
  OWNER,
  type Sender,
  sender,
  skip,
  starts,
  useSenderTests,
} from "./fixtures/campaigns-sender.ts";

const { createOutboxStore, withTenant } = await import("@whytide/db");
const platform = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { runWorkflow } = await import("../testing/index.ts");
const built = (file: string) => import(new URL(`../../../modules/${file}`, import.meta.url).href);
const { receive } = await built("linkedin/dist/domain/receiver/receive.js");
const { checkGate } = await built("campaigns/dist/domain/gate/gate.js");

useSenderTests();
const inbox = await loadModules(moduleLoaders.filter(({ name }) => name === "inbox"));
const log = platform.createLogger({ destination: logs.destination });
before(() => startModules(inbox, log));

const TEXT = "Noor, how does your team review its pipeline each week?";
const TYPED = "Noor, typing this one myself: does Friday at 3 work?";
const UNSTORED = { stored: false, held: false, optOut: false };
type Refs = { readonly chatRef: string; readonly messageRef: string };
type Run = { readonly input: unknown; readonly result: Record<string, unknown> };
/** campaigns' gate answer, as far as these tests read it. */
type Gate = {
  readonly pass: boolean;
  readonly reason?: string;
  readonly checks: { readonly touch?: { readonly lastTouchAt: string | null } };
};

/** One pass of the worker's delivery, each handler in a tenant run of the event's workspace. */
async function deliver(): Promise<void> {
  const principal = platform.servicePrincipal("worker");
  const report = await platform.deliverPending({
    store: createOutboxStore(app),
    runInTenant: (workspaceId, fn) => withTenant({ workspaceId, principal }, fn, { client: app }),
    log,
  });
  assert.deepEqual([report.retried, report.dead], [0, 0], "every event delivered");
}

/** The workspace's events of that name delivered again, as the outbox's at-least-once does. */
async function redeliver(workspaceId: string, eventName: string): Promise<void> {
  const where = { workspaceId, eventName };
  assert.ok((await app.outboxEntry.updateMany({ where, data: { deliveredAt: null } })).count > 0);
  await deliver();
}

/** Each inbox_store_message a delivery started, run on Temporal: its input and its result. */
async function storeRuns(): Promise<Run[]> {
  const activities = Object.fromEntries(
    [...inbox.activities].map(([name, definition]) => [
      name,
      hostActivity(name, definition, { client: app, log }),
    ]),
  );
  const runs: Run[] = [];
  for (const { workflow, input } of starts.splice(0)) {
    if (workflow !== "inbox_store_message") continue;
    const result = await runWorkflow<Record<string, unknown>>(workflow, input, { activities });
    runs.push({ input, result });
  }
  return runs;
}

/** The provider's refs of the account's last message to the person, as linkedin keeps them. */
async function refsOf(s: Sender, personId: string): Promise<Refs> {
  const where = { senderAccountId: s.accountId, personId };
  const row = await app.senderOutreach.findFirstOrThrow({ where });
  assert.ok(row.providerChatRef && row.lastMessageRef);
  return { chatRef: row.providerChatRef, messageRef: row.lastMessageRef };
}

/** The account's message in the chat, as the provider reports it, through linkedin's receiver. */
async function report(
  s: Sender,
  memberRef: string,
  message: Refs & { text: string; sentAt: Date },
) {
  const event = {
    ...{ kind: "message.received", providerAccountRef: s.ref, eventKey: message.messageRef },
    ...{ chatRef: message.chatRef, messageRef: message.messageRef, fromAccount: true },
    ...{ senderMemberRef: "member-self", attendeeMemberRefs: [memberRef] },
    ...{ text: message.text, sentAt: message.sentAt },
  };
  await receive("fake", event, [{ id: s.accountId, workspaceId: s.workspaceId }]);
}

const messagesOf = (personId: string) =>
  app.message.findMany({ where: { personId }, orderBy: { sentAt: "asc" } });
const eventsOf = (workspaceId: string, eventName: string) =>
  app.outboxEntry.count({ where: { workspaceId, eventName } });

/** No text and no provider ref in the workspace's events, the runs' inputs and results, or a log line. */
async function noTextNoRefs(workspaceId: string, secrets: readonly string[], runs: Run[]) {
  const events = await app.outboxEntry.findMany({ where: { workspaceId } });
  const seen = [...events.map(({ payload }) => JSON.stringify(payload)), ...logs.raw];
  seen.push(...runs.map((run) => JSON.stringify(run)));
  for (const text of seen) {
    for (const secret of secrets) assert.ok(!text.includes(secret), "a text or a provider ref");
  }
}

test("a message step sent, then its echo: one outbound message, the campaign's, with the approved text, the approver and the approval time; a redelivery of either changes nothing", async () => {
  const s = await sender();
  const step = await s.ready("sent-then-echo", "message_1", TEXT);
  assert.equal((await s.send()).result.sent, 1);

  await deliver();

  const [message, ...more] = await messagesOf(step.personId);
  assert.ok(message);
  assert.deepEqual(more, []);
  const sent = await app.stepExecution.findUniqueOrThrow({ where: { id: step.id } });
  const item = await app.approvalItem.findFirstOrThrow({ where: { stepExecutionId: step.id } });
  const refs = await refsOf(s, step.personId);
  assert.deepEqual(
    [message.direction, message.sentBy, message.stepExecutionId, message.body, message.sentAt],
    ["out", "campaign", step.id, TEXT, sent.executedAt],
  );
  assert.deepEqual(
    [message.approvedBy, message.approvedAt, message.providerMessageRef],
    [OWNER, item.decidedAt, refs.messageRef],
  );
  const thread = await app.thread.findUniqueOrThrow({ where: { id: message.threadId } });
  assert.deepEqual(
    [thread.providerThreadRef, thread.senderAccountId, thread.ownerUserId],
    [refs.chatRef, s.accountId, OWNER],
  );

  // The echo, a few seconds after the send: the platform's message, stored once.
  const echo = { ...refs, text: TEXT, sentAt: now() };
  await report(s, step.memberRef, echo);
  await deliver();
  const runs = await storeRuns();
  assert.deepEqual(
    runs.map(({ result }) => result),
    [UNSTORED],
  );
  assert.deepEqual(await messagesOf(step.personId), [message]);

  // Each again: the step's event from the outbox; the echo from the provider, which its receipt
  // ends, and its event from the outbox, whose run finds its file gone.
  await redeliver(s.workspaceId, "campaigns.step_sent");
  await report(s, step.memberRef, echo);
  assert.equal(await eventsOf(s.workspaceId, "linkedin.message_received"), 1);
  await redeliver(s.workspaceId, "linkedin.message_received");
  const again = await storeRuns();
  assert.deepEqual(
    again.map(({ result }) => result),
    [UNSTORED],
  );
  assert.deepEqual(await messagesOf(step.personId), [message]);
  assert.equal(await app.thread.count({ where: { personId: step.personId } }), 1);
  await noTextNoRefs(s.workspaceId, [TEXT, refs.chatRef, refs.messageRef], [...runs, ...again]);
});

test("the echo first, then the step's event: the user's row becomes the campaign's, one row; the step's event again changes nothing", async () => {
  const s = await sender();
  const step = await s.ready("echo-first", "message_1", TEXT);
  assert.equal((await s.send()).result.sent, 1);
  // The step's event waits while the echo is kept, delivered and stored.
  const held = { workspaceId: s.workspaceId, eventName: "campaigns.step_sent" };
  const later = new Date(Date.now() + DAY_MS);
  await app.outboxEntry.updateMany({ where: held, data: { nextAttemptAt: later } });
  const refs = await refsOf(s, step.personId);
  const echoAt = now();

  await report(s, step.memberRef, { ...refs, text: TEXT, sentAt: echoAt });
  await deliver();
  const runs = await storeRuns();

  assert.deepEqual(
    runs.map(({ result }) => result.stored),
    [true],
  );
  const [echoed] = await messagesOf(step.personId);
  assert.deepEqual([echoed?.sentBy, echoed?.stepExecutionId], ["user", null]);

  await app.outboxEntry.updateMany({ where: held, data: { nextAttemptAt: new Date() } });
  await deliver();

  const [message, ...more] = await messagesOf(step.personId);
  assert.ok(message);
  assert.deepEqual(more, []);
  const item = await app.approvalItem.findFirstOrThrow({ where: { stepExecutionId: step.id } });
  assert.equal(message.id, echoed?.id);
  assert.deepEqual(
    [message.sentBy, message.stepExecutionId, message.body, message.approvedBy],
    ["campaign", step.id, TEXT, OWNER],
  );
  assert.deepEqual(
    [message.approvedAt, message.providerMessageRef, message.sentAt],
    [item.decidedAt, refs.messageRef, echoAt],
  );
  await redeliver(s.workspaceId, "campaigns.step_sent");
  assert.deepEqual(await messagesOf(step.personId), [message]);
  await noTextNoRefs(s.workspaceId, [TEXT, refs.chatRef, refs.messageRef], runs);
});

test("a message the tester typed on the platform's thread: stored once as the user's; its touch makes the gate block a follow-up the same day (touched_today)", async () => {
  const s = await sender();
  const step = await s.ready("typed", "message_1", TEXT);
  assert.equal((await s.send()).result.sent, 1);
  await deliver();
  const refs = await refsOf(s, step.personId);
  // The next day: follow_up_1 approved and placed, which the gate passes, the send's touch a day old.
  skip(DAY_MS);
  const followUp = step.steps.follow_up_1 as string;
  await s.approve(followUp, "Noor, any thoughts on my last note?");
  await s.place(followUp);
  const gate = (): Promise<Gate> => s.run(() => checkGate(followUp, { at: now() }));
  assert.equal((await gate()).pass, true);

  // The tester writes on LinkedIn by hand, in the platform's chat.
  const typed = { chatRef: refs.chatRef, messageRef: `message-${randomUUID()}` };
  const typedAt = now();
  await report(s, step.memberRef, { ...typed, text: TYPED, sentAt: typedAt });
  await deliver();
  const runs = await storeRuns();
  await redeliver(s.workspaceId, "linkedin.message_received");
  runs.push(...(await storeRuns()));

  assert.deepEqual(
    runs.map(({ result }) => [result.stored, result.held]),
    [
      [true, false],
      [false, false],
    ],
  );
  const rows = await messagesOf(step.personId);
  assert.deepEqual(
    rows.map(({ sentBy, body, providerMessageRef }) => [sentBy, body, providerMessageRef]),
    [
      ["campaign", TEXT, refs.messageRef],
      ["user", TYPED, typed.messageRef],
    ],
  );
  assert.equal(new Set(rows.map(({ threadId }) => threadId)).size, 1, "the platform's thread");
  const touched: Date | null = await s.run(() => contacts.lastTouchAt(step.personId));
  assert.deepEqual(touched, typedAt);
  const blocked = await gate();
  assert.deepEqual([blocked.pass, blocked.reason], [false, "touched_today"]);
  assert.equal(blocked.checks.touch?.lastTouchAt, typedAt.toISOString());
  const secrets = [TEXT, TYPED, refs.chatRef, refs.messageRef, typed.messageRef];
  await noTextNoRefs(s.workspaceId, secrets, runs);
});

test("an invite step's send stores nothing in inbox", async () => {
  const s = await sender();
  const step = await s.ready("invite");
  assert.equal((await s.send()).result.sent, 1);

  await deliver();

  const sent = await app.outboxEntry.findFirstOrThrow({
    where: { workspaceId: s.workspaceId, eventName: "campaigns.step_sent" },
  });
  assert.deepEqual(sent.payload, {
    stepExecutionId: step.id,
    personId: step.personId,
    actionType: "invite",
  });
  assert.ok(sent.deliveredAt, "delivered");
  assert.equal(await app.thread.count({ where: { personId: step.personId } }), 0);
  assert.deepEqual(await messagesOf(step.personId), []);
});
