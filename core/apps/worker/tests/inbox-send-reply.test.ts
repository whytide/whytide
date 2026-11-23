// inbox's reply from a thread (gamma-p4-060; core/modules/inbox/README.md "Replies from the inbox",
// docs/flows.md "A reply from the inbox"), end to end on the fakes, on the slice's Temporal and a
// schema of its database: the owner's account the LinkedIn fake knows, sending open
// (fixtures/campaigns-sender.ts), a person who replied in the account's chat; the route's run as the
// owner (inbox's domain, the api being the api's test); the outbox delivers inbox.reply_requested to
// its subscriber, whose start runs here on Temporal, inbox's activities and linkedin's send activity
// and check through the host's wrapper. The send, once, its slot committed, the row sent with the
// provider's ref and time, and the echo storing no row; the send activity killed after the fake's
// call, then linkedin_check_sent, never a second call; the day's 200 actions used, refused at the
// reservation with nothing called; and a message of the person's no webhook brought, which the
// reply's read of the chat marks before its send, so campaigns' gate holds the next step. No text in
// an event, a workflow's input or result, its history, or a log line. It lives here: a module never
// imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import {
  app,
  DAY_MS,
  fake,
  historyOf,
  killedAfterSend,
  linkedin,
  logs,
  now,
  OWNER,
  type Sender,
  sender,
  starts,
  stepOf,
  useSenderTests,
  type Wrap,
} from "./fixtures/campaigns-sender.ts";

const { createOutboxStore, withTenant } = await import("@whytide/db");
const platform = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { runWorkflow } = await import("../testing/index.ts");
// inbox's and linkedin's code by their builds' paths, as the loader imports the modules.
const built = (file: string) => import(new URL(`../../../modules/${file}`, import.meta.url).href);
type Receive = typeof import("../../../modules/linkedin/dist/domain/receiver/receive.js");
type Linkedin = typeof import("../../../modules/linkedin/dist/index.js");
type Request = typeof import("../../../modules/inbox/dist/domain/reply/request.js");
type InboxTesting = typeof import("../../../modules/inbox/dist/testing/index.js");
const { receive }: Receive = await built("linkedin/dist/domain/receiver/receive.js");
const { remainingToday }: Linkedin = await built("linkedin/dist/index.js");
const { requestReply }: Request = await built("inbox/dist/domain/reply/request.js");
const inboxTesting: InboxTesting = await built("inbox/dist/testing/index.js");
type Principal = import("@whytide/platform").Principal;

useSenderTests();
const inbox = await loadModules(moduleLoaders.filter(({ name }) => name === "inbox"));
const linkedinModule = await loadModules(moduleLoaders.filter(({ name }) => name === "linkedin"));
const log = platform.createLogger({ destination: logs.destination });
before(() => startModules(inbox, log));

const TEXT = "Thanks Noor, Tuesday at 3 works. I will send an invite.";
const FOLLOW_UP = "Noor, one last question on your follow-ups.";
const UNSTORED = { stored: false, held: false, optOut: false };
/** The wait the settle answers after an unknown outcome, cut short here: the workflow's own timer. */
const SHORT_WAIT_MS = 200;
type Reply = Awaited<ReturnType<typeof replied>>;
type Run = Parameters<Wrap>[0];

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

/** inbox's and linkedin's activities through the host's wrapper, `wrap`'s replacing their runs. */
function activities(wrap: Record<string, Wrap> = {}) {
  return Object.fromEntries(
    [...inbox.activities, ...linkedinModule.activities].map(([name, definition]) => {
      const run = wrap[name]?.(definition.run as Run) ?? definition.run;
      return [name, hostActivity(name, { ...definition, run }, { client: app, log })];
    }),
  );
}

/**
 * The settle's wait cut to SHORT_WAIT_MS; the run's workflow id kept, and each settle's answer with
 * the row's status once it returned.
 */
function shortWaits(ids: string[], settles: string[]): Record<string, Wrap> {
  return {
    inbox_reply_begin: (run) => async (input, context) => {
      ids.push(context.workflowId);
      return run(input, context);
    },
    inbox_reply_settle: (run) => async (input, context) => {
      const settled = (await run(input, context)) as { status: string; waitMs?: number };
      const { messageId } = input as { messageId: string };
      settles.push(`${settled.status}:${(await rowOf(messageId)).sendStatus}`);
      return settled.status === "unknown" ? { ...settled, waitMs: SHORT_WAIT_MS } : settled;
    },
  };
}

/**
 * A person of the account's, a relation, who replied in its chat: the outreach row a campaign's send
 * left, the thread and the reply inbox stored; or, `missed`, a lead whose follow_up_1 is placed, the
 * campaign's last send two days before, and a reply no webhook brought: no row of inbox's, no reply
 * time of linkedin's. Then the owner's reply pressed, and the start its event asked for.
 */
