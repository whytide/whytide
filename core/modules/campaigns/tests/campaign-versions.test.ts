// Campaigns, versions and steps (gamma-p3-030; README.md "Campaigns and versions", "Enrolling"), on
// the worktree's database in this file's schema, each call in a tenant run as `app`: seedCampaign
// twice at once; saveVersion writing and not writing, refused on an archived or unknown campaign or a
// sequence off its rules; createCampaign; an enrollment through contacts.lead_approved delivered,
// before and after a new version; beta's rows through the migrations; and the database's refusals.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  events as contacts,
  createLeadForPerson,
  recordLeadStatus,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import {
  createOutboxStore,
  databaseUrl,
  outboxWriter,
  runMigrations,
  withTenant,
} from "@whytide/db";
import {
  asRole,
  migrationSet,
  schemaGrantStatements,
  sqlstate,
  withTestDb,
} from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import {
  collectLogs,
  createLogger,
  deliverPending,
  publish,
  servicePrincipal,
} from "@whytide/platform";
import {
  createMembership,
  createOrganizationWithWorkspace,
  createUser,
} from "@whytide/tenancy/testing";
import { createCampaign, saveVersion, seedCampaign } from "../domain/campaigns/commands.ts";
import { FIRST_MESSAGE_DELAY } from "../domain/campaigns/constants.ts";
import { campaignOf, SEEDED_VERSION, versionSteps } from "../domain/campaigns/reads.ts";
import { TEMPLATE_ID, TEMPLATE_STEPS } from "../domain/template/constants.ts";
import { idempotencyKey, stepTemplateHash } from "../domain/template/keys.ts";
import "../events.ts";
import { createEnrollment } from "../testing/index.ts";
import { APPROVER, fixture } from "./fixtures.ts";

const db = withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const WORKSPACE = "wsp_campaign_versions";
const f = fixture(WORKSPACE);
const { app, run, account } = f;
const CHECK = "23514";
const CONNECT = { action: "invite", delay: { anchor: "enrollment" } } as const;
const FIRST_MESSAGE = { action: "message", delay: FIRST_MESSAGE_DELAY } as const;
const after = (value: number) => ({ anchor: "prev_step", unit: "business_days", value }) as const;
const message = (days: number) => ({ action: "message", delay: after(days) }) as const;
const email = (days: number) => ({ action: "email", delay: after(days) }) as const;
const TEMPLATE = TEMPLATE_STEPS.map(({ action, delay }) => ({ action, delay }));
const log = createLogger({ destination: collectLogs().destination });

/** The workspace's rows in tenancy with members of the roles given, oldest first; their ids. */
async function members(...roles: ("Owner" | "Admin" | "Member")[]): Promise<string[]> {
  await createOrganizationWithWorkspace({ workspaceId: WORKSPACE });
  const userIds: string[] = [];
  for (const role of roles) {
    const user = await createUser();
    await createMembership({ userId: user.id, workspaceId: WORKSPACE, role });
    userIds.push(user.id);
  }
  return userIds;
}

/** Approve, as contacts leaves it: the lead approved and contacts.lead_approved in the outbox. */
async function approve(slug: string): Promise<string> {
  const { personId } = await run(async (tx) => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    await recordLeadStatus(person.id, "approved", { actor: { type: "user", id: APPROVER } });
    const payload = { personId: person.id, approvedBy: APPROVER };
    await publish(outboxWriter(tx, WORKSPACE), contacts["contacts.lead_approved"], payload);
    return { personId: person.id };
  });
  return personId;
}

/** One pass of the worker's delivery, each handler in a tenant run of the event's workspace. */
async function deliver(): Promise<void> {
  const report = await deliverPending({
    store: createOutboxStore(app()),
    runInTenant: (workspaceId, fn) =>
      withTenant({ workspaceId, principal: servicePrincipal("worker") }, fn, { client: app() }),
    log,
  });
  assert.equal(report.delivered, report.claimed, JSON.stringify(report));
}

const stepsOf = (personId: string) =>
  app().stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } });

