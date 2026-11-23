// campaigns' daily plan (beta-p4-010; core/modules/campaigns/README.md "Worker", docs/flows.md "The
// daily plan"), on the slice's Temporal and a schema of its database: campaigns loaded from its build
// by the worker's own loader, its activities through the host's wrapper, campaigns' and linkedin's
// clocks on a Thursday at noon in Paris, inside the account's window. The tick starts one plan per
// workspace by campaigns.plan:<workspace>:current. A workspace's plan writes a time for each due
// scheduled step, places yesterday's unsent step again today, and leaves an executing step, a step
// due ahead and a disconnected account's step alone; a second run keeps every time and gap; an
// account with a step placed today has its sender started (beta-p4-020), recorded. Through the host,
// a tick while a plan runs starts none for its workspace, and the schedule campaigns.plan starts the
// tick every 15 minutes, overlap skip; the sender the plan starts is terminated after. Two attempts
// of the plan's activity at once on one account (gamma-p6-040): the second skips it busy and logs
// campaigns: account plan busy, and the first places its step once. Contacts',
// linkedin's, tenancy's and campaigns' code and test helpers come from their builds, the files the
// loader's modules import. It lives here: a module never imports a host. The replay of the recorded
// histories is `pnpm -F worker test:replay`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { TenantClient } from "@whytide/db";
import type { WorkflowStart } from "@whytide/platform";

// The LinkedIn fake, whatever the environment names: nothing here calls a provider, and nothing may.
process.env.PROVIDER_LINKEDIN = "fake";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const campaigns = await import(built("campaigns/dist/testing/index.js"));
const { ids } = await import(built("campaigns/dist/ids.js"));
const { MIN_ACTION_GAP_MS } = await import(built("campaigns/dist/domain/plan/constants.js"));
const { planStart, senderStart } = await import(built("campaigns/dist/workflows/index.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const modules = moduleLoaders.filter(({ name }) => name === "campaigns");
const loaded = await loadModules(modules);
// campaigns' own lines, the plan's per account, to the collector, as the host binds them.
await startModules(loaded, log);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app, log })];
  }),
);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ZONE = "Europe/Paris";
const OFFICE = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };
const THURSDAY = new Date("2026-10-22T10:00:00Z"); // 12:00 in Paris
const WINDOW_END = new Date("2026-10-22T16:00:00Z"); // 18:00 in Paris
const TODAY = "2026-10-22";
const TEMPLATE = { templateId: "linkedin_default", templateVersion: 1 };
const principal = platform.servicePrincipal("campaigns_test");

type StepFields = {
  readonly actionType: "invite" | "message" | "withdraw";
  readonly status: "scheduled" | "executing";
  readonly dueAt: Date;
  readonly scheduledFor?: Date;
  readonly quotaDay?: string;
  readonly attempt?: number;
};

/** Both modules' clocks at `at`: the plan's, and the one remainingToday reads. */
function setClocks(at: Date): void {
  campaigns.useClock(() => at);
  linkedin.useClock(() => at);
}
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
/** A connected account in Paris with office hours, or one disconnected. */
async function account(
  workspaceId: string,
  status: "connected" | "disconnected" = "connected",
): Promise<string> {
  const settings = { timeZone: ZONE, workingHours: OFFICE };
  const { id } = await linkedin.createConnectedAccount(workspaceId, settings);
  // Sending open, as the operator opens it (beta-p1-040): a fresh database has it closed.
  await linkedin.openSending();
  if (status !== "connected") await app.senderAccount.update({ where: { id }, data: { status } });
  return id;
}
/** A person of the workspace, enrolled with the account, and one step of theirs: the step's id. */
async function stepOf(
  workspaceId: string,
  senderAccountId: string,
  slug: string,
  fields: StepFields,
): Promise<string> {
  const personId: string = await inRun(workspaceId, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const source = { source: "import", provider: "csv", profile };
    return (await contacts.upsertPersonFromSource(source)).person.id;
  });
  const enrollmentId = platform.newId(ids.enrollment);
  const startedAt = new Date(THURSDAY.getTime() - 3 * DAY_MS);
  await app.enrollment.create({
    data: {
      ...{ id: enrollmentId, workspaceId, personId, senderAccountId, ...TEMPLATE },
      ...{ status: "active", sourceEventId: platform.newId("obx"), startedAt },
    },
  });
  const id = platform.newId(ids.step_execution);
  await app.stepExecution.create({
    data: {
      ...{ id, workspaceId, enrollmentId, personId, senderAccountId, ...TEMPLATE },
      ...{ stepKey: slug, position: 1, stepTemplateHash: slug, idempotencyKey: `${id}:key` },
      ...fields,
    },
  });
  return id;
}
const stepsOf = async (workspaceId: string) =>
  new Map(
    (await app.stepExecution.findMany({ where: { workspaceId } })).map((row) => [row.id, row]),
  );