async function replied(s: Sender, slug: string, missed = false) {
  const ready = missed ? await s.ready(slug, "follow_up_1", FOLLOW_UP) : null;
  const { personId, memberRef } = ready ?? (await s.lead(slug));
  fake.seedRelation(s.ref, memberRef);
  const chatRef = `fake-chat-${randomUUID()}`;
  fake.emitMessage(s.ref, { memberRef, chatRef, text: "Happy to talk next week." });
  const outreach = { senderAccountId: s.accountId, personId, providerMemberRef: memberRef };
  const row = { ...outreach, providerChatRef: chatRef };
  const { id: outreachId } = await linkedin.createOutreach(s.workspaceId, row);
  if (missed) {
    const lastSentAt = new Date(now().getTime() - 2 * DAY_MS);
    await app.senderOutreach.update({ where: { id: outreachId }, data: { lastSentAt } });
  }
  const thread = { workspaceId: s.workspaceId, personId, senderAccountId: s.accountId };
  const threadId: string = await inboxTesting.createThread(
    { ...thread, ownerUserId: OWNER, providerThreadRef: chatRef },
    app,
  );
  if (!missed) {
    const body = "Happy to talk next week.";
    await inboxTesting.createMessage({ ...thread, threadId, body }, app);
  }
  const principal: Principal = {
    ...{ userId: OWNER, actorType: "human", authMethod: "session", workspaceId: s.workspaceId },
    ...{ role: "Owner", scopes: [] },
  };
  const { messageId } = await withTenant(
    { workspaceId: s.workspaceId, principal },
    () => requestReply(threadId, TEXT),
    { client: app },
  );
  starts.length = 0;
  await deliver();
  const asked = starts.splice(0).filter(({ workflow }) => workflow === "inbox_send_reply");
  const [start, ...more] = asked;
  assert.ok(start);
  assert.deepEqual(more, [], "one start per reply");
  assert.deepEqual(start, {
    workflow: "inbox_send_reply",
    input: { workspaceId: s.workspaceId, messageId },
    workflowId: `inbox.reply:${s.workspaceId}:${messageId}`,
  });
  const ids = { threadId, messageId: messageId as string, outreachId, stepId: ready?.id ?? null };
  return { personId, memberRef, chatRef, start, ...ids };
}

/**
 * The reply's run on Temporal to its end, `wrap` replacing activities' runs; its result, its id and
 * the fake's calls of `method` since it started.
 */
async function sendReply(reply: Reply, wrap: Record<string, Wrap> = {}) {
  const ids: string[] = [];
  const settles: string[] = [];
  const from = fake.recordedCalls.length;
  const result = await runWorkflow<{ status: string }>(reply.start.workflow, reply.start.input, {
    activities: activities({ ...shortWaits(ids, settles), ...wrap }),
  });
  const calls = (method?: string) =>
    fake.recordedCalls.slice(from).filter((call) => method === undefined || call.method === method);
  return { result, workflowId: ids[0] as string, settles, calls };
}

const rowOf = (id: string) => app.message.findUniqueOrThrow({ where: { id } });
const slotsOf = async (messageId: string) =>
  (await app.senderQuotaReservation.findMany({ where: { idempotencyKey: messageId } })).map(
    ({ actionType, status }) => `${actionType}:${status}`,
  );
const logRowsOf = async (messageId: string) =>
  (await app.senderActionLog.findMany({ where: { objectRef: messageId } }))
    .map(({ kind, outcome }) => `${kind}:${outcome}`)
    .sort();

/** No text and no provider ref in the workspace's events, a log line, or the run's history. */
async function noText(workspaceId: string, workflowId: string, secrets: readonly string[]) {
  const events = await app.outboxEntry.findMany({ where: { workspaceId } });
  const seen = [...events.map(({ payload }) => JSON.stringify(payload)), ...logs.raw];
  seen.push(await historyOf(workflowId));
  for (const text of seen) {
    for (const secret of secrets) assert.ok(!text.includes(secret), "a text or a provider ref");
  }
}

