// campaigns' agents' campaigns end to end (gamma-p3-065; core/modules/campaigns/README.md "Agents'
// campaigns", "Enrolling"), on the slice's Temporal and a schema of its database: campaigns and
// messaging loaded from their builds by the worker's own loader, the activities through the host's
// wrapper, the subscribers run by the worker's outbox loop, and the workflow starter bound to a
// recorder, so messaging's writer does not run. playbooks.playbook_created, delivered twice as a
// redelivery would, makes the agent's one draft campaign with the warm-signal steps; a lead approved
// from the agent's source is enrolled into it and waits, the queue run opening nothing of it; the
// campaign set active through campaigns' testing helper, in launchCampaign's stead, the next queue run
// opens its connection request's item; and an imported lead joins the seeded campaign, which the run
// opens at once. Each sends from its campaign owner's account (gamma-p6-040): the agent's from the
// approver's, the agent's owner and a Member, and the seeded campaign's from the workspace Owner's.
// Contacts', linkedin's, tenancy's, playbooks' and campaigns' code and test helpers come from their
// builds, the files the loader's modules import. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { Principal, WorkflowStart } from "@whytide/platform";

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
const campaigns = await import(built("campaigns/dist/testing/index.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const playbooks = await import(built("playbooks/dist/index.js"));
const { createPlaybook } = await import(built("playbooks/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const loaded = await loadModules(
  moduleLoaders.filter(({ name }) => name === "campaigns" || name === "messaging"),
);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app, log })];
  }),
);
/** Every start the queue run and the subscribers ask for answers started; none runs. */
platform.bindWorkflowStarter({
  start: async (_request: WorkflowStart) => ({ started: true }),
});

const APPROVER = "usr_campaigns_approver";
const SOURCE = "src_agent_routing";
const NONE = { opened: 0, passedOver: 0, noSender: 0, failed: 0 };
const WARM = [
  "connect",
  "message_1",
  "follow_up_1",
  "follow_up_2",
  "email_1",
  "email_2",
  "email_3",
];
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

/**
 * A workspace with an Owner, who owns the seeded campaign, and the approver, a Member who owns the
 * agents; each with a connected account, the one their campaigns send from (gamma-p6-040).
 */
async function workspaceWithAccounts() {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const workspaceId: string = workspace.id;
  const owner = await tenancy.createUser();
  await tenancy.createMembership({ userId: owner.id, workspaceId, role: "Owner" });
  const user = { id: APPROVER, email: `${APPROVER}@example.com` };
  await app.user.upsert({ where: { id: APPROVER }, create: user, update: {} });
  await tenancy.createMembership({ userId: APPROVER, workspaceId, role: "Member" });
  const account = async (ownerUserId: string): Promise<string> =>
    (await linkedin.createConnectedAccount(workspaceId, { ownerUserId })).id;
  return { workspaceId, owners: await account(owner.id), approvers: await account(APPROVER) };
}
/** The person's enrollments' sender accounts. */
const sendersOf = async (personId: string) =>
  (await app.enrollment.findMany({ where: { personId } })).map(
    ({ senderAccountId }) => senderAccountId,
  );

/** The approver's agent holding SOURCE, its creation published `times` times and delivered. */
async function agent(workspaceId: string, name: string, times = 1): Promise<string> {
  const icpId = "icp_agent_routing";
  const seeded = { workspaceId, icpId, ownerUserId: APPROVER, name, sourceIds: [SOURCE] };
  const playbookId: string = await createPlaybook(seeded, app);
  const created = { playbookId, ownerUserId: APPROVER, icpId };
  for (let time = 0; time < times; time += 1) {
    await inRun(workspaceId, service, (tx) => {
      const outbox = outboxWriter(tx, workspaceId);
      return platform.publish(outbox, playbooks.events["playbooks.playbook_created"], created);
    });
  }
  await deliver();
  return playbookId;
}