const plan = (workspaceId: string) =>
  runWorkflow("campaigns_plan", { workspaceId }, { activities });

/** The rows' times, in the order given; each in today's window ahead of `from`, on today's date. */
function placedTimes(rows: Map<string, Row>, stepIds: readonly string[], from: Date): number[] {
  return stepIds.map((id) => {
    const row = rows.get(id);
    assert.ok(row?.scheduledFor, `${id}: no time`);
    assert.ok(from <= row.scheduledFor && row.scheduledFor < WINDOW_END, `${id}: outside`);
    assert.equal(row.quotaDay, TODAY);
    return row.scheduledFor.getTime();
  });
}
type Row = Awaited<ReturnType<typeof stepsOf>> extends Map<string, infer R> ? R : never;
/** Every two of the times at least a gap apart. */
function assertGaps(times: readonly number[]): void {
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    assert.ok(gap >= MIN_ACTION_GAP_MS, `two times ${gap} ms apart`);
  }
}

test("the tick starts every workspace's campaigns_plan, one at a time by campaigns.plan:<workspace>:current; the schedule campaigns.plan starts the tick every 15 minutes", async () => {
  const schedule = loaded.schedules.find(({ id }) => id === "campaigns.plan");
  assert.deepEqual(schedule, {
    id: "campaigns.plan",
    workflow: "campaigns_plan_tick",
    spec: { intervals: [{ every: "15 minutes" }] },
    input: {},
  });
  const [a, b] = await tenancy.createTwoWorkspaces();
  const starts: WorkflowStart[] = [];
  const unbind = platform.bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: request.input.workspaceId === a.workspace.id };
    },
  });
  try {
    const counts = await runWorkflow("campaigns_plan_tick", {}, { activities });
    assert.deepEqual(counts, { workspaces: 2, started: 1 });
  } finally {
    unbind();
  }
  const expected = [a.workspace.id, b.workspace.id].sort().map((id) => planStart(id));
  assert.deepEqual(starts, expected);
  assert.deepEqual(planStart(a.workspace.id), {
    workflow: "campaigns_plan",
    input: { workspaceId: a.workspace.id },
    workflowId: `campaigns.plan:${a.workspace.id}:current`,
    oneAtATime: true,
  });
});