test("two first reads at once leave one seeded campaign with one version 1, owned by the user of the oldest Owner membership", async () => {
  const [, oldest] = await members("Admin", "Owner", "Owner", "Member");
  const [a, b] = await Promise.all([run(() => seedCampaign()), run(() => seedCampaign())]);
  assert.ok(a && b);
  assert.equal(a.id, b.id);
  const campaigns = await app().campaign.findMany();
  assert.deepEqual(
    campaigns.map(({ keyRef, name, status, ownerUserId, createdBy }) => [
      ...[keyRef, name, status, ownerUserId, createdBy],
    ]),
    [[TEMPLATE_ID, "", "active", oldest, "system"]],
  );
  assert.ok(campaigns[0]?.launchedAt instanceof Date);
  const versions = (await app().campaignVersion.findMany()).map((version) => [
    ...[version.id, version.versionNo, version.changeKind, version.createdBy],
  ]);
  assert.deepEqual(versions, [[campaigns[0]?.currentVersionId, 1, "initial", "system"]]);
  assert.equal(await app().step.count(), TEMPLATE_STEPS.length);
  // A workspace without an Owner gets none, and its enrollments read beta's template as version 1.
  const other = fixture("wsp_campaign_versions_ownerless");
  assert.equal(await other.run(() => seedCampaign()), null);
  assert.deepEqual(await other.run(() => versionSteps(TEMPLATE_ID, 1)), SEEDED_VERSION.steps);
  assert.equal(await other.run(() => versionSteps(TEMPLATE_ID, 2)), null);
});

test("saveVersion writes version 2 for other steps and nothing for the current ones; refused on an archived or unknown campaign, or steps off the rules", async () => {
  const [owner = ""] = await members("Owner");
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  const same = await run(() => saveVersion(seeded.id, TEMPLATE, { createdBy: owner }));
  assert.deepEqual(same, { id: seeded.currentVersionId, versionNo: 1, written: false });
  const edited = [CONNECT, FIRST_MESSAGE, email(2), message(4)];
  const saved = await run(() => saveVersion(seeded.id, edited, { createdBy: owner }));
  assert.deepEqual([saved.versionNo, saved.written], [2, true]);
  const again = await run(() => saveVersion(seeded.id, edited, { createdBy: owner }));
  assert.deepEqual(again, { id: saved.id, versionNo: 2, written: false });
  assert.equal((await run(() => campaignOf(seeded.id))).currentVersionId, saved.id);
  const version = await app().campaignVersion.findUniqueOrThrow({ where: { id: saved.id } });
  assert.deepEqual([version.changeKind, version.createdBy], ["structural", owner]);
  assert.deepEqual(
    (await run(() => versionSteps(TEMPLATE_ID, 2)))?.map(({ stepKey, channel }) => [
      stepKey,
      channel,
    ]),
    [
      ["connect", "linkedin"],
      ["message_1", "linkedin"],
      ["email_1", "email"],
      ["follow_up_1", "linkedin"],
    ],
  );
  const refused = (steps: Parameters<typeof saveVersion>[1], id = seeded.id) =>
    run(() => saveVersion(id, steps, { createdBy: owner }));
  await assert.rejects(refused([]), {
    code: "campaign_sequence_invalid",
    details: { rule: "step_count" },
  });
  await assert.rejects(refused(edited, "cmp_unknown"), { code: "campaign_not_found", status: 404 });
  await app().campaign.update({ where: { id: seeded.id }, data: { status: "archived" } });
  await assert.rejects(refused(TEMPLATE), { code: "campaign_archived", status: 409 });
  assert.equal(await app().campaignVersion.count(), 2, "no refusal wrote a version");
});

test("createCampaign makes a draft, its key_ref its own id, with its steps as version 1", async () => {
  const input = { name: "  Warm leads  ", steps: [CONNECT, email(3)], ownerUserId: "usr_owner" };
  const made = await run(() => createCampaign({ ...input, createdBy: "usr_owner" }));
  const campaign = await run(() => campaignOf(made.campaignId));
  assert.deepEqual(
    [
      campaign.keyRef,
      campaign.name,
      campaign.status,
      campaign.launchedAt,
      campaign.currentVersionId,
    ],
    [made.campaignId, "Warm leads", "draft", null, made.id],
  );
  assert.equal(made.versionNo, 1);
  const steps = await run(() => versionSteps(made.campaignId, 1));
  assert.deepEqual(
    steps?.map(({ stepKey, action }) => [stepKey, action]),
    [
      ["connect", "invite"],
      ["email_1", "email"],
    ],
  );
  for (const name of [" ", "x".repeat(81)]) {
    await assert.rejects(
      run(() => createCampaign({ ...input, name, createdBy: "usr_owner" })),
      { code: "campaign_name_invalid" },
    );
  }
});

