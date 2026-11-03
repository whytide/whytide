// A run's stop (fix-run-stop; core/modules/signals/README.md "Runs") through the worker host, on the
// slice's Temporal and a schema of its database: the host started with credits, linkedin and signals,
// on the LinkedIn and files fakes set here before the providers load, its outbox loop delivering
// signals' events to their subscribers, and its canceller bound to cancelWorkflow. A run started under
// a known id, as a schedule starts one, records that id at its start; asleep on the read cap, a stop
// asked as the route asks it (stopRun, in a tenant run) cancels it by that id, and it ends cancelled;
// a run stopped while still scheduled ends cancelled at its start, before any read; deleting a source
// cancels its waiting run. linkedin's clock (useClock) holds a past working day at 10:00 UTC, so a
// refusal for the cap waits a second at a time (signals-run.test.ts). Pages cost no credits
// (beta-p1-090): a run stopped before any profile read holds none.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkflowNotFoundError } from "@temporalio/client";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { collectLogs, createLogger, loadMasterKeys, newId, newMasterKey, servicePrincipal } =
  await import("@whytide/platform");
const { getAdapter, linkedinPort } = await import("@whytide/providers");
const { ids: creditsIds } = await import("@whytide/credits");
const { grantAllowance, useCreditsClient } = await import("@whytide/credits/testing");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { start } = await import("../src/start.ts");
const { withTestWorkflowEnvironment } = await import("../testing/index.ts");

// The modules' commands and test hooks by their builds' paths, the files the worker's loader imports.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type Sources = typeof import("../../../modules/signals/dist/domain/sources.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const sources: Sources = await built("signals/dist/domain/sources.js");
const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
type LinkedinFake = import("@whytide/providers").LinkedinFake;
type Engager = import("@whytide/providers").Engager;
type WorkerHost = import("../src/start.ts").WorkerHost;

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
linkedin.useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const log = createLogger({ destination: collectLogs().destination });
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const WEDNESDAY = new Date("2026-10-07T10:00:00.000Z");
const cancelled = { message: "Workflow execution cancelled" };
let host: WorkerHost;

before(async () => {
  const names = new Set(["credits", "linkedin", "signals"]);
  const modules = moduleLoaders.filter(({ name }) => names.has(name));
  const taskQueue = `test-${randomUUID()}`;
  host = await start({ modules, taskQueue, healthPort: 0, client: db(), log, schedules: "off" });
  linkedin.useClock(() => WEDNESDAY);
});
after(async () => {
  linkedin.useClock(undefined);
  await host?.close();
});

const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal: servicePrincipal("test") }, fn, { client: db() });
/** What `read` answers once it answers something, within thirty seconds. */
async function until<T>(read: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}

/** `count` engagers, the newest an hour ago, a minute apart. */
const engagers = (count: number): Engager[] =>
  Array.from({ length: count }, (_, n) => ({
    providerMemberRef: `member-${n}`,
    profileUrl: `https://www.linkedin.com/in/member-${n}`,
    name: `Member ${n}`,
    headline: "Head of sales",
    reaction: "like" as const,
    engagedAt: new Date(Date.now() - 3_600_000 - n * 60_000),
  }));

/**
 * A workspace with credits, a connected account the fake knows that reads one page a day, and a
 * source on a post of 30 engagers it seeds: a run reads the first page, then waits for the cap.
 */