test("a workspace's plan writes a time and today's quota day for each due scheduled step, messages first, a gap apart, in the window; yesterday's unsent step is placed again today; an executing step, a step due ahead and a disconnected account's step get nothing; a second run keeps every time and gap", async () => {
  const [a] = await tenancy.createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const sender = await account(workspaceId);
  const off = await account(workspaceId, "disconnected");
  setClocks(THURSDAY);
  const ago = (ms: number) => new Date(THURSDAY.getTime() - ms);
  const due = ago(2 * DAY_MS);
  const scheduled = "scheduled" as const;
  const invite = await stepOf(workspaceId, sender, "plan-invite", {
    actionType: "invite",
    status: scheduled,
    dueAt: ago(HOUR_MS),
  });
  const message = await stepOf(workspaceId, sender, "plan-message", {
    actionType: "message",
    status: scheduled,
    dueAt: due,
  });
  // Placed yesterday at 15:00 in Paris, and never sent.
  const yesterday = await stepOf(workspaceId, sender, "plan-yesterday", {
    actionType: "invite",
    status: scheduled,
    dueAt: due,
    scheduledFor: new Date("2026-10-21T13:00:00Z"),
    quotaDay: "2026-10-21",
  });
  const executing = await stepOf(workspaceId, sender, "plan-executing", {
    actionType: "message",
    status: "executing",
    dueAt: due,
    scheduledFor: ago(10_000),
    quotaDay: TODAY,
    attempt: 1,
  });
  // Due tomorrow, after both runs.
  const ahead = await stepOf(workspaceId, sender, "plan-ahead", {
    actionType: "message",
    status: scheduled,
    dueAt: new Date(THURSDAY.getTime() + DAY_MS),
  });
  const disconnected = await stepOf(workspaceId, off, "plan-disconnected", {
    actionType: "message",
    status: scheduled,
    dueAt: due,
  });
  const before = await stepsOf(workspaceId);
  const starts: WorkflowStart[] = [];
  const unbind = platform.bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  after(unbind);

  assert.deepEqual(await plan(workspaceId), { accounts: 2, placed: 3 });
  assert.deepEqual(starts, [senderStart(workspaceId, sender)]);
  const first = await stepsOf(workspaceId);
  // The message first; then the invites by due time: yesterday's, then the new one.
  const times = placedTimes(first, [message, yesterday, invite], THURSDAY);
  assert.deepEqual(
    times,
    [...times].sort((x, y) => x - y),
  );
  assertGaps(times);
  for (const id of [executing, ahead, disconnected])
    assert.deepEqual(first.get(id), before.get(id));

  // A second run at the first time placed, with a new step due: every time kept, the new one a gap
  // from each.
  const second = new Date(Math.min(...times));
  setClocks(second);
  const fresh = await stepOf(workspaceId, sender, "plan-fresh", {
    actionType: "message",
    status: scheduled,
    dueAt: ago(HOUR_MS),
  });
  assert.deepEqual(await plan(workspaceId), { accounts: 2, placed: 1 });
  assert.deepEqual(starts, [senderStart(workspaceId, sender), senderStart(workspaceId, sender)]);
  const again = await stepsOf(workspaceId);
  assert.deepEqual(placedTimes(again, [message, yesterday, invite], THURSDAY), times);
  const [added] = placedTimes(again, [fresh], second);
  assertGaps([...times, added ?? 0]);
  for (const id of [executing, ahead, disconnected])
    assert.deepEqual(again.get(id), before.get(id));
});

test("through the host: a tick while a workspace's plan runs starts none for it, and starts the other's; once the run closed, the next tick starts a new one; the schedule campaigns.plan every 15 minutes, overlap skip", async () => {
  const [a, b] = await tenancy.createTwoWorkspaces();
  const [busy, idle] = [a.workspace.id, b.workspace.id];
  const busyAccount = await account(busy);
  const step = await stepOf(busy, busyAccount, "host-due", {
    actionType: "message",
    status: "scheduled",
    dueAt: new Date(THURSDAY.getTime() - HOUR_MS),
  });
  setClocks(THURSDAY);
  const taskQueue = `test-${randomUUID()}`;
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    schedules: "off",
    client: app,
    log,
  });
  const tickSchedule = env.client.schedule.getHandle("campaigns.plan");
  const tick = () =>
    env.client.workflow.execute("campaigns_plan_tick", {
      args: [{}],
      taskQueue,
      workflowId: `campaigns_plan_tick-${randomUUID()}`,
    });
  const run = env.client.workflow.getHandle(`campaigns.plan:${busy}:current`);
  const idleRun = env.client.workflow.getHandle(`campaigns.plan:${idle}:current`);
  const none = { accounts: 0, placed: 0 };
  // The step's row held by a transaction of the test, so the busy workspace's plan waits on it.
  const locked = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const holding = withTenant(
    { workspaceId: busy, principal },
    async (tx) => {
      await tx.stepExecution.update({ where: { id: step }, data: { attempt: 0 } });
      locked.resolve();
      await released.promise;
    },
    { client: app, timeout: 20_000 },
  );
  try {
    await Promise.race([locked.promise, holding]);
    assert.deepEqual(await tick(), { workspaces: 2, started: 2 });
    const first = await run.describe();
    assert.equal(first.status.name, "RUNNING");
    assert.deepEqual(await idleRun.result(), none);
    assert.deepEqual(await tick(), { workspaces: 2, started: 1 });
    assert.deepEqual(await platform.startWorkflow(planStart(busy)), { started: false });
    assert.equal((await run.describe()).runId, first.runId);
    released.resolve();
    await holding;
    assert.deepEqual(await run.result(), { accounts: 1, placed: 1 });
    assert.deepEqual(await idleRun.result(), none);

    // Both runs closed: the next tick starts each again, and the placed step keeps its time.
    assert.deepEqual(await tick(), { workspaces: 2, started: 2 });
    assert.deepEqual(await run.result(), { accounts: 1, placed: 0 });
    assert.notEqual((await run.describe()).runId, first.runId);

    const schedule = await tickSchedule.describe();
    assert.deepEqual(
      [
        schedule.action.workflowType,
        schedule.spec.intervals?.map(({ every }) => every),
        schedule.policies.overlap,
        schedule.state.paused,
      ],
      ["campaigns_plan_tick", [900_000], "SKIP", true],
    );
  } finally {
    released.resolve();
    await holding.catch(() => undefined);
    // The sender the plan started waits for its step's time, on a clock that stands still.
    const senderRun = env.client.workflow.getHandle(`campaigns.sender:${busy}:${busyAccount}`);
    await senderRun.terminate().catch(() => undefined);
    await host.close();
    await tickSchedule.delete().catch(() => undefined);
    // The host upserted the queue's schedule too (beta-p3-050), paused.
    await env.client.schedule
      .getHandle("campaigns.queue")
      .delete()
      .catch(() => undefined);
    // And the withdrawal job's (beta-p4-060).
    await env.client.schedule
      .getHandle("campaigns.withdraw")
      .delete()
      .catch(() => undefined);
  }
});