test("the owner's reply goes out once on the thread's chat: one message of the day's, its slot committed, the row sent with the provider's ref and time; the echo stores no row", async () => {
  const s = await sender();
  const reply = await replied(s, "reply-sent");

  const { result, workflowId, settles, calls } = await sendReply(reply);

  assert.deepEqual(result, { status: "sent" });
  assert.deepEqual(settles, ["sent:sent"]);
  const [call, ...more] = calls("sendMessage");
  assert.deepEqual(more, []);
  assert.deepEqual(call?.input, {
    providerAccountRef: s.ref,
    memberRef: reply.memberRef,
    chatRef: reply.chatRef,
    text: TEXT,
    idempotencyKey: reply.messageId,
  });
  const where = { senderAccountId: s.accountId, personId: reply.personId };
  const outreach = await app.senderOutreach.findFirstOrThrow({ where });
  const row = await rowOf(reply.messageId);
  assert.deepEqual(
    [row.sendStatus, row.errorCode, row.providerMessageRef, row.sentAt, row.body],
    ["sent", null, outreach.lastMessageRef, outreach.lastSentAt, TEXT],
  );
  assert.deepEqual(await slotsOf(reply.messageId), ["message:committed"]);
  assert.deepEqual(await logRowsOf(reply.messageId), ["message:ok"]);
  const day = await app.senderQuotaUsage.findFirstOrThrow({
    where: { senderAccountId: s.accountId },
  });
  assert.equal(day.messagesCommitted, 1, "one message of the day's, one of its 200 actions");

  // The provider's echo of the reply, through linkedin's receiver: inbox's run stores nothing.
  const messageRef = row.providerMessageRef;
  assert.ok(messageRef);
  const event: Parameters<Receive["receive"]>[1] = {
    kind: "message.received",
    providerAccountRef: s.ref,
    eventKey: messageRef,
    chatRef: reply.chatRef,
    messageRef,
    fromAccount: true,
    senderMemberRef: "member-self",
    attendeeMemberRefs: [reply.memberRef],
    text: TEXT,
    sentAt: row.sentAt,
  };
  await receive("fake", event, [{ id: s.accountId, workspaceId: s.workspaceId }]);
  await deliver();
  const stores = starts.splice(0).filter(({ workflow }) => workflow === "inbox_store_message");
  assert.equal(stores.length, 1);
  const [store] = stores;
  assert.ok(store);
  const stored = await runWorkflow(store.workflow, store.input, { activities: activities() });
  assert.deepEqual(stored, UNSTORED);
  const outbound = await app.message.findMany({
    where: { threadId: reply.threadId, direction: "out" },
  });
  assert.deepEqual(
    outbound.map(({ id }) => id),
    [reply.messageId],
    "the echo adds no row",
  );
  await noText(s.workspaceId, workflowId, [TEXT, reply.chatRef, messageRef]);
});

test("the send activity killed after the fake's call: the outcome unknown, the row still sending, then linkedin_check_sent finds it sent; never a second call", async () => {
  const s = await sender();
  const reply = await replied(s, "reply-unknown");

  const killed = { linkedin_send_message: killedAfterSend };
  const { result, workflowId, settles, calls } = await sendReply(reply, killed);

  assert.deepEqual(result, { status: "sent" });
  assert.deepEqual(settles, ["unknown:sending", "sent:sent"], "still sending, then the check");
  assert.equal(calls("sendMessage").length, 1, "one send");
  assert.equal(calls("listRecentMessages").length, 1, "one check");
  const row = await rowOf(reply.messageId);
  const where = { senderAccountId: s.accountId, personId: reply.personId };
  const outreach = await app.senderOutreach.findFirstOrThrow({ where });
  assert.deepEqual([row.sendStatus, row.providerMessageRef], ["sent", outreach.lastMessageRef]);
  assert.deepEqual(await slotsOf(reply.messageId), ["message:committed"]);
  assert.deepEqual(await logRowsOf(reply.messageId), [
    "message:ok",
    "send_check:ok",
    "send_check:reserved",
  ]);
  const history = await historyOf(workflowId);
  assert.ok(history.includes("linkedin_check_sent"), "the check, by name");
  await noText(s.workspaceId, workflowId, [TEXT]);
});

test("the day's 200 actions used: the reservation refuses the reply daily_actions_cap_reached, nothing reserved, nothing called", async () => {
  const s = await sender();
  const reply = await replied(s, "reply-cap");
  // The day's row as linkedin makes it, then its 200 actions used.
  await s.run(() => remainingToday(s.accountId));
  const where = { senderAccountId: s.accountId };
  const used = await app.senderQuotaUsage.updateMany({ where, data: { readsCommitted: 200 } });
  assert.equal(used.count, 1);

  const { result, settles, calls } = await sendReply(reply);

  assert.deepEqual(result, { status: "refused" });
  assert.deepEqual(settles, [], "refused at the begin, before any send");
  const row = await rowOf(reply.messageId);
  assert.deepEqual([row.sendStatus, row.errorCode], ["refused", "daily_actions_cap_reached"]);
  assert.deepEqual(await slotsOf(reply.messageId), []);
  assert.deepEqual(calls(), []);
});

test("a message of the person's that no webhook brought, after the campaign's last send: the reply reads the chat first and marks it, then sends, so campaigns' gate holds the next step; one send, the reply's", async () => {
  const s = await sender();
  const reply = await replied(s, "reply-missed", true);

  const { result, calls } = await sendReply(reply);

  assert.deepEqual(result, { status: "sent" });
  assert.equal(calls("listRecentMessages").length, 1, "the chat read before the send");
  const where = { id: reply.outreachId };
  const { lastInboundAt, lastSentAt } = await app.senderOutreach.findUniqueOrThrow({ where });
  assert.ok(lastInboundAt !== null && lastSentAt !== null, "the person's message marked");
  assert.ok(lastInboundAt < lastSentAt, "before the reply's send moved the last send");

  const { result: run } = await s.send();

  assert.deepEqual(run, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  assert.ok(reply.stepId);
  const next = await stepOf(reply.stepId);
  assert.deepEqual([next.status, next.skipReason], ["held", "replied"]);
  assert.equal(calls("sendMessage").length, 1, "the reply's send only");
});
