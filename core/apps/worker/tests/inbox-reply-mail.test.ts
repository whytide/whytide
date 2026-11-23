// inbox's reply mail (beta-p5-030; core/modules/inbox/README.md "The reply mail", docs/flows.md), on
// the slice's Temporal and a schema of its database, the app-mail, LinkedIn, files and LLM fakes
// bound: inbox loaded from its build by the worker's own loader, its workflows run by the host. A
// reply through the store: inbox.reply_received, delivered by the host's outbox, starts
// inbox_reply_mail, and one mail goes to the sender account's owner with the person's first name and
// the thread's link, never the reply's text, the person's other names or the company; the marker is
// set. The event delivered again, and the activity run again after the marker: no second mail. No
// APP_PUBLIC_ORIGIN: the mail goes without a link, and a person without a first name is "a lead". A
// disabled owner, or none: no mail, and the workflow ends without an error. A member removed from
// the workspace: no mail, the log line with ids only, while an active member's mail goes
// (gamma-p6-060). A mail the server refused for good, or one the port refused as input, is tried
// once, one that found no server five times (gamma-p0-085). The recorded history replays. Contacts', linkedin's, tenancy's and inbox's
// code and helpers come from their builds, the files the loader's modules import. It lives here: a
// module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TenantClient } from "@whytide/db";

// The fakes, whatever the environment names: nothing here sends a mail, calls a provider or a model.
process.env.PROVIDER_APP_MAIL = "fake";
process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_LLM = "fake";
const ORIGIN = "https://app.example.test";
process.env.APP_PUBLIC_ORIGIN = ORIGIN;

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { appMailPort, filesPort, getAdapter } = await import("@whytide/providers");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { start } = await import("../src/start.ts");
const { replayHistories, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { mailReply } = await import(built("inbox/dist/domain/mail.js"));
const inbox = await import(built("inbox/dist/testing/index.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const files = await getAdapter(filesPort, "fake");
/** The app-mail fake's helpers, which the bound adapter keeps (providers/app-mail/README.md). */
type AppMailFake = {
  sent(): readonly { to: string; subject: string; text: string }[];
  failNext(code: "mail_rejected" | "mail_unreachable"): void;
};
const mails = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;
const principal = platform.servicePrincipal("inbox_test");
const HISTORY = fileURLToPath(built("inbox/workflows/__histories__/inbox_reply_mail.json"));
const UNTIL_MS = 30_000;
/** The person's words, which no mail may hold. */
const TEXT = "Thursday at ten works, my direct line is 555 0100.";
const PERSON = { firstName: "Noor", lastName: "Haddad", companyName: "Qamar Robotics" };

type MailInput = { workspaceId: string; messageId: string };
type Run = (workflow: string, input: unknown, workflowId?: string) => Promise<unknown>;

const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
const mailsTo = (to: string) => mails.sent().filter((mail) => mail.to === to);
const eventsOf = (workspaceId: string) =>
  app.outboxEntry.findMany({ where: { workspaceId, eventName: "inbox.reply_received" } });

/** The first truthy answer of `probe`, asked every 50 ms for 30 seconds at most. */
async function until<T>(probe: () => Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + UNTIL_MS;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 30 seconds");
    await sleep(50);
  }
}

/** A workspace, its owner, a member, the owner's account and a person as `profile` names them. */
async function workspaceWithOwner(profile: Record<string, string> = PERSON) {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const workspaceId: string = workspace.id;
  const owner: { id: string; email: string } = await tenancy.createUser();
  await tenancy.createMembership({ userId: owner.id, workspaceId });
  const { id: senderAccountId } = await linkedin.createConnectedAccount(workspaceId, {
    ownerUserId: owner.id,
  });
  const personId: string = await inRun(workspaceId, async () => {
    const linkedinUrl = `https://linkedin.com/in/reply-mail-${randomUUID()}`;
    const source = { source: "import", provider: "csv", profile: { linkedinUrl, ...profile } };
    return (await contacts.upsertPersonFromSource(source)).person.id;
  });
  return { workspaceId, owner, senderAccountId, personId };
}

/** A reply stored straight in the tables, as the store leaves it, with no event: its ids. */
async function storedReply(workspaceId: string, personId: string, ownerUserId: string) {
  const threadId: string = await inbox.createThread({ workspaceId, personId, ownerUserId }, app);
  const messageId: string = await inbox.createMessage(
    { workspaceId, threadId, personId, body: TEXT },
    app,
  );
  return { threadId, messageId };
}

/** `fn` with the host started, inbox alone, on a queue of its own; closed after. */
async function withHost(fn: (run: Run) => Promise<void>): Promise<void> {
  const taskQueue = `test-${randomUUID()}`;
  const modules = moduleLoaders.filter(({ name }) => name === "inbox");
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    schedules: "off",
    client: app,
    log,
  });
  const run: Run = (workflow, input, workflowId = `${workflow}-${randomUUID()}`) =>
    env.client.workflow.execute(workflow, { args: [input], taskQueue, workflowId });
  try {
    await fn(run);
  } finally {
    await host.close();
  }
}

