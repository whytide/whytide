// campaigns' subscriber to linkedin.invite_accepted (beta-p4-050; core/modules/campaigns/README.md
// "Acceptance and the first message") through the outbox, on the slice's Temporal and a schema of
// its database: campaigns loaded from its build by the worker's own loader, the event written to the
// outbox as linkedin's receiver writes it and delivered by the worker's outbox loop (src/outbox.ts)
// in a tenant run as service:worker, and the queue's run through the host's activities. An accepted
// connection request records accepted_at, the detection, its status and its other columns kept, and
// message_1 falls due 1 to 3 hours after the detection; a redelivery and a later acceptance change
// nothing; an ended enrollment, a request never sent and another account's acceptance change
// nothing, and a request the sender still holds records it; then the queue's next run opens
// message_1's item. Contacts', linkedin's, tenancy's and campaigns' code and test helpers come from
// their builds, the files the loader's modules import. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { Principal } from "@whytide/platform";

// The fakes, whatever the environment names: nothing here calls a provider, and nothing may.
process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_LLM = "fake";

const { outboxWriter, withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { startOutboxLoop } = await import("../src/outbox.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { approveLead } = await import(built("contacts/dist/domain/outreach/status.js"));
const { holdForReply } = await import(built("campaigns/dist/index.js"));
const campaigns = await import(built("campaigns/dist/testing/index.js"));
const { events: linkedinEvents } = await import(built("linkedin/dist/index.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const loaded = await loadModules(moduleLoaders.filter(({ name }) => name === "campaigns"));
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app, log })];
  }),
);

const APPROVER = "usr_campaigns_approver";
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Wednesday 28 October 2026, 10:00 UTC: inside the account's window, 09:00 to 18:00 in UTC. */
const DETECTED = new Date("2026-10-28T10:00:00.000Z");
/** The draw the tests set, half of the two hours: message_1 falls due 2 hours after the detection. */
const HALF = 0.5;
const DUE = new Date(DETECTED.getTime() + 2 * HOUR_MS);
const NONE = { opened: 0, passedOver: 0, noSender: 0, failed: 0 };
const approver: Principal = {
  userId: APPROVER,
  actorType: "human",
  authMethod: "session",
  scopes: [],
};
const service = platform.servicePrincipal("campaigns_test");
const inRun = <T>(
  workspaceId: string,
  principal: Principal,
  fn: (tx: TenantClient) => Promise<T>,
) => withTenant({ workspaceId, principal }, fn, { client: app });

/** The first truthy answer of `probe`, asked every 50 ms for 20 seconds at most. */
async function until<T>(probe: () => Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 20 seconds");
    await sleep(50);
  }
}

/** The worker's outbox loop, run until every event is delivered, then stopped. */
async function deliver(): Promise<void> {
  const loop = startOutboxLoop(app, log);
  try {
    await until(async () => (await app.outboxEntry.count({ where: { deliveredAt: null } })) === 0);
  } finally {
    await loop.stop();
  }
}

/** A workspace with the approver's connected account, in UTC with the default hours. */
async function workspaceWithAccount(): Promise<{ workspaceId: string; accountId: string }> {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const { id } = await linkedin.createConnectedAccount(workspace.id, { ownerUserId: APPROVER });
  return { workspaceId: workspace.id, accountId: id };
}

/** A person approved by the approver and enrolled by campaigns' subscriber: its id. */
async function enrolled(workspaceId: string, slug: string): Promise<string> {
  const personId: string = await inRun(workspaceId, service, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await contacts.upsertPersonFromSource({
      ...{ source: "import", provider: "csv", profile },
    });
    const source = { kind: "imported", ref: "imp_1" };
    await contacts.createLeadForPerson({ personId: person.id, source });
    return person.id;
  });
  await inRun(workspaceId, approver, () => approveLead(personId));
  await deliver();
  return personId;
}

type Accepted = { sender_account_id: string; person_id: string; detected_at: string };
/** linkedin.invite_accepted written to the outbox in a run, as linkedin's receiver writes it. */
const accepted = (workspaceId: string, payload: Accepted) =>
  inRun(workspaceId, service, (tx) =>
    platform.publish(
      outboxWriter(tx, workspaceId),
      linkedinEvents["linkedin.invite_accepted"],
      payload,
    ),
  );
/** The events delivered with campaigns' draw fixed at half of the two hours. */
async function deliverDrawingHalf(): Promise<void> {
  campaigns.useRandom(() => HALF);
  try {
    await deliver();
  } finally {
    campaigns.useRandom(undefined);
  }
}

/** The person's steps by position, as stored. */
const rowsOf = (personId: string) =>
  app.stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } });
/** The same without updated_at, which every write moves. */
const stepsOf = async (personId: string) =>
  (await rowsOf(personId)).map(({ updatedAt: _updated, ...step }) => step);
/** The connection request's id. */
async function connectOf(personId: string): Promise<string> {
  const [connect] = await rowsOf(personId);
  assert.ok(connect?.stepKey === "connect");
  return connect.id;
}
/** As the sender (beta-p4-020) leaves a step: sent, claimed, or still waiting for its time. */
const move = (id: string, status: "scheduled" | "executing" | "succeeded") =>
  app.stepExecution.update({ where: { id }, data: { status } });
const queueRun = (workspaceId: string) =>
  runWorkflow("campaigns_queue", { workspaceId }, { activities });

