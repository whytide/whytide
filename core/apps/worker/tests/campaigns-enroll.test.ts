// campaigns' enrollment (beta-p2-040; core/modules/campaigns/README.md, docs/flows.md "Approve →
// enrollment") through the outbox, on a schema of the slice's database: campaigns loaded from its
// build by the worker's own loader, its subscribers run by the worker's outbox loop (src/outbox.ts)
// in a tenant run as service:worker. The workspace has an Owner, whose the seeded campaign is, and a
// Member who approves, each with an account of their own unless the test says otherwise. Approve's
// event delivered: one active enrollment with the campaign owner's account, never the approver's
// (gamma-p6-040), four planned steps with four keys, connect due, the template on every row, and
// the lead in_campaign with one change row. Then the same event again, Approve pressed twice before
// the delivery and once after it, an owner without a connected account, a person blocked and one
// touched between Approve and the delivery, an erased person, an enrollment made with the
// approver's account keeping it, and the owner removed by another Owner: their enrollment ended by
// the subscriber to tenancy.member_removed, and a later lead exited no_sender. Contacts', linkedin's
// and tenancy's code and test helpers come from their builds, the files the loader's modules import.
// It lives here: a module never imports a host.
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
const { removeMember } = await import(built("tenancy/dist/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
const log = platform.createLogger({ destination: platform.collectLogs().destination });
await loadModules(moduleLoaders.filter(({ name }) => name === "campaigns"));

const WORKSPACE = "wsp_campaigns_enroll";
/** The workspace's Owner, whose the seeded campaign is, and a Member who approves the leads. */
const OWNER = "usr_campaigns_enroll_owner";
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
/** The workspace, made once, with OWNER its Owner and APPROVER a Member. */
async function members(): Promise<void> {
  if ((await app.workspace.findUnique({ where: { id: WORKSPACE } })) !== null) return;
  await tenancy.createOrganizationWithWorkspace({ workspaceId: WORKSPACE });
  for (const [userId, role] of [
    [OWNER, "Owner"],
    [APPROVER, "Member"],
  ] as const) {
    await app.user.create({ data: { id: userId, email: `${userId}@example.com` } });
    await tenancy.createMembership({ userId, workspaceId: WORKSPACE, role });
  }
}
/** The workspace's members, then a connected account of each user given: their ids, in order. */
async function accounts(...owners: readonly string[]): Promise<string[]> {
  await members();
  const made: string[] = [];
  for (const ownerUserId of owners) {
    made.push((await linkedin.createConnectedAccount(WORKSPACE, { ownerUserId })).id);
  }
  return made;
}
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

test("Approve's event, delivered: one active enrollment with the seeded campaign's owner's account, the workspace Owner's, not the approving Member's own, four planned steps with four keys, connect due, and the lead in_campaign; the same event again changes nothing", async () => {
  const [senderAccountId] = await accounts(OWNER, APPROVER);
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
  await accounts(OWNER);
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

test("the campaign's owner without a connected account: an exited enrollment, no_sender, no step, and the lead stays approved, though the approver has one", async () => {
  // The approving Member's account is not the campaign owner's.
  await accounts(APPROVER);
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
  await accounts(OWNER);
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
  await accounts(OWNER);
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

test("an enrollment made before, with the approver's account as beta made it, keeps that account: a later lead's enrollment takes the owner's, and the earlier one's rows stay as they were", async () => {
  const [ownersAccount, approversAccount] = await accounts(OWNER, APPROVER);
  const before = await leadOf("enroll-beta");
  await approve(before);
  await deliver();
  // As beta's rule wrote it: the approver's own account on the enrollment and its steps.
  const [beta] = await enrollmentsOf(before);
  assert.ok(beta);
  await app.enrollment.update({
    where: { id: beta.id },
    data: { senderAccountId: approversAccount },
  });
  await app.stepExecution.updateMany({
    where: { enrollmentId: beta.id },
    data: { senderAccountId: approversAccount },
  });
  const rows = { enrollments: await enrollmentsOf(before), steps: await stepsOf(before) };

  const later = await leadOf("enroll-after-beta");
  await approve(later);
  await deliver();
  const [enrollment] = await enrollmentsOf(later);
  assert.equal(enrollment?.senderAccountId, ownersAccount);
  assert.deepEqual(
    { enrollments: await enrollmentsOf(before), steps: await stepsOf(before) },
    rows,
    "the earlier enrollment keeps its account",
  );
  assert.ok(rows.steps.every(({ senderAccountId }) => senderAccountId === approversAccount));
});

test("the seeded campaign's owner removed by another Owner: the subscriber to tenancy.member_removed, through the outbox, ends their live enrollment once (no_sender, owner_removed); a lead approved after it exits no_sender with owner_removed and no step", async () => {
  await accounts(OWNER);
  const OTHER = "usr_campaigns_enroll_other_owner";
  await app.user.create({ data: { id: OTHER, email: `${OTHER}@example.com` } });
  await tenancy.createMembership({ userId: OTHER, workspaceId: WORKSPACE, role: "Owner" });
  const enrolled = await leadOf("enroll-owner-removed");
  await approve(enrolled);
  await deliver();
  assert.deepEqual(
    (await enrollmentsOf(enrolled)).map(({ status }) => status),
    ["active"],
  );

  // Removed as Members and roles' route removes them: the row and the event in one run.
  const { id: membershipId } = await app.membership.findFirstOrThrow({
    where: { workspaceId: WORKSPACE, userId: OWNER },
  });
  const other: Principal = { ...approver, userId: OTHER };
  await inRun(other, () => removeMember({ membershipId, removedBy: OTHER }));
  await deliver();
  const [ended] = await exitsOf(enrolled);
  assert.deepEqual(
    [ended?.status, ended?.exitReason, ended?.exitDetail],
    ["exited", "no_sender", "owner_removed"],
  );
  assert.ok(
    (await stepsOf(enrolled)).every(
      ({ status, skipReason }) => status === "cancelled" && skipReason === "owner_removed",
    ),
  );
  assert.equal(await statusOf(enrolled), "finished");
  // The event again, as after a crash before the row's mark: nothing changes.
  const event = await app.outboxEntry.findFirstOrThrow({
    where: { eventName: "tenancy.member_removed" },
  });
  const rows = { enrollments: await enrollmentsOf(enrolled), steps: await stepsOf(enrolled) };
  const due = { deliveredAt: null, nextAttemptAt: new Date(0) };
  await app.outboxEntry.update({ where: { id: event.id }, data: due });
  await deliver();
  assert.deepEqual(
    { enrollments: await enrollmentsOf(enrolled), steps: await stepsOf(enrolled) },
    rows,
  );

  const later = await leadOf("enroll-after-removal");
  await approve(later);
  await deliver();
  assert.deepEqual(await exitsOf(later), [
    {
      status: "exited",
      exitReason: "no_sender",
      exitDetail: "owner_removed",
      senderAccountId: null,
    },
  ]);
  assert.deepEqual(await stepsOf(later), []);
  assert.equal(await statusOf(later), "approved");
});
