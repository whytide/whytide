// campaigns' enrollment (beta-p2-040; core/modules/campaigns/README.md, docs/flows.md "Approve →
// enrollment") through the outbox, on a schema of the slice's database: campaigns loaded from its
// build by the worker's own loader, its subscriber run by the worker's outbox loop (src/outbox.ts) in
// a tenant run as service:worker. Approve's event delivered: one active enrollment with the
// approver's account, four planned steps with four keys, connect due, the template on every row, and
// the lead in_campaign with one change row. Then the same event again, Approve pressed twice before
// the delivery and once after it, an approver without a connected account, a person blocked and one
// touched between Approve and the delivery, and an erased person. Contacts' and linkedin's code and
// test helpers come from their builds, the files the loader's modules import. It lives here: a module
// never imports a host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { Principal } from "@whytide/platform";

// The LinkedIn fake, whatever the environment names: nothing here calls a provider, and nothing may.
process.env.PROVIDER_LINKEDIN = "fake";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { startOutboxLoop } = await import("../src/outbox.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { approveLead } = await import(built("contacts/dist/domain/outreach/status.js"));
const { addSuppression } = await import(built("contacts/dist/domain/suppression/entries.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));

withTestDb();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
const log = platform.createLogger({ destination: platform.collectLogs().destination });
await loadModules(moduleLoaders.filter(({ name }) => name === "campaigns"));

const WORKSPACE = "wsp_campaigns_enroll";
const APPROVER = "usr_campaigns_approver";
const DAY_MS = 86_400_000;
const approver: Principal = {
  userId: APPROVER,
  actorType: "human",
  authMethod: "session",
  scopes: [],
};
const inRun = <T>(principal: Principal, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId: WORKSPACE, principal }, fn, { client: app });
const asSystem = <T>(fn: (tx: TenantClient) => Promise<T>) =>
  inRun(platform.servicePrincipal("campaigns_test"), fn);
/** The member's Approve on the lead, as the route runs it. */
const approve = (personId: string): Promise<string> => inRun(approver, () => approveLead(personId));

/** A person of the workspace with a lead waiting for review, through contacts' commands: its id. */
const leadOf = (slug: string): Promise<string> =>
  asSystem(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const source = { source: "import", provider: "csv", profile };
    const { person } = await contacts.upsertPersonFromSource(source);
    await contacts.createLeadForPerson({
      personId: person.id,
      source: { kind: "imported", ref: "imp_1" },
    });
    return person.id;
  });

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

/** The ids of contacts.lead_approved events published for the person, oldest first. */
const approvals = async (personId: string) =>
  (
    await app.outboxEntry.findMany({
      where: { eventName: "contacts.lead_approved" },
      orderBy: { createdAt: "asc" },
    })
  )
    .filter(({ payload }) => (payload as { personId?: string }).personId === personId)
    .map(({ id }) => id);
const enrollmentsOf = (personId: string) =>
  app.enrollment.findMany({ where: { personId }, orderBy: { createdAt: "asc" } });
const stepsOf = (personId: string) =>
  app.stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } });
const statusOf = async (personId: string) =>
  (await app.lead.findFirstOrThrow({ where: { personId } })).outreachStatus;
const changesOf = async (personId: string) =>
  (await app.leadStatusChange.findMany({ where: { personId }, orderBy: { createdAt: "asc" } })).map(
    ({ fromStatus, toStatus, templateId, actorType }) => [
      fromStatus,
      toStatus,
      templateId,
      actorType,
    ],
  );
/** The person's enrollments, as the panel will read them: the status, the reason and the detail. */
const exitsOf = async (personId: string) =>
  (await enrollmentsOf(personId)).map(({ status, exitReason, exitDetail, senderAccountId }) => ({
    status,
    exitReason,
    exitDetail,
    senderAccountId,
  }));