/** A person whose lead came from the source given, approved by the approver and delivered. */
async function approvedLead(
  workspaceId: string,
  slug: string,
  source: { kind: "signal" | "imported"; ref: string },
): Promise<string> {
  const personId: string = await inRun(workspaceId, service, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await contacts.upsertPersonFromSource({
      ...{ source: "import", provider: "csv", profile },
    });
    await contacts.createLeadForPerson({ personId: person.id, source });
    return person.id;
  });
  await inRun(workspaceId, approver, () => approveLead(personId));
  await deliver();
  return personId;
}

const queueRun = (workspaceId: string) =>
  runWorkflow("campaigns_queue", { workspaceId }, { activities });
const enrollmentsOf = async (personId: string) =>
  (await app.enrollment.findMany({ where: { personId } })).map(
    ({ templateId, templateVersion, status }) => [templateId, templateVersion, status],
  );
const stepsOf = (personId: string) =>
  app.stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } });
const itemsOf = (personId: string) => app.approvalItem.findMany({ where: { personId } });

test("an agent's creation, delivered twice, makes one draft campaign; its lead waits in it, from the agent's owner's account, and once the campaign is active the queue run opens its first item", async () => {
  const { workspaceId, approvers } = await workspaceWithAccounts();
  const playbookId = await agent(workspaceId, "Warm leads in fintech", 2);
  const campaignsOf = await app.campaign.findMany({ where: { workspaceId, playbookId } });
  assert.deepEqual(
    campaignsOf.map(({ name, status, ownerUserId, createdBy, launchedAt }) => [
      ...[name, status, ownerUserId, createdBy, launchedAt],
    ]),
    [["Warm leads in fintech", "draft", APPROVER, "system", null]],
  );
  const [campaign] = campaignsOf;
  assert.ok(campaign);
  const versions = await app.campaignVersion.findMany({ where: { campaignId: campaign.id } });
  assert.deepEqual(
    versions.map(({ id, versionNo }) => [id, versionNo]),
    [[campaign.currentVersionId, 1]],
  );
  const steps = await app.step.findMany({
    where: { campaignVersionId: campaign.currentVersionId ?? "" },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(
    steps.map(({ stepKey }) => stepKey),
    WARM,
  );

  const personId = await approvedLead(workspaceId, "agent-routing", {
    kind: "signal",
    ref: SOURCE,
  });
  assert.deepEqual(await enrollmentsOf(personId), [[campaign.keyRef, 1, "active"]]);
  assert.deepEqual(await sendersOf(personId), [approvers]);
  assert.deepEqual(
    (await stepsOf(personId)).map(({ stepKey, status }) => `${stepKey}:${status}`),
    WARM.map((key) => `${key}:planned`),
  );
  // The connection request is due from the enrollment on, but its campaign is a draft.
  assert.deepEqual(await queueRun(workspaceId), NONE);
  assert.deepEqual(await itemsOf(personId), []);

  await campaigns.setCampaignActive({ workspaceId, campaignId: campaign.id }, app);
  assert.deepEqual(await queueRun(workspaceId), { ...NONE, opened: 1 });
  const [connect] = await stepsOf(personId);
  const [item, ...more] = await itemsOf(personId);
  assert.ok(connect && item);
  assert.deepEqual(more, []);
  assert.deepEqual([connect.status, connect.approvalItemId], ["awaiting_approval", item.id]);
  assert.deepEqual([item.status, item.stepKey], ["pending", "connect"]);
});

test("an imported lead joins the seeded campaign, an agent there or not, from the workspace Owner's account, and the queue run opens its first item at once", async () => {
  const { workspaceId, owners } = await workspaceWithAccounts();
  await agent(workspaceId, "Agent with a source");
  const personId = await approvedLead(workspaceId, "agent-imported", {
    kind: "imported",
    ref: "imp_1",
  });
  const seeded = await app.campaign.findFirstOrThrow({ where: { workspaceId, playbookId: null } });
  assert.deepEqual(await enrollmentsOf(personId), [[seeded.keyRef, 1, "active"]]);
  assert.deepEqual(await sendersOf(personId), [owners]);
  assert.equal((await stepsOf(personId)).length, 4, "beta's template");
  assert.deepEqual(await queueRun(workspaceId), { ...NONE, opened: 1 });
  assert.deepEqual(
    (await itemsOf(personId)).map(({ stepKey }) => stepKey),
    ["connect"],
  );
});
