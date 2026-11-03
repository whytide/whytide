// linkedin's daily job (beta-p1-080; core/modules/linkedin/README.md "Worker", docs/flows.md "The
// daily job"), on the slice's Temporal and a schema of its database, the fakes set before the
// providers load: linkedin loaded from its build by the worker's own loader, its activities through
// the host's wrapper as `app`, on a worker of the test's queue, and the host's starter, which starts
// each workspace's run on that queue, the starts recorded. linkedin's clock (useClock) moves a day
// at a time. linkedin_daily starts one linkedin_daily_workspace per workspace and purges the
// receipts past 7 days; a workspace's run ramps its accounts, expires the holds no reservation swept
// and purges its own action log past 90 days; a second run the same day changes nothing; a failing
// workspace, or a failed start, stops no other and no purge. The schedule itself is the loader's
// (`schedules`), not upserted here: the host's start would race linkedin-status-refresh.test.ts's
// on the module's schedules. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";

const { WorkflowFailedError } = await import("@temporalio/client");
const { NativeConnection, Worker } = await import("@temporalio/worker");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { bindWorkflowStarter, collectLogs, createLogger, newId } = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { workflowStarter } = await import("../src/starter.ts");
const { IDENTITY, metricSinks, workflowBundle } = await import("../src/temporal.ts");
const { withTestWorkflowEnvironment } = await import("../testing/index.ts");

// linkedin's and tenancy's test hooks by their builds' paths, as the loader imports the modules.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type LinkedinIds = typeof import("../../../modules/linkedin/dist/ids.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
const { ids }: LinkedinIds = await built("linkedin/dist/ids.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
type WorkflowStart = import("@whytide/platform").WorkflowStart;
type WorkspaceDay = { accounts: number; ramped: number; staleDays: number; logDeleted: number };

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
const log = createLogger({ destination: collectLogs().destination });
const loaded = await loadModules(moduleLoaders.filter(({ name }) => name === "linkedin"));
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app, log })];
  }),
);
const DAY_MS = 86_400_000;
/** The schedule's time, 00:30 UTC, on Monday 2 November 2026: still Sunday in Los Angeles. */
const FIRST = Date.UTC(2026, 10, 2, 0, 30);
const at = (day: number) => new Date(FIRST + day * DAY_MS);
const utcDate = (day: number) => at(day).toISOString().slice(0, 10);

/** The host's starter, on the test's queue: each start recorded with its answer, or refused. */
const starts: (WorkflowStart & { started: boolean })[] = [];
let refused: string | undefined;
let connection: import("@temporalio/worker").NativeConnection | undefined;
let worker: import("@temporalio/worker").Worker | undefined;
let running: Promise<void> | undefined;
let unbind: (() => void) | undefined;
before(async () => {
  connection = await NativeConnection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  worker = await Worker.create({
    connection,
    namespace: env.namespace,
    taskQueue: env.taskQueue,
    identity: IDENTITY,
    workflowBundle: await workflowBundle(env.workflowsPath),
    activities,
    sinks: metricSinks(),
  });
  running = worker.run();
  const host = workflowStarter(env.client, loaded.workflows, env.taskQueue);
  unbind = bindWorkflowStarter({
    async start(request) {
      if (request.input.workspaceId === refused) throw new Error("the starter is down");
      const answer = await host.start(request);
      starts.push({ ...request, ...answer });
      return answer;
    },
  });
});
after(async () => {
  unbind?.();
  worker?.shutdown();
  await running;
  await connection?.close();
});

/** A workflow of linkedin run to its end on the test's queue: its result. */
function execute<T>(workflow: string, input: Record<string, unknown>): Promise<T> {
  return env.client.workflow.execute(workflow, {
    args: [input],
    taskQueue: env.taskQueue,
    workflowId: `${workflow}-${randomUUID()}`,
    workflowExecutionTimeout: "1 minute",
  }) as Promise<T>;
}