test("Approve's event, delivered: one active enrollment with the approver's account, four planned steps with four keys, connect due, and the lead in_campaign; the same event again changes nothing", async () => {
  const { id: senderAccountId } = await linkedin.createConnectedAccount(WORKSPACE, {
    ownerUserId: APPROVER,
  });
  const personId = await leadOf("enroll-approved");
  assert.equal(await approve(personId), "approved");
  const before = new Date();
  await deliver();

  const [eventId] = await approvals(personId);
  const [enrollment, ...more] = await enrollmentsOf(personId);
  assert.ok(enrollment);
  assert.deepEqual(more, []);
  const { status, templateId, templateVersion, exitReason, exitDetail, endedAt } = enrollment;
  assert.deepEqual(
    { status, templateId, templateVersion, exitReason, exitDetail, endedAt },
    {
      status: "active",
      templateId: "linkedin_default",
      templateVersion: 1,
      ...{ exitReason: null, exitDetail: null, endedAt: null },
    },
  );
  assert.deepEqual(
    [enrollment.senderAccountId, enrollment.sourceEventId],
    [senderAccountId, eventId],
  );
  assert.ok(enrollment.startedAt !== null && enrollment.startedAt >= before);

  const steps = await stepsOf(personId);
  assert.deepEqual(
    steps.map(({ stepKey, position, actionType, status }) => [
      stepKey,
      position,
      actionType,
      status,
    ]),
    [
      ["connect", 1, "invite", "planned"],
      ["message_1", 2, "message", "planned"],
      ["follow_up_1", 3, "message", "planned"],
      ["follow_up_2", 4, "message", "planned"],
    ],
  );
  assert.equal(new Set(steps.map(({ idempotencyKey }) => idempotencyKey)).size, 4);
  for (const step of steps) {
    const { enrollmentId, templateId, templateVersion } = step;
    assert.deepEqual(
      { enrollmentId, senderAccountId: step.senderAccountId, templateId, templateVersion },
      {
        enrollmentId: enrollment.id,
        senderAccountId,
        templateId: "linkedin_default",
        templateVersion: 1,
      },
    );
    assert.deepEqual([step.scheduledFor, step.attempt, step.executedAt], [null, 0, null]);
  }
  const [connect, ...later] = steps;
  assert.ok(connect?.dueAt && connect.dueAt >= before, "connect is due at once");
  assert.deepEqual(
    later.map(({ dueAt }) => dueAt),
    [null, null, null],
  );

  assert.equal(await statusOf(personId), "in_campaign");
  assert.deepEqual(await changesOf(personId), [
    ["pending_review", "approved", null, "user"],
    ["approved", "in_campaign", "linkedin_default", "system"],
  ]);

  // The same event again, as after a crash between the handler's commit and the row's mark.
  const rows = { enrollments: await enrollmentsOf(personId), steps };
  const due = { deliveredAt: null, nextAttemptAt: new Date(0) };
  await app.outboxEntry.update({ where: { id: eventId }, data: due });
  await deliver();
  assert.deepEqual(
    { enrollments: await enrollmentsOf(personId), steps: await stepsOf(personId) },
    rows,
  );
  assert.equal((await changesOf(personId)).length, 2);
});

test("Approve pressed twice before the delivery enrolls once; pressed after it, it is refused", async () => {
  await linkedin.createConnectedAccount(WORKSPACE, { ownerUserId: APPROVER });
  const personId = await leadOf("enroll-twice");
  await approve(personId);
  await approve(personId);
  assert.equal((await approvals(personId)).length, 2);
  await deliver();
  assert.deepEqual(
    (await enrollmentsOf(personId)).map(({ status }) => status),
    ["active"],
  );
  assert.equal((await stepsOf(personId)).length, 4);
  await assert.rejects(approve(personId), { code: "lead_in_outreach" });
  assert.equal((await approvals(personId)).length, 2);
});

test("without a connected account: an exited enrollment, no_sender, no step, and the lead stays approved", async () => {
  // Another member's account is not the approver's.
  await linkedin.createConnectedAccount(WORKSPACE, { ownerUserId: "usr_someone_else" });
  const personId = await leadOf("enroll-no-sender");
  await approve(personId);
  await deliver();
  assert.deepEqual(await exitsOf(personId), [
    { status: "exited", exitReason: "no_sender", exitDetail: null, senderAccountId: null },
  ]);
  assert.deepEqual(await stepsOf(personId), []);
  assert.equal(await statusOf(personId), "approved");
});

test("a person blocked, or touched in the last 90 days, between Approve and the delivery: an exited enrollment, suppressed with the reason, no step", async () => {
  await linkedin.createConnectedAccount(WORKSPACE, { ownerUserId: APPROVER });
  const blocked = await leadOf("enroll-blocked");
  const touched = await leadOf("enroll-touched");
  await approve(blocked);
  await approve(touched);
  await asSystem(async () => {
    await addSuppression({ kind: "person", personId: blocked, createdBy: APPROVER });
    await contacts.recordTouch(touched, new Date(Date.now() - 89 * DAY_MS));
  });
  await deliver();
  for (const [personId, exitDetail] of [
    [blocked, "never_contact_person"],
    [touched, "recently_contacted"],
  ] as const) {
    assert.deepEqual(await exitsOf(personId), [
      { status: "exited", exitReason: "suppressed", exitDetail, senderAccountId: null },
    ]);
    assert.deepEqual(await stepsOf(personId), [], `${exitDetail}: no step execution`);
    assert.ok(!(await changesOf(personId)).some(([, to]) => to === "in_campaign"));
  }
});

test("an erased person: the event is delivered and nothing is written", async () => {
  await linkedin.createConnectedAccount(WORKSPACE, { ownerUserId: APPROVER });
  const personId = await leadOf("enroll-erased");
  await approve(personId);
  // contacts' step alone, which leaves the event: the subscriber meets a person who is gone.
  await asSystem(() => contacts.erasePerson(personId));
  const [eventId] = await approvals(personId);
  await deliver();
  const event = await app.outboxEntry.findUniqueOrThrow({ where: { id: eventId } });
  assert.ok(event.deliveredAt !== null);
  assert.deepEqual([await app.enrollment.count(), await app.stepExecution.count()], [0, 0]);
});
