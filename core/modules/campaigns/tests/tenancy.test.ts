// test:tenancy for campaigns' tables (docs/rules/security.md §3; core/packages/db README "Register a
// tenant table in the isolation test"): an enrollment and its step executions, made by enrolling an
// approved lead and read in a run of one workspace through the scoped client (the module has no
// query yet), are that workspace's only; so are a campaign, its version and its steps, made by
// createCampaign (gamma-p3-030); erasePerson deletes the person's rows and nobody else's;
// lockPersonSteps holds them for privacy's lead deletion and counts the steps that went out; a reply
// label and the queue run's reminders act on enrollments of the run's workspace only (gamma-p4-050);
// and enrolling, erasing, the campaigns' commands and the reply actions go through the tenant client.
import assert from "node:assert/strict";
import test from "node:test";
import { createLeadForPerson, recordLeadStatus, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { type TenantClient, tenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { createConnectedAccount, useLinkedinClient } from "@whytide/linkedin/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { createMembership, createOrganizationWithWorkspace } from "@whytide/tenancy/testing";
import { createCampaign, saveVersion, seedCampaign } from "../domain/campaigns/commands.ts";
import { campaignOf, versionSteps } from "../domain/campaigns/reads.ts";
import { enrollApproved } from "../domain/enroll/enroll.ts";
import { erasePerson, lockPersonSteps } from "../domain/erase.ts";
import { holdForReply } from "../domain/hold.ts";
import { applyReplyLabel } from "../domain/replies/apply.ts";
import { exitSuppressedDue, publishDueReminders } from "../domain/replies/due.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const client = asRole("app");
useLinkedinClient(client);
const APPROVER = "usr_campaigns_tenancy";
const principal = servicePrincipal("campaigns_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client });

/** A lead of the workspace, approved by APPROVER and enrolled by the subscriber's body: its id. */
const enrolled = (workspaceId: string, slug: string) =>
  inRun(workspaceId, async (tx) => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    // Approved, as Approve leaves the lead: only an approved lead is enrolled.
    await recordLeadStatus(person.id, "approved", { actor: { type: "user", id: APPROVER } });
    const approval = { sourceEventId: newId("obx"), personId: person.id, approvedBy: APPROVER };
    assert.equal(await enrollApproved(tx, approval), "enrolled");
    return person.id;
  });
/** The workspace, made if missing, with APPROVER its Owner: the seeded campaign's owner, whose
 * account it sends from (gamma-p6-040). */
async function ownedByApprover(workspaceId: string): Promise<void> {
  if ((await client.workspace.findUnique({ where: { id: workspaceId } })) === null) {
    await createOrganizationWithWorkspace({ workspaceId });
  }
  const user = { id: APPROVER, email: `${APPROVER}@example.com` };
  await client.user.upsert({ where: { id: APPROVER }, create: user, update: {} });
  const member = { workspaceId, userId: APPROVER };
  if ((await client.membership.count({ where: member })) === 0) {
    await createMembership({ ...member, role: "Owner" });
  }
}
/** A workspace whose Owner, APPROVER, has a connected account, with one enrolled lead: the
 * person's id. */
async function enrolledIn(workspaceId: string): Promise<string> {
  await ownedByApprover(workspaceId);
  await createConnectedAccount(workspaceId, { ownerUserId: APPROVER });
  return enrolled(workspaceId, "tenancy");
}

isolationTest("enrollments", {
  async createRow(workspaceId) {
    const personId = await enrolledIn(workspaceId);
    return inRun(workspaceId, () =>
      tenantClient.enrollment.findFirstOrThrow({ where: { personId } }),
    );
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.enrollment.findMany()),
});

isolationTest("step_executions", {
  async createRow(workspaceId) {
    const personId = await enrolledIn(workspaceId);
    const where = { personId, stepKey: "connect" };
    return inRun(workspaceId, () => tenantClient.stepExecution.findFirstOrThrow({ where }));
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.stepExecution.findMany()),
});

/** A campaign of the workspace with its version 1 of two steps, by createCampaign. */
const campaignIn = (workspaceId: string) =>
  inRun(workspaceId, () =>
    createCampaign({
      name: "Isolation",
      steps: [
        { action: "invite", delay: { anchor: "enrollment" } },
        { action: "email", delay: { anchor: "prev_step", unit: "business_days", value: 2 } },
      ],
      ownerUserId: APPROVER,
      createdBy: APPROVER,
    }),
  );

isolationTest("campaigns", {
  async createRow(workspaceId) {
    return { id: (await campaignIn(workspaceId)).campaignId };
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.campaign.findMany()),
});

isolationTest("campaign_versions", {
  createRow: campaignIn,
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.campaignVersion.findMany()),
});

isolationTest("steps", {
  async createRow(workspaceId) {
    const { id } = await campaignIn(workspaceId);
    const where = { campaignVersionId: id, position: 1 };
    return inRun(workspaceId, () => tenantClient.step.findFirstOrThrow({ where }));
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.step.findMany()),
});

test("erasePerson deletes the person's step executions and enrollments, and nobody else's", async () => {
  const [a, b] = ["wsp_campaigns_erase_a", "wsp_campaigns_erase_b"];
  const gone = await enrolledIn(a);
  const kept = await enrolled(a, "tenancy-kept");
  const elsewhere = await enrolledIn(b);
  const persons = async () => {
    const rows = [
      ...(await client.enrollment.findMany({ select: { personId: true } })),
      ...(await client.stepExecution.findMany({ select: { personId: true } })),
    ];
    return rows.map(({ personId }) => personId).sort();
  };
  const before = await persons();
  assert.equal(before.length, 15, "three enrollments, twelve steps");

  const erased = await inRun(a, () => erasePerson(gone));
  assert.deepEqual(erased, { step_executions: 4, enrollments: 1 });
  assert.deepEqual(
    await persons(),
    before.filter((personId) => personId !== gone),
  );
  assert.deepEqual(new Set(await persons()), new Set([kept, elsewhere]));
  // Again, nothing is left to delete; no id is refused before any delete runs.
  assert.deepEqual(await inRun(a, () => erasePerson(gone)), { step_executions: 0, enrollments: 0 });
  await assert.rejects(
    inRun(a, () => erasePerson(" ")),
    { code: "person_not_found" },
  );
  assert.equal((await persons()).length, 10);
});

test("lockPersonSteps holds the person's enrollment and steps for the run and counts those that went out", async () => {
  const workspaceId = "wsp_campaigns_lock";
  const personId = await enrolledIn(workspaceId);
  const free = () =>
    Promise.all([
      asRole("owner").$queryRaw<unknown[]>`
        SELECT 1 FROM enrollments WHERE person_id = ${personId} FOR UPDATE SKIP LOCKED`,
      asRole("owner").$queryRaw<unknown[]>`
        SELECT 1 FROM step_executions WHERE person_id = ${personId} FOR UPDATE SKIP LOCKED`,
    ]).then((found) => found.flat().length);
  const held = await inRun(workspaceId, async () => [
    await lockPersonSteps(personId),
    await free(),
  ]);
  assert.deepEqual(held, [{ wentOut: 0 }, 0], "nothing went out; all five rows held");
  assert.equal(await free(), 5, "released with the run");
  const step = (stepKey: string, data: { status: "succeeded" | "executing"; executedAt?: Date }) =>
    inRun(workspaceId, (tx) => tx.stepExecution.updateMany({ where: { personId, stepKey }, data }));
  await step("connect", { status: "succeeded", executedAt: new Date() });
  await step("message_1", { status: "executing" });
  assert.deepEqual(await inRun(workspaceId, () => lockPersonSteps(personId)), { wentOut: 2 });
  assert.deepEqual(await inRun(workspaceId, () => lockPersonSteps("per_unknown")), { wentOut: 0 });
  await assert.rejects(
    inRun(workspaceId, () => lockPersonSteps(" ")),
    { code: "person_not_found" },
  );
});

test("enrolling, erasing and the campaigns' commands go through the tenant client", async () => {
  const approval = { sourceEventId: "obx_unknown", personId: "per_unknown", approvedBy: APPROVER };
  await assertScoped(() => enrollApproved(tenantClient, approval));
  await assertScoped(() => erasePerson("per_unknown"));
  await assertScoped(() => lockPersonSteps("per_unknown"));
  await assertScoped(() => seedCampaign());
  await assertScoped(() => campaignOf("cmp_unknown"));
  await assertScoped(() => versionSteps("linkedin_default", 1));
  await assertScoped(() => saveVersion("cmp_unknown", [], { createdBy: APPROVER }));
});

test("a reply label and the queue run's reminders act on the run's workspace only", async () => {
  const [a, b] = ["wsp_campaigns_replies_a", "wsp_campaigns_replies_b"];
  const inA = await enrolledIn(a);
  const inB = await enrolledIn(b);
  // Both held by a not-now reply a month and a day ago, as inbox's store leaves them.
  const repliedAt = new Date(Date.now() - 31 * 86_400_000);
  await inRun(a, () => holdForReply(inA, { at: repliedAt }));
  await inRun(b, () => holdForReply(inB, { at: repliedAt }));
  const notNow = { label: "not_now", suggested: false, returnDate: null, repliedAt } as const;
  const label = { ...notNow, threadId: "thr_tenancy", ownerUserId: APPROVER };

  // A's run finds nothing of B's person.
  assert.deepEqual(await inRun(a, () => applyReplyLabel(inB, label)), {
    actions: [],
    enrollmentIds: [],
  });
  assert.deepEqual((await inRun(b, () => applyReplyLabel(inB, label))).actions, [
    "label_recorded",
    "reminder_set",
  ]);
  await inRun(a, () => applyReplyLabel(inA, label));
  // A's queue run publishes A's reminder only; B's waits for its own run.
  assert.equal(await inRun(a, () => publishDueReminders(new Date())), 1);
  const reminded = await client.enrollment.findMany({
    where: { remindedAt: { not: null } },
    select: { workspaceId: true },
  });
  assert.deepEqual(
    reminded.map(({ workspaceId }) => workspaceId),
    [a],
  );
  const notices = await client.outboxEntry.findMany({
    where: { eventName: "campaigns.reply_notice_due" },
    select: { workspaceId: true },
  });
  assert.deepEqual(
    notices.map(({ workspaceId }) => workspaceId),
    [a],
  );
});

test("the reply actions go through the tenant client", async () => {
  const label = {
    label: "other",
    suggested: false,
    returnDate: null,
    repliedAt: new Date(),
  } as const;
  await assertScoped(() =>
    applyReplyLabel("per_unknown", { ...label, threadId: "thr_1", ownerUserId: APPROVER }),
  );
  await assertScoped(() => publishDueReminders(new Date()));
  await assertScoped(() => exitSuppressedDue(new Date()));
});