/** linkedin_daily at the day's 00:30 UTC, then each workspace run it started, settled. */
async function daily(day: number) {
  linkedin.useClock(() => at(day));
  starts.length = 0;
  const result = await execute<{ workspaces: number; started: number; receiptsDeleted: number }>(
    "linkedin_daily",
    {},
  ).catch((error: unknown) => error);
  const opened = starts.filter(({ started }) => started);
  const handles = opened.map(({ workflowId }) => env.client.workflow.getHandle(workflowId));
  const settled = await Promise.allSettled(handles.map((handle) => handle.result()));
  const runs = new Map(
    opened.map(({ input }, n) => [
      String(input.workspaceId),
      settled[n] as PromiseSettledResult<WorkspaceDay>,
    ]),
  );
  return { result, runs };
}

const targets = async (id: string) => {
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id } });
  return [row.inviteTarget, row.messageTarget];
};
/** A connection request and a message committed on the account's quota day. */
async function sendOn(
  workspaceId: string,
  senderAccountId: string,
  quotaDay: string,
  timeZone = "UTC",
) {
  const key = { workspaceId, senderAccountId, quotaDay };
  await app.senderQuotaUsage.upsert({
    where: { workspaceId_senderAccountId_quotaDay: key },
    create: {
      id: newId(ids.sender_quota_usage),
      ...key,
      timeZone,
      invitesCommitted: 1,
      messagesCommitted: 1,
    },
    update: { invitesCommitted: { increment: 1 }, messagesCommitted: { increment: 1 } },
  });
}
const logRow = (workspaceId: string, senderAccountId: string, when: Date) =>
  app.senderActionLog.create({
    data: {
      id: newId(ids.sender_action_log),
      workspaceId,
      senderAccountId,
      kind: "status_check",
      count: 1,
      outcome: "ok",
      at: when,
    },
  });
const receipt = (when: Date) =>
  app.linkedinEventReceipt.create({
    data: {
      id: newId(ids.linkedin_event_receipt),
      eventKeyHash: randomUUID().replaceAll("-", "").repeat(2),
      kind: "invite.accepted",
      receivedAt: when,
    },
  });
const logged = async (id: string) => (await app.senderActionLog.count({ where: { id } })) === 1;
const received = async (id: string) =>
  (await app.linkedinEventReceipt.count({ where: { id } })) === 1;

const LOS_ANGELES = "America/Los_Angeles";
/**
 * Sending open, and two workspaces (each test starts on empty tables): in A, a connected account in
 * UTC and a paused one; in B, a connected account in Los Angeles.
 */
async function setup() {
  await linkedin.openSending();
  const [{ workspace: a }, { workspace: b }] = await tenancy.createTwoWorkspaces();
  const a1 = (await linkedin.createConnectedAccount(a.id)).id;
  const a2 = (await linkedin.createConnectedAccount(a.id)).id;
  await linkedin.setAccountPaused(a2, "operator");
  const b1 = (await linkedin.createConnectedAccount(b.id, { timeZone: LOS_ANGELES })).id;
  return { a: a.id, b: b.id, a1, a2, b1 };
}

test("linkedin registers linkedin_daily, global, and linkedin_daily_workspace, and the schedule linkedin.daily, which starts linkedin_daily at 00:30 every day in UTC", () => {
  assert.equal(loaded.workflows.get("linkedin_daily")?.scope, "global");
  assert.equal(loaded.workflows.get("linkedin_daily_workspace")?.scope, undefined);
  const schedule = loaded.schedules.find(({ id }) => id === "linkedin.daily");
  assert.deepEqual(schedule, {
    id: "linkedin.daily",
    workflow: "linkedin_daily",
    spec: { cronExpressions: ["30 0 * * *"], timezone: "UTC" },
    input: {},
  });
});

