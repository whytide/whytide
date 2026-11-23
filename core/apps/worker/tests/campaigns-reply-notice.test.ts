// campaigns' reply notices (gamma-p4-050; core/modules/campaigns/README.md "Reply actions",
// docs/flows.md "A reply's label"), on the slice's Temporal and a schema of its database, the
// app-mail, LinkedIn, files and LLM fakes bound: campaigns loaded from its build by the worker's own
// loader, its workflows run by the host. An interested label publishes campaigns.reply_notice_due,
// which the host's outbox delivers to campaigns' subscriber: campaigns_reply_notice runs once, as
// campaigns.reply_notice:<workspace>:<event>, and one mail goes to the thread's owner with the
// person's first name and the thread's link, never the reply's text or the person's other names.
// The event delivered again starts no second run. A disabled owner, one no longer a member and one
// who is no user get none, and the run ends without an error. The queue run (campaigns_queue)
// resumes an out-of-office pause that has ended and opens its step's item, and publishes a not-now
// reminder due, whose mail carries the lead's link. The recorded history replays. Contacts',
// linkedin's, tenancy's, inbox's and campaigns' code and helpers come from their builds, the files
// the loader's modules import. It lives here: a module never imports a host.
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
const { appMailPort, getAdapter } = await import("@whytide/providers");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { start } = await import("../src/start.ts");
const { replayHistories, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const campaigns = await import(built("campaigns/dist/index.js"));
const { enrollApproved } = await import(built("campaigns/dist/domain/enroll/enroll.js"));
const inbox = await import(built("inbox/dist/testing/index.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
const log = platform.createLogger({ destination: platform.collectLogs().destination });
/** The app-mail fake's helpers, which the bound adapter keeps (providers/app-mail/README.md). */
type AppMailFake = {
  sent(): readonly { to: string; subject: string; text: string }[];
};
const mails = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;
const principal = platform.servicePrincipal("campaigns_test");
const HISTORY = fileURLToPath(
  built("campaigns/workflows/__histories__/campaigns_reply_notice.json"),
);
const NOTICE = "campaigns.reply_notice_due";
const UNTIL_MS = 30_000;
const DAY_MS = 86_400_000;
/** The person's words, which no mail may hold. */
const TEXT = "Yes, very interested: call me on 555 0100 next week.";
const PERSON = { firstName: "Noor", lastName: "Haddad", companyName: "Qamar Robotics" };

type Owner = { id: string; email: string };
type Space = { workspaceId: string; owner: Owner; senderAccountId: string };
type Held = { personId: string; enrollmentId: string; threadId: string };
type Run = (workflow: string, input: unknown, workflowId?: string) => Promise<unknown>;

const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
const mailsTo = (to: string) => mails.sent().filter((mail) => mail.to === to);
const noticesOf = (workspaceId: string) =>
  app.outboxEntry.findMany({
    where: { workspaceId, eventName: NOTICE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

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

/** A workspace, its Owner member and the Owner's connected account. */
async function workspaceWithOwner(): Promise<Space> {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const workspaceId: string = workspace.id;
  const owner: Owner = await tenancy.createUser();
  await tenancy.createMembership({ userId: owner.id, workspaceId, role: "Owner" });
  const { id: senderAccountId } = await linkedin.createConnectedAccount(workspaceId, {
    ownerUserId: owner.id,
  });
  return { workspaceId, owner, senderAccountId };
}

/**
 * A lead approved by the owner and enrolled, its connection request and first message sent, the
 * first follow-up due a day before the reply; then the reply at `repliedAt`, stored in inbox's
 * tables with its text, and campaigns' hold, as inbox's store leaves them.
 */
async function heldLead(space: Space, repliedAt: Date): Promise<Held> {
  const { workspaceId, owner } = space;
  const personId: string = await inRun(workspaceId, async (tx) => {
    const linkedinUrl = `https://linkedin.com/in/reply-notice-${randomUUID()}`;
    const profile = { linkedinUrl, ...PERSON };
    const { person } = await contacts.upsertPersonFromSource({
      ...{ source: "import", provider: "csv", profile },
    });
    await contacts.createLeadForPerson({
      personId: person.id,
      source: { kind: "imported", ref: "imp_1" },
    });
    const actor = { type: "user", id: owner.id };
    await contacts.recordLeadStatus(person.id, "approved", { actor });
    const approval = { sourceEventId: platform.newId("obx"), personId: person.id };
    assert.equal(await enrollApproved(tx, { ...approval, approvedBy: owner.id }), "enrolled");
    const sent = { personId: person.id, stepKey: { in: ["connect", "message_1"] } };
    await tx.stepExecution.updateMany({ where: sent, data: { status: "succeeded" } });
    const due = new Date(repliedAt.getTime() - DAY_MS);
    const followUp = { personId: person.id, stepKey: "follow_up_1" };
    await tx.stepExecution.updateMany({ where: followUp, data: { dueAt: due } });
    await campaigns.holdForReply(person.id, { at: repliedAt });
    return person.id;
  });
  const ownerUserId = owner.id;
  const threadId: string = await inbox.createThread({ workspaceId, personId, ownerUserId }, app);
  await inbox.createMessage({ workspaceId, threadId, personId, body: TEXT }, app);
  const { id: enrollmentId } = await app.enrollment.findFirstOrThrow({ where: { personId } });
  return { personId, enrollmentId, threadId };
}

/** The label applied in the workspace's run, as inbox's classification will (gamma-p4-040). */
const label = (
  space: Space,
  held: Held,
  replyLabel: string,
  repliedAt: Date,
): Promise<{ actions: string[] }> =>
  inRun(space.workspaceId, () =>
    campaigns.applyReplyLabel(held.personId, {
      ...{ label: replyLabel, suggested: false, returnDate: null, repliedAt },
      ...{ threadId: held.threadId, ownerUserId: space.owner.id },
    }),
  );

/** `fn` with the host started, campaigns alone, on a queue of its own; closed after. */
async function withHost(fn: (run: Run) => Promise<void>): Promise<void> {
  const taskQueue = `test-${randomUUID()}`;
  const modules = moduleLoaders.filter(({ name }) => name === "campaigns");
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

/** The notice run the event `eventId` started, once it began. */
async function noticeRun(workspaceId: string, eventId: string) {
  const handle = env.client.workflow.getHandle(`campaigns.reply_notice:${workspaceId}:${eventId}`);
  await until(() => handle.describe().catch(() => null));
  return handle;
}

test("an interested label: one notice run, one mail to the thread's owner with the first name and the thread's link, none of the reply's text", () =>
  withHost(async () => {
    const space = await workspaceWithOwner();
    const repliedAt = new Date(Date.now() - DAY_MS);
    const held = await heldLead(space, repliedAt);
    const taken = await label(space, held, "interested", repliedAt);
    assert.deepEqual(taken.actions, ["label_recorded", "notice_published"]);
    const [event, ...more] = await noticesOf(space.workspaceId);
    assert.ok(event);
    assert.equal(more.length, 0);
    const handle = await noticeRun(space.workspaceId, event.id);
    assert.deepEqual(await handle.result(), { sent: true });

    const [mail, ...others] = mailsTo(space.owner.email);
    assert.ok(mail);
    assert.equal(others.length, 0, "one mail");
    assert.equal(mail.subject, "Noor sounds interested");
    const link = `${ORIGIN}/w/${space.workspaceId}/inbox/${held.threadId}`;
    assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [link], "the thread's link, alone");
    assert.match(mail.text, /^Noor sounds interested, from their reply on LinkedIn\./);
    for (const kept of ["very interested", "555 0100", PERSON.lastName, PERSON.companyName]) {
      assert.ok(!`${mail.subject}\n${mail.text}`.includes(kept), `the mail holds no ${kept}`);
    }
  }));

test("the notice's event delivered again starts no second run and sends no second mail", () =>
  withHost(async () => {
    const space = await workspaceWithOwner();
    const repliedAt = new Date(Date.now() - DAY_MS);
    await label(space, await heldLead(space, repliedAt), "interested", repliedAt);
    const [event] = await noticesOf(space.workspaceId);
    assert.ok(event);
    const handle = await noticeRun(space.workspaceId, event.id);
    await handle.result();
    const { runId } = await handle.describe();

    await app.outboxEntry.update({ where: { id: event.id }, data: { deliveredAt: null } });
    await until(async () => {
      const row = await app.outboxEntry.findUniqueOrThrow({ where: { id: event.id } });
      return row.deliveredAt;
    });
    assert.equal((await handle.describe()).runId, runId, "the same run, none after it");
    assert.equal(mailsTo(space.owner.email).length, 1, "still one mail");
  }));

test("a disabled owner, an owner no longer a member and an owner who is no user get no mail, and the run ends without an error", (t) =>
  withHost(async (run) => {
    const space = await workspaceWithOwner();
    const held = await heldLead(space, new Date(Date.now() - DAY_MS));
    const notice = {
      ...{ workspaceId: space.workspaceId, enrollmentId: held.enrollmentId },
      ...{ personId: held.personId, kind: "interested", threadId: held.threadId },
    };
    // The owner's own notice first: the run whose history is campaigns_reply_notice.json.
    const workflowId = `campaigns_reply_notice-${randomUUID()}`;
    const sent = await run(
      "campaigns_reply_notice",
      { ...notice, ownerUserId: space.owner.id },
      workflowId,
    );
    assert.deepEqual(sent, { sent: true });
    t.diagnostic(`campaigns_reply_notice ran as ${workflowId}`);
    const before = mails.sent().length;

    const disabled: Owner = await tenancy.createUser();
    await tenancy.createMembership({ userId: disabled.id, workspaceId: space.workspaceId });
    await app.user.update({ where: { id: disabled.id }, data: { disabledAt: new Date() } });
    // A member once: removed as tenancy's removeMember leaves the row (gamma-p6-030).
    const removed: Owner = await tenancy.createUser();
    const membership = await tenancy.createMembership({
      userId: removed.id,
      workspaceId: space.workspaceId,
    });
    const removal = { removedAt: new Date(), removedBy: space.owner.id };
    await app.membership.update({ where: { id: membership.id }, data: removal });
    for (const ownerUserId of [disabled.id, removed.id, "usr_reply_notice_nobody"]) {
      assert.deepEqual(await run("campaigns_reply_notice", { ...notice, ownerUserId }), {
        sent: false,
        reason: "owner_unavailable",
      });
    }
    assert.equal(mails.sent().length, before, "no mail");
  }));

test("the queue run resumes an out-of-office pause that has ended and opens its step, and publishes a not-now reminder due, mailed with the lead's link", () =>
  withHost(async (run) => {
    const space = await workspaceWithOwner();
    const now = Date.now();
    // Out of office eight days ago with no return date: paused until yesterday.
    const awayAt = new Date(now - 8 * DAY_MS);
    const away = await heldLead(space, awayAt);
    const paused = await label(space, away, "out_of_office", awayAt);
    assert.deepEqual(paused.actions, ["label_recorded", "released", "paused"]);
    // Not now, 31 days ago: its reminder was due yesterday.
    const laterAt = new Date(now - 31 * DAY_MS);
    const later = await heldLead(space, laterAt);
    await label(space, later, "not_now", laterAt);

    const counts = await run("campaigns_queue", { workspaceId: space.workspaceId });
    assert.deepEqual(counts, { opened: 1, passedOver: 0, noSender: 0, failed: 0 });
    const resumed = await app.enrollment.findUniqueOrThrow({ where: { id: away.enrollmentId } });
    assert.deepEqual([resumed.status, resumed.pausedReason], ["active", null]);
    const followUp = await app.stepExecution.findFirstOrThrow({
      where: { personId: away.personId, stepKey: "follow_up_1" },
    });
    assert.equal(followUp.status, "awaiting_approval", "its new item waits for the owner");
    const item = await app.approvalItem.findFirstOrThrow({
      where: { stepExecutionId: followUp.id, status: "pending" },
    });
    assert.equal(followUp.approvalItemId, item.id);

    const [event, ...more] = await noticesOf(space.workspaceId);
    assert.ok(event);
    assert.equal(more.length, 0, "the reminder's notice alone");
    assert.deepEqual(event.payload, {
      ...{ enrollmentId: later.enrollmentId, personId: later.personId, kind: "not_now" },
      ...{ threadId: null, ownerUserId: space.owner.id },
    });
    const handle = await noticeRun(space.workspaceId, event.id);
    assert.deepEqual(await handle.result(), { sent: true });
    const [mail, ...others] = mailsTo(space.owner.email);
    assert.ok(mail);
    assert.equal(others.length, 0);
    assert.equal(mail.subject, "A reminder to follow up with Noor");
    const link = `${ORIGIN}/w/${space.workspaceId}/leads/${later.personId}`;
    assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [link], "the lead's link, alone");
    assert.match(mail.text, /30 days ago/);
    assert.ok(!mail.text.includes("555 0100"), "no text");

    // The next queue run publishes it no more.
    await run("campaigns_queue", { workspaceId: space.workspaceId });
    assert.equal((await noticesOf(space.workspaceId)).length, 1, "once");
  }));

test("the recorded history of campaigns_reply_notice replays", () =>
  replayHistories(env.workflowsPath, [HISTORY]));