/**
 * One attempt of the plan's activity, its body run as the host's wrapper runs it, with no Temporal:
 * an attempt past PLAN_TIMEOUT that Temporal has given up on still runs so.
 */
function planAttempt(workspaceId: string, attempt: number): Promise<unknown> {
  const definition = loaded.activities.get("campaigns_plan_accounts");
  if (definition === undefined || definition.scope === "global")
    throw new Error("no plan activity");
  return definition.run(
    { workspaceId },
    {
      workspaceId,
      workflowId: `campaigns.plan:${workspaceId}:current`,
      attempt,
      tenant: (fn) => withTenant({ workspaceId, principal }, fn, { client: app }),
    },
  );
}

test("two plan attempts on one account at once: the second skips it busy, logs campaigns: account plan busy with the account and starts no sender; the first places the step once and starts the sender", async () => {
  const [a] = await tenancy.createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const sender = await account(workspaceId);
  setClocks(THURSDAY);
  const step = await stepOf(workspaceId, sender, "plan-busy", {
    actionType: "message",
    status: "scheduled",
    dueAt: new Date(THURSDAY.getTime() - HOUR_MS),
  });
  const starts: WorkflowStart[] = [];
  const unbind = platform.bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  after(unbind);
  const linesOf = (msg: string) =>
    logs.lines().filter((line) => line.msg === msg && line.sender_account_id === sender);
  // The step's row held by a transaction of the test: the first attempt takes the account's lock,
  // then waits on the row to place its time.
  const locked = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const holding = withTenant(
    { workspaceId, principal },
    async (tx) => {
      await tx.stepExecution.update({ where: { id: step }, data: { attempt: 0 } });
      locked.resolve();
      await released.promise;
    },
    { client: app, timeout: 20_000 },
  );
  try {
    await Promise.race([locked.promise, holding]);
    const first = planAttempt(workspaceId, 1);
    // The first attempt past its lock: its write of the step waits on the test's row.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const [row] = await app.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%UPDATE%step_executions%'`;
      if ((row?.waiting ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error("the first attempt never waited on the step");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.deepEqual(await planAttempt(workspaceId, 2), { accounts: 1, placed: 0 });
    assert.equal(linesOf("campaigns: account plan busy").length, 1);
    assert.deepEqual(linesOf("campaigns: account planned"), []);
    assert.deepEqual(starts, [], "the busy attempt starts no sender");
    released.resolve();
    await holding;
    assert.deepEqual(await first, { accounts: 1, placed: 1 });
  } finally {
    released.resolve();
    await holding.catch(() => undefined);
  }
  const placed = await app.stepExecution.findUniqueOrThrow({ where: { id: step } });
  assert.ok(
    placed.scheduledFor && placed.scheduledFor >= THURSDAY && placed.scheduledFor < WINDOW_END,
  );
  assert.equal(placed.quotaDay, TODAY);
  assert.deepEqual(starts, [senderStart(workspaceId, sender)]);
  assert.equal(linesOf("campaigns: account planned").length, 1);
  assert.equal(linesOf("campaigns: account plan busy").length, 1);
});