test("an approval delivered joins the current version: the seeded version 1, then version 2 for the next lead only", async () => {
  // The approver the workspace's Owner: the seeded campaign sends from its owner's account.
  const owner = await f.owned();
  await account();
  const first = await approve("versions-first");
  await deliver();
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  await run(() =>
    saveVersion(seeded.id, [CONNECT, FIRST_MESSAGE, email(2), message(4)], { createdBy: owner }),
  );
  const second = await approve("versions-second");
  await deliver();
  const enrollments = await app().enrollment.findMany({ orderBy: { createdAt: "asc" } });
  assert.deepEqual(
    enrollments.map(({ personId, templateId, templateVersion, status }) => [
      ...[personId, templateId, templateVersion, status],
    ]),
    [
      [first, TEMPLATE_ID, 1, "active"],
      [second, TEMPLATE_ID, 2, "active"],
    ],
  );
  const beta = (await stepsOf(first)).map(({ stepKey, idempotencyKey }) => [
    stepKey,
    idempotencyKey,
  ]);
  assert.deepEqual(
    beta,
    TEMPLATE_STEPS.map((step) => [
      step.stepKey,
      idempotencyKey({
        workspaceId: WORKSPACE,
        personId: first,
        templateId: TEMPLATE_ID,
        stepTemplateHash: stepTemplateHash(step),
      }),
    ]),
  );
  assert.deepEqual(
    (await stepsOf(second)).map(({ stepKey, actionType, senderAccountId, dueAt }) => [
      ...[stepKey, actionType, senderAccountId === null, dueAt === null],
    ]),
    [
      ["connect", "invite", false, false],
      ["message_1", "message", false, true],
      ["email_1", "email", true, true],
      ["follow_up_1", "message", false, true],
    ],
  );
  const changes = await app().leadStatusChange.findMany({ where: { toStatus: "in_campaign" } });
  assert.deepEqual(
    changes.map(({ templateId }) => templateId),
    [TEMPLATE_ID, TEMPLATE_ID],
  );
});