/**
 * A reply through the store, the run the receiver's event starts: its file under raw/, the message
 * stored and inbox.reply_received published, which the host's outbox delivers. Its ids, once the
 * reply's mail workflow ended.
 */
async function replyThroughTheStore(run: Run) {
  const { workspaceId, owner, senderAccountId, personId } = await workspaceWithOwner();
  const file = {
    ...{ chatRef: `chat-${randomUUID()}`, messageRef: `message-${randomUUID()}` },
    ...{ senderMemberRef: "member-noor", attendeeMemberRefs: ["member-self"] },
    ...{ fromAccount: false, sentAt: new Date().toISOString(), text: TEXT },
  };
  const key = `raw/linkedin/messages/${randomUUID()}.json`;
  const body = JSON.stringify(file);
  const { key: fileKey } = await files.put({
    workspaceId,
    key,
    body,
    contentType: "application/json",
  });
  const input = { workspaceId, senderAccountId, personId, direction: "in", fileKey };
  const stored = (await run("inbox_store_message", input)) as { messageId: string };
  const { id: messageId, threadId } = await app.message.findUniqueOrThrow({
    where: { id: stored.messageId },
  });
  // The subscriber's run, by its id: started once the outbox delivered the event.
  const mail = env.client.workflow.getHandle(`inbox.reply_mail:${workspaceId}:${messageId}`);
  await until(() => mail.describe().catch(() => null));
  const result = await mail.result();
  return { workspaceId, owner, messageId, threadId, mail, result };
}

test("one reply: one mail to the sender account's owner, with the person's first name and the thread's link, none of the reply's text; the marker set", () =>
  withHost(async (run) => {
    const { workspaceId, owner, messageId, threadId, result } = await replyThroughTheStore(run);

    assert.deepEqual(result, { sent: true });
    const sent = mailsTo(owner.email);
    assert.equal(sent.length, 1, "one mail");
    const [mail] = sent;
    assert.ok(mail);
    assert.equal(mail.subject, "Noor replied to you on LinkedIn");
    const link = `${ORIGIN}/w/${workspaceId}/inbox/${threadId}`;
    assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [link], "the thread's link, alone");
    assert.match(mail.text, /^Noor replied to your message on LinkedIn\./);
    assert.match(mail.text, /To answer, reply from your Whytide inbox:/, "answered from the inbox");
    for (const kept of ["Thursday at ten", "555 0100", PERSON.lastName, PERSON.companyName]) {
      assert.ok(!`${mail.subject}\n${mail.text}`.includes(kept), `the mail holds no ${kept}`);
    }
    const row = await app.message.findUniqueOrThrow({ where: { id: messageId } });
    assert.ok(row.ownerNotifiedAt instanceof Date, "owner_notified_at is set");
  }));

test("the event delivered again starts no second run, and the activity run again after the marker sends no second mail", () =>
  withHost(async (run) => {
    const { workspaceId, owner, messageId, mail } = await replyThroughTheStore(run);
    const { runId } = await mail.describe();
    const [event] = await eventsOf(workspaceId);
    assert.ok(event);

    await app.outboxEntry.update({ where: { id: event.id }, data: { deliveredAt: null } });
    await until(async () => {
      const row = await app.outboxEntry.findUniqueOrThrow({ where: { id: event.id } });
      return row.deliveredAt;
    });
    assert.equal((await mail.describe()).runId, runId, "the same run, none after it");

    // A retry of the activity once the marker is set, as the host runs its body.
    const tenant = <T>(fn: (tx: TenantClient) => Promise<T>) => inRun(workspaceId, fn);
    assert.deepEqual(await mailReply({ workspaceId, tenant }, messageId), {
      sent: false,
      reason: "already_sent",
    });
    assert.equal(mailsTo(owner.email).length, 1, "still one mail");
  }));