test("13 quota days, a connection request and a message committed each: linkedin_daily starts each of two workspaces' runs once a day, by its id of the day; an account ramps from 5 and 10 to 15 on the 10th day and 40 on the 12th, in its own zone; a paused one stays; a second run the same day changes nothing", async () => {
  const { a, b, a1, a2, b1 } = await setup();
  const seen: { a1: number[][]; b1: number[][]; ramped: number[] } = { a1: [], b1: [], ramped: [] };
  for (let day = 0; day <= 12; day += 1) {
    const { result, runs } = await daily(day);
    assert.deepEqual(result, { workspaces: 2, started: 2, receiptsDeleted: 0 }, `day ${day}`);
    const ids = starts.map(({ workflowId }) => workflowId).sort();
    const expected = [a, b].map((workspaceId) => `linkedin.daily:${workspaceId}:${utcDate(day)}`);
    assert.deepEqual(ids, expected.sort());
    assert.ok(
      starts.every(
        ({ workflow, oneAtATime }) => workflow === "linkedin_daily_workspace" && oneAtATime,
      ),
    );
    const ofA = runs.get(a);
    const ofB = runs.get(b);
    assert.equal(ofA?.status, "fulfilled");
    assert.equal(ofB?.status, "fulfilled");
    const dayA = (ofA as PromiseFulfilledResult<WorkspaceDay>).value;
    const dayB = (ofB as PromiseFulfilledResult<WorkspaceDay>).value;
    assert.deepEqual(
      { ...dayA, ramped: 0 },
      { accounts: 2, ramped: 0, staleDays: 0, logDeleted: 0 },
    );
    assert.deepEqual(
      { ...dayB, ramped: 0 },
      { accounts: 1, ramped: 0, staleDays: 0, logDeleted: 0 },
    );
    assert.equal(dayA.ramped, dayB.ramped, `day ${day}: one zone's ramp as the other's`);
    seen.ramped.push(dayA.ramped);
    seen.a1.push(await targets(a1));
    seen.b1.push(await targets(b1));
    // The day's sends, after its run, on each account's quota day: Los Angeles is a day behind.
    await sendOn(a, a1, utcDate(day));
    await sendOn(a, a2, utcDate(day));
    await sendOn(b, b1, utcDate(day - 1), LOS_ANGELES);
  }
  const expected = [
    [5, 10],
    [5, 10],
    [7, 15],
    [7, 15],
    [9, 20],
    [9, 20],
    [11, 25],
    [11, 25],
    [13, 30],
    [13, 30],
    [15, 35],
    [15, 35],
    [15, 40],
  ];
  assert.deepEqual(seen.a1, expected);
  assert.deepEqual(seen.b1, expected);
  assert.deepEqual(seen.ramped, [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  assert.deepEqual(await targets(a2), [5, 10]);
  const paused = await app.senderAccount.findUniqueOrThrow({ where: { id: a2 } });
  assert.equal(paused.rampUpdatedOn, null);

  // The same day again, the runs of the day closed: they start again and change nothing.
  const again = await daily(12);
  assert.deepEqual(again.result, { workspaces: 2, started: 2, receiptsDeleted: 0 });
  for (const run of again.runs.values()) {
    assert.equal(run.status, "fulfilled");
    assert.equal((run as PromiseFulfilledResult<WorkspaceDay>).value.ramped, 0);
  }
  assert.deepEqual(await targets(a1), [15, 40]);
  assert.deepEqual(await targets(b1), [15, 40]);
});

test("the purges: a workspace's run deletes its own action log past 90 days, never another's, and expires a hold of an earlier day no reservation swept; linkedin_daily deletes the receipts past 7 days and keeps the younger", async () => {
  const { a, b, a1, b1 } = await setup();
  const day = 14;
  const now = at(day).getTime();
  linkedin.useClock(() => at(day));
  const old = {
    a: await logRow(a, a1, new Date(now - 91 * DAY_MS)),
    b: await logRow(b, b1, new Date(now - 91 * DAY_MS)),
  };
  const young = {
    a: await logRow(a, a1, new Date(now - 89 * DAY_MS)),
    b: await logRow(b, b1, new Date(now - 89 * DAY_MS)),
  };
  // A connection request sent on day 12 and one still held there, never swept: a slot still counted.
  await sendOn(a, a1, utcDate(12));
  const key = { workspaceId: a, senderAccountId: a1, quotaDay: utcDate(12) };
  const usage = await app.senderQuotaUsage.update({
    where: { workspaceId_senderAccountId_quotaDay: key },
    data: { invitesReserved: { increment: 1 } },
  });
  const hold = await app.senderQuotaReservation.create({
    data: {
      id: newId(ids.sender_quota_reservation),
      workspaceId: a,
      senderAccountId: a1,
      usageId: usage.id,
      actionType: "invite",
      idempotencyKey: `key-${randomUUID()}`,
      count: 1,
      expiresAt: at(12),
      createdAt: at(12),
    },
  });

  // A's run alone: its first ramp day for the account in UTC, the hold expired, its old log row gone.
  const ofA = await execute<WorkspaceDay>("linkedin_daily_workspace", { workspaceId: a });
  assert.deepEqual(ofA, { accounts: 2, ramped: 1, staleDays: 1, logDeleted: 1 });
  assert.deepEqual([await logged(old.a.id), await logged(young.a.id)], [false, true]);
  assert.deepEqual(
    [await logged(old.b.id), await logged(young.b.id)],
    [true, true],
    "another workspace's log untouched",
  );
  const expired = await app.senderQuotaReservation.findUniqueOrThrow({ where: { id: hold.id } });
  assert.equal(expired.status, "expired");
  const swept = await app.senderQuotaUsage.findUniqueOrThrow({ where: { id: usage.id } });
  assert.equal(swept.invitesReserved, usage.invitesReserved - 1);

  const [stale, fresh] = [
    await receipt(new Date(now - 8 * DAY_MS)),
    await receipt(new Date(now - 6 * DAY_MS)),
  ];
  const { result, runs } = await daily(day);
  assert.deepEqual(result, { workspaces: 2, started: 2, receiptsDeleted: 1 });
  assert.deepEqual([await received(stale.id), await received(fresh.id)], [false, true]);
  const again = runs.get(a) as PromiseFulfilledResult<WorkspaceDay>;
  assert.deepEqual(again.value, { accounts: 2, ramped: 0, staleDays: 0, logDeleted: 0 });
  const ofB = runs.get(b) as PromiseFulfilledResult<WorkspaceDay>;
  assert.deepEqual(ofB.value, { accounts: 1, ramped: 1, staleDays: 0, logDeleted: 1 });
  assert.deepEqual([await logged(old.b.id), await logged(young.b.id)], [false, true]);
});

test("a failing workspace: its run fails once its other account is ramped and its log purged, and the other workspaces' runs complete; a start that fails fails linkedin_daily once the others started and the receipts were purged", async () => {
  const { a, b } = await setup();
  const [c] = await tenancy.createTwoWorkspaces();
  const failing = c.workspace.id;
  const broken = await linkedin.createConnectedAccount(failing);
  const fine = await linkedin.createConnectedAccount(failing);
  // A zone Intl does not know: that account's quota day throws.
  await app.senderAccount.update({ where: { id: broken.id }, data: { timeZone: "Mars/Olympus" } });
  const day = 20;
  const old = await logRow(failing, fine.id, new Date(at(day).getTime() - 91 * DAY_MS));
  const { result, runs } = await daily(day);
  assert.deepEqual(result, { workspaces: 4, started: 4, receiptsDeleted: 0 });
  const failed = runs.get(failing);
  assert.equal(failed?.status, "rejected");
  assert.ok((failed as PromiseRejectedResult).reason instanceof WorkflowFailedError);
  for (const workspaceId of [a, b]) {
    assert.equal(runs.get(workspaceId)?.status, "fulfilled", workspaceId);
  }
  const ramped = await app.senderAccount.findUniqueOrThrow({ where: { id: fine.id } });
  assert.equal(ramped.rampUpdatedOn, utcDate(day));
  assert.equal(await logged(old.id), false);

  // The next day the starter refuses that workspace: the others start, the receipts go, the run fails.
  refused = failing;
  const stale = await receipt(new Date(at(day + 1).getTime() - 8 * DAY_MS));
  try {
    const next = await daily(day + 1);
    assert.ok(next.result instanceof WorkflowFailedError);
    assert.equal(await received(stale.id), false);
    assert.equal(next.runs.has(failing), false);
    for (const workspaceId of [a, b]) {
      assert.equal(next.runs.get(workspaceId)?.status, "fulfilled", workspaceId);
    }
  } finally {
    refused = undefined;
  }
});