test("linkedin.invite_accepted, delivered: the connection request records accepted_at, the detection, its status and every other column kept; message_1 falls due 1 to 3 hours after the detection; a redelivery and a later acceptance change nothing", async () => {
  const { workspaceId, accountId } = await workspaceWithAccount();
  const personId = await enrolled(workspaceId, "acceptance-recorded");
  await move(await connectOf(personId), "succeeded");
  const [sent, message1, ...followUps] = await stepsOf(personId);
  assert.ok(sent && message1);
  assert.deepEqual([message1.status, message1.dueAt], ["planned", null]);
  const payload = {
    sender_account_id: accountId,
    person_id: personId,
    detected_at: DETECTED.toISOString(),
  };
  await accepted(workspaceId, payload);
  await deliverDrawingHalf();
  assert.deepEqual(await stepsOf(personId), [
    { ...sent, acceptedAt: DETECTED },
    { ...message1, dueAt: DUE },
    ...followUps,
  ]);

  // The event again, as after a crash between the handler's commit and the row's mark; then the
  // daily check's acceptance of the same person, six hours later (beta-p4-070): no write at all.
  const rows = await rowsOf(personId);
  await app.outboxEntry.updateMany({
    where: { eventName: "linkedin.invite_accepted" },
    data: { deliveredAt: null, nextAttemptAt: new Date(0) },
  });
  await deliverDrawingHalf();
  const later = new Date(DETECTED.getTime() + 6 * HOUR_MS).toISOString();
  await accepted(workspaceId, { ...payload, detected_at: later });
  await deliverDrawingHalf();
  assert.deepEqual(await rowsOf(personId), rows);
});

test("an acceptance changes nothing for an ended enrollment, a connection request never sent, another account's acceptance or another workspace's; a request the sender still holds records it and stays executing", async () => {
  const { workspaceId, accountId } = await workspaceWithAccount();
  const other = await linkedin.createConnectedAccount(workspaceId, {
    ownerUserId: "usr_campaigns_other",
  });
  const stranger = await workspaceWithAccount();
  const replied = await enrolled(workspaceId, "acceptance-replied");
  const unsent = await enrolled(workspaceId, "acceptance-unsent");
  const elsewhere = await enrolled(workspaceId, "acceptance-elsewhere");
  const foreign = await enrolled(workspaceId, "acceptance-foreign");
  const claimed = await enrolled(workspaceId, "acceptance-claimed");
  await move(await connectOf(replied), "succeeded");
  await inRun(workspaceId, service, () => holdForReply(replied, { at: new Date() }));
  await move(await connectOf(unsent), "scheduled");
  await move(await connectOf(elsewhere), "succeeded");
  await move(await connectOf(foreign), "succeeded");
  await move(await connectOf(claimed), "executing");
  const untouched = [replied, unsent, elsewhere, foreign];
  const before = await Promise.all(untouched.map(rowsOf));
  const [holding, message1, ...followUps] = await stepsOf(claimed);
  assert.ok(holding && message1);

  const detected_at = DETECTED.toISOString();
  for (const personId of [replied, unsent, claimed]) {
    await accepted(workspaceId, { sender_account_id: accountId, person_id: personId, detected_at });
  }
  await accepted(workspaceId, { sender_account_id: other.id, person_id: elsewhere, detected_at });
  // The workspace's own ids, published in another workspace: its delivery runs there.
  const foreignIds = { sender_account_id: accountId, person_id: foreign, detected_at };
  await accepted(stranger.workspaceId, foreignIds);
  await deliverDrawingHalf();

  assert.deepEqual(await Promise.all(untouched.map(rowsOf)), before);
  const ended = await app.enrollment.findFirstOrThrow({ where: { personId: replied } });
  assert.equal(ended.status, "replied");
  assert.deepEqual(await stepsOf(claimed), [
    { ...holding, acceptedAt: DETECTED },
    { ...message1, dueAt: DUE },
    ...followUps,
  ]);
});

test("the queue's next run opens message_1's item: the step awaits approval with it, its draft asked as the account's owner, scheduled for its due time", async () => {
  const { workspaceId, accountId } = await workspaceWithAccount();
  const personId = await enrolled(workspaceId, "acceptance-queued");
  await move(await connectOf(personId), "succeeded");
  const detected_at = DETECTED.toISOString();
  await accepted(workspaceId, { sender_account_id: accountId, person_id: personId, detected_at });
  await deliverDrawingHalf();

  // The queue's next tick, within TICK_MINUTES of the detection.
  campaigns.useClock(() => new Date(DETECTED.getTime() + 5 * MINUTE_MS));
  try {
    assert.deepEqual(await queueRun(workspaceId), { ...NONE, opened: 1 });
  } finally {
    campaigns.useClock(undefined);
  }
  const [, message1] = await rowsOf(personId);
  assert.ok(message1);
  const item = await app.approvalItem.findFirstOrThrow({
    where: { stepExecutionId: message1.id },
  });
  assert.deepEqual([message1.status, message1.approvalItemId], ["awaiting_approval", item.id]);
  assert.deepEqual(
    [item.status, item.stepKey, item.actionType, item.senderAccountId, item.scheduledFor],
    ["pending", "message_1", "message", accountId, DUE],
  );
  const requested = await app.outboxEntry.findFirstOrThrow({
    where: { eventName: "messaging.draft_requested" },
  });
  const { userId, draftId } = requested.payload as { userId: string; draftId: string };
  const draft = await app.messageDraft.findUniqueOrThrow({ where: { id: draftId } });
  assert.deepEqual([userId, draft.stepExecutionId], [APPROVER, message1.id]);
});
