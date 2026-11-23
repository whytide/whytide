// Safety case of the queue's pages (gamma-p0-085; core/modules/campaigns/README.md "The queue"), on
// the slice's Temporal and a schema of its database: campaigns and messaging loaded from their
// builds by the worker's own loader, the activities through the host's wrapper, the subscribers run
// by the worker's outbox loop, the workflow starter bound to a recorder. With pages of two
// (useQueuePageSize, under APP_ENV=test only), five due connection requests take three runs of one
// workflow id, each run continued as new after the last step of its page: every step is asked once,
// in id order, and opened once; a step whose open failed stays planned, is not asked again before
// the next tick, and is opened then, once. The approver is the workspace's Owner, so the seeded
// campaign sends from their account (gamma-p6-040).
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ApplicationFailure, Context } from "@temporalio/activity";
import type { TenantClient } from "@whytide/db";
import type { Principal, WorkflowStart } from "@whytide/platform";

// The fakes, whatever the environment names: nothing here calls a provider, and nothing may.
process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_LLM = "fake";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { hostActivity } = await import("../../src/activities.ts");
const { moduleLoaders } = await import("../../src/modules.generated.ts");
const { loadModules } = await import("../../src/modules.ts");
const { startOutboxLoop } = await import("../../src/outbox.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../../testing/index.ts");
const built = (file: string) => new URL(`../../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { approveLead } = await import(built("contacts/dist/domain/outreach/status.js"));
const { useQueuePageSize } = await import(built("campaigns/dist/workflows/queue.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
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
type Activity = (input: never) => Promise<unknown>;
const activities: Record<string, Activity> = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app, log })];
  }),
);
/** Every start the subscribers ask for, recorded; none runs. */
const starts: WorkflowStart[] = [];
platform.bindWorkflowStarter({
  start: async (request) => {
    starts.push(request);
    return { started: true };
  },
});

const APPROVER = "usr_queue_pages_approver";
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

/** A workspace whose Owner is the approver, with their connected account, in UTC. */
async function workspaceWithAccount(): Promise<string> {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const user = { id: APPROVER, email: `${APPROVER}@example.com` };
  await app.user.upsert({ where: { id: APPROVER }, create: user, update: {} });
  await tenancy.createMembership({ userId: APPROVER, workspaceId: workspace.id, role: "Owner" });
  await linkedin.createConnectedAccount(workspace.id, { ownerUserId: APPROVER });
  return workspace.id;
}

/** `count` people approved by the approver and enrolled by campaigns' subscriber. */
async function enrolled(workspaceId: string, count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const personId: string = await inRun(workspaceId, service, async () => {
      const linkedinUrl = `https://linkedin.com/in/queue-pages-${n}`;
      const { person } = await contacts.upsertPersonFromSource({
        ...{ source: "import", provider: "csv", profile: { linkedinUrl, firstName: "Noor" } },
      });
      await contacts.createLeadForPerson({
        personId: person.id,
        source: { kind: "imported", ref: "imp_1" },
      });
      return person.id;
    });
    await inRun(workspaceId, approver, () => approveLead(personId));
  }
  await deliver();
}

/**
 * The workspace's queue run to its end, recording each run's cursor and each step asked; the step
 * `failing` fails its first open, past its attempts.
 */
async function queue(workspaceId: string, failing?: string) {
  const runs: { runId: string; afterId?: string }[] = [];
  const asked: string[] = [];
  let failed = false;
  const campaigns_due_steps = async (input: { afterId?: string }) => {
    const runId = Context.current().info.workflowExecution?.runId ?? "";
    runs.push({ runId, ...(input.afterId !== undefined && { afterId: input.afterId }) });
    return activities.campaigns_due_steps?.(input as never);
  };
  const campaigns_queue_step = async (input: { stepExecutionId: string }) => {
    asked.push(input.stepExecutionId);
    if (input.stepExecutionId === failing && !failed) {
      failed = true;
      throw ApplicationFailure.create({ type: "activity_failed", nonRetryable: true });
    }
    return activities.campaigns_queue_step?.(input as never);
  };
  const replaced = { ...activities, campaigns_due_steps, campaigns_queue_step };
  const counts = await runWorkflow("campaigns_queue", { workspaceId }, { activities: replaced });
  return { counts, runs, asked };
}

const itemsOf = (stepExecutionId: string) => app.approvalItem.count({ where: { stepExecutionId } });

test("five due steps in pages of two: three runs of one id, each continued after its page's last step; every step asked once in id order and opened once; one whose open failed stays planned, unasked until the next tick, which opens it once", async () => {
  const workspaceId = await workspaceWithAccount();
  await enrolled(workspaceId, 5);
  const due = await app.stepExecution.findMany({
    where: { workspaceId, stepKey: "connect", status: "planned" },
    orderBy: { id: "asc" },
  });
  const ids = due.map(({ id }) => id);
  assert.equal(ids.length, 5);
  const failing = ids[1];
  assert.ok(failing);

  useQueuePageSize(2);
  try {
    const first = await queue(workspaceId, failing);
    assert.deepEqual(first.counts, { opened: 4, passedOver: 0, noSender: 0, failed: 1 });
    assert.deepEqual(first.asked, ids, "each step asked once, in id order");
    assert.deepEqual(
      first.runs.map(({ afterId }) => afterId),
      [undefined, ids[1], ids[3]],
    );
    assert.equal(new Set(first.runs.map(({ runId }) => runId)).size, 3, "three runs");
    for (const id of ids) assert.equal(await itemsOf(id), id === failing ? 0 : 1);
    const left = await app.stepExecution.findUniqueOrThrow({ where: { id: failing } });
    assert.deepEqual([left.status, left.approvalItemId], ["planned", null]);

    const next = await queue(workspaceId);
    assert.deepEqual(next.counts, { opened: 1, passedOver: 0, noSender: 0, failed: 0 });
    assert.deepEqual(next.asked, [failing]);
    assert.equal(next.runs.length, 1);
  } finally {
    useQueuePageSize(undefined);
  }
  for (const id of ids) assert.equal(await itemsOf(id), 1, "one item each");
});