test("beta's enrollments and step executions go through the migrations unchanged, and read as the seeded campaign's version 1", async () => {
  const set = migrationSet("campaign-versions");
  const mine = readdirSync(set.migrations)
    .filter((name) => /^\d{14}_/.test(name) && name >= "20261101124700_campaigns_email_action")
    .sort();
  assert.ok(mine.includes("20261101124816_campaigns_versions"), mine.join());
  const aside = join(set.dir, "aside");
  mkdirSync(aside);
  for (const name of mine) renameSync(join(set.migrations, name), join(aside, name));
  const schema = `${db.schema}_before`;
  const owner = asRole("owner");
  await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  for (const statement of schemaGrantStatements(schema)) await owner.$executeRawUnsafe(statement);
  const url = new URL(databaseUrl("owner"));
  url.searchParams.set("schema", schema);
  const rows = async () => ({
    enrollments: await owner.$queryRawUnsafe(
      `SELECT id, template_id, template_version, status, sender_account_id FROM "${schema}".enrollments`,
    ),
    steps: await owner.$queryRawUnsafe(
      `SELECT id, sender_account_id, template_id, template_version, step_key, position,
         action_type::text, step_template_hash, idempotency_key, status::text, due_at
       FROM "${schema}".step_executions ORDER BY position`,
    ),
  });
  try {
    await runMigrations({ url: url.toString(), config: set.config });
    // Beta's enrollment and its four steps, as beta-p2-040's enrolling wrote them.
    await owner.$executeRawUnsafe(
      `INSERT INTO "${schema}".enrollments (id, workspace_id, person_id, sender_account_id,
         template_id, template_version, status, source_event_id, started_at, updated_at)
       VALUES ('enl_beta', 'wsp_beta', 'per_beta', 'sac_beta', $1, 1, 'active', 'obx_beta', now(), now())`,
      TEMPLATE_ID,
    );
    for (const step of TEMPLATE_STEPS) {
      const hash = stepTemplateHash(step);
      const parts = { workspaceId: "wsp_beta", personId: "per_beta", templateId: TEMPLATE_ID };
      await owner.$executeRawUnsafe(
        `INSERT INTO "${schema}".step_executions (id, workspace_id, enrollment_id, person_id,
           sender_account_id, template_id, template_version, step_key, position, action_type,
           step_template_hash, idempotency_key, status, due_at, updated_at)
         VALUES ($1, 'wsp_beta', 'enl_beta', 'per_beta', 'sac_beta', $2, 1, $3, $4,
           $5::"${schema}".step_action_type, $6, $7, $8::"${schema}".step_execution_status, $9, now())`,
        `sx_beta_${step.position}`,
        TEMPLATE_ID,
        step.stepKey,
        step.position,
        step.action,
        hash,
        idempotencyKey({ ...parts, stepTemplateHash: hash }),
        step.position === 1 ? "succeeded" : "planned",
        step.position === 1 ? new Date("2026-10-30T10:00:00Z") : null,
      );
    }
    const before = await rows();
    for (const name of mine) renameSync(join(aside, name), join(set.migrations, name));
    assert.deepEqual(await runMigrations({ url: url.toString(), config: set.config }), mine);
    assert.deepEqual(await rows(), before);
    const steps = before.steps as {
      step_key: string;
      position: number;
      step_template_hash: string;
    }[];
    assert.deepEqual(
      steps.map(({ step_key, position, step_template_hash }) => [
        step_key,
        position,
        step_template_hash,
      ]),
      SEEDED_VERSION.steps.map(({ stepKey, position, stepTemplateHash: hash }) => [
        ...[stepKey, position, hash],
      ]),
    );
  } finally {
    await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    rmSync(set.dir, { recursive: true, force: true });
  }
});

test("the database refuses a version's change by app, and a step's actor off its channel", async () => {
  const made = await run(() =>
    createCampaign({
      name: "Refusals",
      steps: [CONNECT, email(2)],
      ownerUserId: "usr_owner",
      createdBy: "usr_owner",
    }),
  );
  const [step] = await app().step.findMany({ where: { campaignVersionId: made.id } });
  assert.ok(step);
  const denied = "42501";
  const versionUpdate = app()
    .$executeRaw`UPDATE campaign_versions SET created_by = 'x' WHERE id = ${made.id}`;
  assert.equal(await sqlstate(versionUpdate), denied, "app must not change a version");
  const versionDelete = app().$executeRaw`DELETE FROM campaign_versions WHERE id = ${made.id}`;
  assert.equal(await sqlstate(versionDelete), denied, "app must not remove a version");
  const stepUpdate = app().$executeRaw`UPDATE steps SET position = 9 WHERE id = ${step.id}`;
  assert.equal(await sqlstate(stepUpdate), denied, "app must not change a step");
  const stepDelete = app().$executeRaw`DELETE FROM steps WHERE id = ${step.id}`;
  assert.equal(await sqlstate(stepDelete), denied, "app must not remove a step");

  const { id: senderAccountId } = await account();
  const seeded = { workspaceId: WORKSPACE, personId: "per_refusals", senderAccountId };
  const { stepIds } = await createEnrollment({
    ...seeded,
    steps: [{ stepKey: "connect", status: "planned" }],
  });
  const [connect = ""] = stepIds;
  const write = (data: {
    senderAccountId?: string | null;
    mailboxId?: string | null;
    actionType?: "email";
  }) => sqlstate(app().stepExecution.update({ where: { id: connect }, data }));
  assert.equal(
    await write({ senderAccountId: null }),
    CHECK,
    "a LinkedIn step without its account",
  );
  assert.equal(await write({ mailboxId: "mbx_any" }), CHECK, "a mailbox on a LinkedIn step");
  assert.equal(await write({ actionType: "email" }), CHECK, "an email step with an account");
  assert.equal(
    await write({ actionType: "email", senderAccountId: null, mailboxId: "mbx_any" }),
    undefined,
    "an email step with its mailbox and no account",
  );
});