async function sourceOf() {
  const price = (action: string, unit: string) => ({
    id: newId(creditsIds.price_list_entry),
    ...{ action, credits: 1, unit, version: 1, effectiveFrom: new Date(Date.now() - 60_000) },
  });
  await asRole("billing_writer").priceListEntry.createMany({
    data: [price("signals.engager", "engager"), price("signals.engager_read", "engagers_30")],
    skipDuplicates: true,
  });
  const [tenant] = await tenancy.createTwoWorkspaces();
  const workspaceId = tenant.workspace.id;
  await grantAllowance([tenant.organization.id], 100);
  const providerAccountRef = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", providerAccountRef);
  const account = await linkedin.createConnectedAccount(workspaceId, { providerAccountRef });
  await db().senderAccount.update({ where: { id: account.id }, data: { dailyReadCap: 1 } });
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${Date.now()}`;
  fake.seedPost(postUrl, engagers(30));
  const source = await db().signalSource.create({
    data: {
      id: newId("src"),
      workspaceId,
      kind: "post_engagers",
      config: { postUrl },
      label: "Launch post",
      senderAccountId: account.id,
      createdBy: tenant.user.id,
    },
  });
  return { workspaceId, sourceId: source.id, accountId: account.id };
}
type Source = Awaited<ReturnType<typeof sourceOf>>;

/** The source's run started as its schedule starts one, under a known id, waiting for the cap. */
async function waitingRun(source: Source) {
  const workflowId = `signals-${source.sourceId}-2026-10-07T10:00:00Z`;
  const handle = await env.client.workflow.start("signals_run", {
    args: [{ workspaceId: source.workspaceId, sourceId: source.sourceId }],
    taskQueue: host.taskQueue,
    workflowId,
    workflowExecutionTimeout: "1 minute",
  });
  const where = { sourceId: source.sourceId, status: "waiting" as const };
  const row = await until(() => db().signalRun.findFirst({ where }));
  return { workflowId, handle, row };
}

/** The run's row, its staging, its read reservations and its credits, a block's or a candidate's. */
async function stateOf(source: Source, runId: string) {
  const row = await db().signalRun.findUnique({ where: { id: runId } });
  const reads = await db().senderQuotaReservation.findMany({
    where: { senderAccountId: source.accountId },
    orderBy: { id: "asc" },
  });
  const credits = await db().creditUsage.findMany({
    where: { OR: [{ subjectRef: runId }, { idempotencyKey: { startsWith: `sigprof:${runId}:` } }] },
  });
  return {
    row,
    staged: await db().signalCandidate.count({ where: { runId } }),
    reads: reads.map(({ count, committed, status }) => [count, committed, status]),
    credits: credits.map((usage) => [usage.quantity.toFixed(), usage.status]),
  };
}

test("a run started under a known id records it; asleep on the cap, a stop asked as the route asks it cancels that workflow and the run ends cancelled, its page read free and nothing left reserved", async () => {
  const source = await sourceOf();
  const { workflowId, handle, row } = await waitingRun(source);
  assert.equal(row.workflowId, workflowId);

  const stopped = await inRun(source.workspaceId, () => sources.stopRun(source.sourceId, row.id));
  assert.equal(stopped.status, "waiting");
  await assert.rejects(handle.result(), cancelled);
  const state = await stateOf(source, row.id);
  assert.deepEqual(
    [state.row?.status, state.row?.error, state.row?.finishedAt !== null],
    ["cancelled", null, true],
  );
  assert.deepEqual(state.row?.stopRequestedAt, stopped.stopRequestedAt);
  assert.equal(state.staged, 0);
  assert.deepEqual(state.reads, [[1, 1, "committed"]]);
  assert.deepEqual(state.credits, []);
});

test("a run stopped while still scheduled ends cancelled when its workflow starts, before any read: no read and no credits reserved", async () => {
  const source = await sourceOf();
  const run = await inRun(source.workspaceId, async () => {
    const requested = await sources.requestRun(source.sourceId);
    await sources.stopRun(source.sourceId, requested.id);
    return requested;
  });
  const workflowId = `signals.run:${source.workspaceId}:${run.id}`;
  const handle = env.client.workflow.getHandle(workflowId);
  const closed = await until(async () => {
    const described = await handle.describe().catch((error: unknown) => {
      if (error instanceof WorkflowNotFoundError) return undefined;
      throw error;
    });
    return described?.closeTime === undefined ? undefined : described;
  });
  assert.equal(closed.status.name, "COMPLETED");
  assert.deepEqual(await handle.result(), { runId: run.id, status: "gone" });
  const state = await stateOf(source, run.id);
  assert.deepEqual(
    [state.row?.status, state.row?.startedAt, state.row?.finishedAt !== null],
    ["cancelled", null, true],
  );
  assert.equal(state.row?.workflowId, workflowId);
  assert.deepEqual([state.reads, state.credits], [[], []]);
});

test("deleting a source whose run waits for the cap cancels that run's workflow", async () => {
  const source = await sourceOf();
  const { handle, row } = await waitingRun(source);
  await inRun(source.workspaceId, () => sources.deleteSource(source.sourceId));
  await assert.rejects(handle.result(), cancelled);
  const state = await stateOf(source, row.id);
  assert.equal(state.row, null);
  assert.deepEqual(state.reads, [[1, 1, "committed"]]);
  assert.deepEqual(state.credits, []);
});