test("with APP_PUBLIC_ORIGIN empty the mail has no link and still goes; a person without a first name is a lead", (t) =>
  withHost(async (run) => {
    const { workspaceId, owner, personId } = await workspaceWithOwner({});
    const { messageId } = await storedReply(workspaceId, personId, owner.id);
    process.env.APP_PUBLIC_ORIGIN = "";
    const workflowId = `inbox_reply_mail-${randomUUID()}`;
    try {
      const input: MailInput = { workspaceId, messageId };
      assert.deepEqual(await run("inbox_reply_mail", input, workflowId), { sent: true });
    } finally {
      process.env.APP_PUBLIC_ORIGIN = ORIGIN;
    }
    // The run whose history is workflows/__histories__/inbox_reply_mail.json (history:record).
    t.diagnostic(`inbox_reply_mail ran as ${workflowId}`);

    const [mail, ...more] = mailsTo(owner.email);
    assert.ok(mail);
    assert.equal(more.length, 0);
    assert.equal(mail.subject, "A lead replied to you on LinkedIn");
    assert.doesNotMatch(mail.text, /https?:|\/w\//, "no link and no path");
    assert.match(mail.text, /Open your inbox in Whytide to read the reply\./);
    assert.ok(!mail.text.includes("Thursday at ten"), "no text");
    const row = await app.message.findUniqueOrThrow({ where: { id: messageId } });
    assert.ok(row.ownerNotifiedAt instanceof Date);
  }));

test("a disabled owner, or an owner who is no user, gets no mail, and the workflow ends without an error", () =>
  withHost(async (run) => {
    const { workspaceId, owner, personId } = await workspaceWithOwner();
    await app.user.update({ where: { id: owner.id }, data: { disabledAt: new Date() } });
    const disabled = await storedReply(workspaceId, personId, owner.id);
    const nobody = await storedReply(workspaceId, personId, "usr_inbox_reply_mail_nobody");
    const before = mails.sent().length;

    for (const { messageId } of [disabled, nobody]) {
      const input: MailInput = { workspaceId, messageId };
      assert.deepEqual(await run("inbox_reply_mail", input), {
        sent: false,
        reason: "owner_unavailable",
      });
      const row = await app.message.findUniqueOrThrow({ where: { id: messageId } });
      assert.equal(row.ownerNotifiedAt, null, "no marker: no mail went");
    }
    assert.equal(mails.sent().length, before, "no mail");
  }));

test("a member removed from the workspace gets no mail for a reply on their thread, the workflow ends without an error and the log line carries ids only; an active member's mail goes as before", () =>
  withHost(async (run) => {
    const { workspaceId, owner, personId } = await workspaceWithOwner();
    // A member once, with their own account: removed as tenancy's removeMember leaves the row.
    const removed: { id: string; email: string } = await tenancy.createUser();
    const membership = await tenancy.createMembership({
      userId: removed.id,
      workspaceId,
      role: "Member",
    });
    await linkedin.createConnectedAccount(workspaceId, { ownerUserId: removed.id });
    await app.membership.update({
      where: { id: membership.id },
      data: { removedAt: new Date(), removedBy: owner.id },
    });
    const theirs = await storedReply(workspaceId, personId, removed.id);
    const before = mails.sent().length;

    const input: MailInput = { workspaceId, messageId: theirs.messageId };
    assert.deepEqual(await run("inbox_reply_mail", input), {
      sent: false,
      reason: "owner_unavailable",
    });
    const row = await app.message.findUniqueOrThrow({ where: { id: theirs.messageId } });
    assert.equal(row.ownerNotifiedAt, null, "no marker: no mail went");
    assert.equal(mails.sent().length, before, "no mail");
    assert.deepEqual(mailsTo(removed.email), [], "none to the removed member, ever");
    const lines = logs.lines().filter(({ message_id }) => message_id === theirs.messageId);
    assert.equal(lines.length, 1, "one line");
    const [line] = lines;
    assert.deepEqual(
      [line?.message_id, line?.thread_id, line?.user_id, line?.outcome],
      [theirs.messageId, theirs.threadId, removed.id, "owner_unavailable"],
    );
    const said = JSON.stringify(line);
    for (const kept of [removed.email, TEXT, PERSON.firstName, PERSON.lastName]) {
      assert.ok(!said.includes(kept), `the line holds no ${kept}`);
    }

    const ours = await storedReply(workspaceId, personId, owner.id);
    const sent = { workspaceId, messageId: ours.messageId };
    assert.deepEqual(await run("inbox_reply_mail", sent), { sent: true });
    assert.equal(mailsTo(owner.email).length, 1, "the active member's mail");
  }));

test("a mail the server refused for good, or one whose input the port refused, runs one attempt and one that found no server five: each run fails with the code, with no mail and no marker", () =>
  withHost(async (run) => {
    const { workspaceId, owner, personId } = await workspaceWithOwner();
    /** The run of a new reply's mail, to its failure: its activity's attempts and code. */
    const failed = async () => {
      const { messageId } = await storedReply(workspaceId, personId, owner.id);
      const workflowId = `inbox_reply_mail-${randomUUID()}`;
      await assert.rejects(run("inbox_reply_mail", { workspaceId, messageId }, workflowId));
      const row = await app.message.findUniqueOrThrow({ where: { id: messageId } });
      assert.equal(row.ownerNotifiedAt, null, "no marker");
      const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
      const started = events?.filter((event) => event.activityTaskStartedEventAttributes).at(-1);
      const failure = events?.find((event) => event.activityTaskFailedEventAttributes);
      return [
        started?.activityTaskStartedEventAttributes?.attempt,
        failure?.activityTaskFailedEventAttributes?.failure?.applicationFailureInfo?.type,
      ];
    };
    const before = mails.sent().length;

    mails.failNext("mail_rejected");
    assert.deepEqual(await failed(), [1, "mail_rejected"]);
    for (let n = 0; n < 5; n += 1) mails.failNext("mail_unreachable");
    assert.deepEqual(await failed(), [5, "mail_unreachable"]);
    // An address the port's plain-address rule refuses: no TLD.
    const email = `owner-${randomUUID()}@localhost`;
    await app.user.update({ where: { id: owner.id }, data: { email } });
    assert.deepEqual(await failed(), [1, "mail_input_invalid"]);
    assert.equal(mails.sent().length, before, "no mail");
  }));

test("the recorded history of inbox_reply_mail replays", () =>
  replayHistories(env.workflowsPath, [HISTORY]));
