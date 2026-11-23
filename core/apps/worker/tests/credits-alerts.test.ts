// credits_alerts (gamma-p7-020; core/modules/credits README "Alerts"), end to end on the app-mail
// fake, the slice's Temporal and a schema of its database: credits loaded from its build as the
// worker loads it, its activities through the host's wrapper as `app`, on a worker of the test's
// queue. The schedule credits.alerts, every 15 minutes, overlap skip, paused under
// WORKER_SCHEDULES=off. At fixed instants of a fixed period: 79.9 percent mails nothing; 80 percent
// mails each Owner and Admin of the organization's workspaces once, an Owner of two of them once, no
// Member, removed member, disabled Owner or other organization's Owner, with the organization's
// name and figures and the link to the costs page, no person's or workspace's data; a second check
// nothing more. A jump from 70 to 96 percent mails 95 once and marks 80 with it; 100 then mails once
// more. A mail failing its five attempts raises the tries and goes at the next check; failing
// CREDIT_ALERT_MAX_TRIES checks, it never goes. Each recipient once (review-gaps-2): one whose send
// keeps failing leaves the others one mail across attempts and checks; a mail that times out on
// every attempt, on a bundle that shortens its start-to-close (fixtures/credits-alerts-timeouts.ts),
// raises the tries once per check; two checks at once mail each Owner once. The log lines hold ids
// and counts. The recorded history replays. tenancy's helpers come from its build, the files credits
// imports. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// The fake, whatever the environment names: nothing here sends a mail.
process.env.PROVIDER_APP_MAIL = "fake";
const ORIGIN = "https://app.example.test";
process.env.APP_PUBLIC_ORIGIN = ORIGIN;

const { bundleWorkflowCode, NativeConnection, Worker } = await import("@temporalio/worker");
const { ids } = await import("@whytide/credits");
const { useCreditsClient } = await import("@whytide/credits/testing");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { AppError, collectLogs, createLogger, newId } = await import("@whytide/platform");
const { appMailPort, getAdapter } = await import("@whytide/providers");
const { hostActivity } = await import("../src/activities.ts");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { IDENTITY, metricSinks, workflowBundle } = await import("../src/temporal.ts");
const { replayHistories, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
type Tenancy = typeof import("../../../modules/tenancy/dist/index.js");
const tenancy: TenancyTesting = await import(built("tenancy/dist/testing/index.js"));
const { ids: tenancyIds }: Tenancy = await import(built("tenancy/dist/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useCreditsClient(app);
tenancy.useTenancyClient(app);
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const credits = moduleLoaders.filter(({ name }) => name === "credits");
const loaded = await loadModules(credits);
await startModules(loaded, log);
/** The app-mail fake's helpers, which the bound adapter keeps (providers/app-mail/README.md). */
type AppMailFake = {
  send(input: { to: string; subject: string; text: string }): Promise<unknown>;
  sent(): readonly { to: string; subject: string; text: string }[];
  failNext(code: "mail_unreachable", details?: Record<string, unknown>): void;
};
const mails = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;
const HISTORY = fileURLToPath(built("credits/workflows/__histories__/credits_alerts.json"));
const OCTOBER = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") };
/** The check's instant, inside October: the workflow's input, as the schedule's run gives its start. */
const AT = "2026-10-15T12:00:00.000Z";
/** The provider kind's attempts, each failure asking for the next one 10 ms later. */
const ATTEMPTS = 5;
const FAST = { retryAfterSec: 0.01 };
/** The checks an alert's mail may fail (credits' CREDIT_ALERT_MAX_TRIES). */
const MAX_TRIES = 3;
/** The timeout case's interceptor, beside the host's. */
const TIMEOUTS = fileURLToPath(new URL("fixtures/credits-alerts-timeouts.ts", import.meta.url));
const HOST_INTERCEPTORS = fileURLToPath(
  new URL("../src/workflow-interceptors.ts", import.meta.url),
);

/** credits' activities on a worker of the test's queue, through the host's wrapper as `app`. */
let connection: import("@temporalio/worker").NativeConnection | undefined;
let worker: import("@temporalio/worker").Worker | undefined;
let running: Promise<void> | undefined;
let activities: Record<string, (input: unknown) => Promise<unknown>> = {};
before(async () => {
  activities = Object.fromEntries(
    [...loaded.activities].map(([name, definition]) => {
      return [name, hostActivity(name, definition, { client: app, log })];
    }),
  );
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
});
after(async () => {
  worker?.shutdown();
  await running;
  await connection?.close();
});

type AlertsResult = { organizations: number; recorded: number; mailed: number; failed: number };
let runs = 0;
/** One credits_alerts run at AT, as the schedule starts it: its result and its workflow's id. */
async function check() {
  const workflowId = `credits_alerts-test-${Date.now()}-${(runs += 1)}`;
  const options = { args: [{ at: AT }], taskQueue: env.taskQueue, workflowId };
  const result: AlertsResult = await env.client.workflow.execute("credits_alerts", options);
  return { result, workflowId };
}

/** An organization subscribed in October and granted 100 credits for it, as billing_writer. */
async function subscribed(organizationId: string) {
  const billing = asRole("billing_writer");
  const code = "self_hosted";
  const plan = await billing.plan.upsert({
    where: { code },
    create: { id: newId(ids.plan), code, name: code, monthlyAllowance: 100, isFixed: true },
    update: {},
  });
  const period = { organizationId, periodStart: OCTOBER.start, periodEnd: OCTOBER.end };
  const { id } = await billing.subscription.create({
    data: { ...period, id: newId(ids.subscription), planId: plan.id },
  });
  const grant = { id: newId(ids.credit_grant), subscriptionId: id, amount: 100 };
  await billing.creditGrant.create({ data: { ...period, ...grant, reason: "allowance" } });
}

/** `credits` committed by the organization's workspace on October 2. */
async function spent(organizationId: string, workspaceId: string, credits: string) {
  const id = newId(ids.credit_usage);
  const at = new Date("2026-10-02T09:00:00Z");
  await app.creditUsage.create({
    data: {
      ...{ id, organizationId, workspaceId, action: "test.read", quantity: credits, credits },
      ...{ status: "committed", idempotencyKey: id, subjectRef: "lead_test" },
      ...{ leaseExpiresAt: at, createdAt: at },
    },
  });
}

/** An organization with one workspace and its Owner, subscribed: their ids and the Owner's email. */
async function organization() {
  const { organization: org, workspace } = await tenancy.createOrganizationWithWorkspace();
  const owner = await tenancy.createUser();
  await tenancy.createMembership({ userId: owner.id, workspaceId: workspace.id, role: "Owner" });
  await subscribed(org.id);
  return { organizationId: org.id, name: org.name, workspaceId: workspace.id, owner };
}

const mailsTo = (to: string) => mails.sent().filter((mail) => mail.to === to);
const alertsOf = (organizationId: string) =>
  app.creditAlert.findMany({ where: { organizationId }, orderBy: { threshold: "asc" } });

test("the schedule credits.alerts runs credits_alerts every 15 minutes, overlap skip, paused under WORKER_SCHEDULES=off; two starts leave one", async () => {
  const handle = env.client.schedule.getHandle("credits.alerts");
  const own = { modules: credits, taskQueue: env.taskQueue, client: app, log };
  const options = { ...own, healthPort: 0, schedules: "off" } as const;
  await handle.delete().catch(() => undefined);
  try {
    await (await start(options)).close();
    const created = await handle.describe();
    await (await start(options)).close();
    const described = await handle.describe();
    assert.deepEqual(described.info.createdAt, created.info.createdAt);
    assert.equal(described.action.workflowType, "credits_alerts");
    assert.deepEqual(
      described.spec.intervals?.map(({ every }) => every),
      [15 * 60_000],
    );
    assert.equal(described.state.paused, true, "paused under WORKER_SCHEDULES=off");
    assert.equal(described.policies.overlap, "SKIP");
  } finally {
    await handle.delete().catch(() => undefined);
  }
});

test("79.9 percent mails nothing; 80 percent mails each Owner and Admin once, an Owner of two workspaces once, no Member, removed member, disabled Owner or other organization; a second check nothing more", async () => {
  const a = await organization();
  const second = await app.workspace.create({
    data: {
      id: newId(tenancyIds.workspace),
      organizationId: a.organizationId,
      name: "Second team",
      slug: `second-${Date.now()}`,
    },
  });
  await app.workspace.update({ where: { id: a.workspaceId }, data: { name: "First team" } });
  const people = {
    owner2: await tenancy.createUser(),
    admin: await tenancy.createUser(),
    member: await tenancy.createUser(),
    removed: await tenancy.createUser(),
    disabled: await tenancy.createUser(),
    other: await tenancy.createUser(),
  };
  type Person = keyof typeof people;
  const join = (key: Person, workspaceId: string, role: "Owner" | "Admin" | "Member") =>
    tenancy.createMembership({ userId: people[key].id, workspaceId, role });
  await tenancy.createMembership({ userId: a.owner.id, workspaceId: second.id, role: "Owner" });
  await join("owner2", second.id, "Owner");
  await join("admin", a.workspaceId, "Admin");
  await join("member", a.workspaceId, "Member");
  const removed = await join("removed", a.workspaceId, "Owner");
  await app.membership.update({
    where: { id: removed.id },
    data: { removedAt: new Date(), removedBy: a.owner.id },
  });
  await join("disabled", second.id, "Owner");
  await app.user.update({ where: { id: people.disabled.id }, data: { disabledAt: new Date() } });
  const b = await organization();
  await join("other", b.workspaceId, "Owner");
  await spent(b.organizationId, b.workspaceId, "50");

  await spent(a.organizationId, a.workspaceId, "79.9");
  const under = await check();
  assert.deepEqual(under.result, { organizations: 2, recorded: 0, mailed: 0, failed: 0 });

  await spent(a.organizationId, second.id, "0.1");
  const crossed = await check();
  assert.deepEqual(crossed.result, { organizations: 2, recorded: 1, mailed: 1, failed: 0 });
  const linkOf = (workspaceId: string) => `${ORIGIN}/w/${workspaceId}/credits`;
  const expected: [to: string, link: string][] = [
    [a.owner.email, linkOf(a.workspaceId)],
    [people.owner2.email, linkOf(second.id)],
    [people.admin.email, linkOf(a.workspaceId)],
  ];
  for (const [to, link] of expected) {
    const [mail, ...more] = mailsTo(to);
    assert.ok(mail, `a mail to ${to}`);
    assert.equal(more.length, 0, "one mail each");
    assert.equal(mail.subject, "Your organization has used 80% of this period's credits");
    assert.ok(
      mail.text.startsWith(
        `${a.name} has used 80% of the credits granted for the current period: 80 of 100 credits.`,
      ),
      mail.text,
    );
    assert.match(mail.text, /20 credits are left in its balance/);
    assert.match(mail.text, /The credit period ends on November 1, 2026/);
    assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [link], "the costs page's link, alone");
    const others = Object.values(people).map(({ email }) => email);
    const names = [a.owner, ...Object.values(people)].map(({ displayName }) => displayName ?? "");
    for (const kept of [...others, ...names, "First team", "Second team", b.name]) {
      assert.ok(!`${mail.subject}\n${mail.text}`.includes(kept), `no ${kept}`);
    }
  }
  for (const key of ["member", "removed", "disabled", "other"] as const) {
    assert.deepEqual(mailsTo(people[key].email), [], `no mail to the ${key}`);
  }
  const [alert] = await alertsOf(a.organizationId);
  assert.ok(alert?.notifiedAt instanceof Date, "notified_at is set");

  const again = await check();
  assert.deepEqual(again.result, { organizations: 2, recorded: 0, mailed: 0, failed: 0 });
  assert.equal(mailsTo(a.owner.email).length, 1, "still one mail");
  assert.deepEqual(await alertsOf(b.organizationId), [], "50 percent: no alert");
});

test("a jump from 70 to 96 percent mails 95 once and marks 80 with it; 100 percent then mails once more", async () => {
  const a = await organization();
  await spent(a.organizationId, a.workspaceId, "70");
  assert.equal((await check()).result.recorded, 0);
  await spent(a.organizationId, a.workspaceId, "26");
  assert.deepEqual((await check()).result, { organizations: 1, recorded: 2, mailed: 1, failed: 0 });
  const [first, ...more] = mailsTo(a.owner.email);
  assert.equal(more.length, 0, "one mail for both thresholds");
  assert.equal(first?.subject, "Your organization has used 95% of this period's credits");
  const [eighty, ninetyFive] = await alertsOf(a.organizationId);
  assert.ok(ninetyFive?.notifiedAt instanceof Date);
  assert.deepEqual(eighty?.notifiedAt, ninetyFive.notifiedAt, "80 went with 95's mail");

  await spent(a.organizationId, a.workspaceId, "4");
  assert.deepEqual((await check()).result, { organizations: 1, recorded: 1, mailed: 1, failed: 0 });
  const sent = mailsTo(a.owner.email);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.subject, "Your organization has used all of this period's credits");
  assert.match(sent[1]?.text ?? "", /When the balance runs out, work that spends credits stops/);
});

test("a mail failing its attempts raises the tries and goes at the next check; failing CREDIT_ALERT_MAX_TRIES checks, it never goes", async () => {
  const late = await organization();
  await spent(late.organizationId, late.workspaceId, "80");
  for (let n = 0; n < ATTEMPTS; n += 1) mails.failNext("mail_unreachable", FAST);
  assert.deepEqual((await check()).result, { organizations: 1, recorded: 1, mailed: 0, failed: 1 });
  let [alert] = await alertsOf(late.organizationId);
  assert.deepEqual([alert?.tries, alert?.notifiedAt], [1, null]);
  assert.deepEqual(mailsTo(late.owner.email), []);
  assert.deepEqual((await check()).result, { organizations: 1, recorded: 0, mailed: 1, failed: 0 });
  assert.equal(mailsTo(late.owner.email).length, 1, "the next check mailed it");
  [alert] = await alertsOf(late.organizationId);
  assert.equal(alert?.tries, 1);
  assert.ok(alert?.notifiedAt instanceof Date);

  const never = await organization();
  await spent(never.organizationId, never.workspaceId, "80");
  for (let round = 1; round <= 3; round += 1) {
    for (let n = 0; n < ATTEMPTS; n += 1) mails.failNext("mail_unreachable", FAST);
    const { result } = await check();
    assert.deepEqual([result.mailed, result.failed], [0, 1], `round ${round}`);
  }
  const [capped] = await alertsOf(never.organizationId);
  assert.deepEqual([capped?.tries, capped?.notifiedAt], [3, null]);
  assert.deepEqual((await check()).result, { organizations: 2, recorded: 0, mailed: 0, failed: 0 });
  assert.deepEqual(mailsTo(never.owner.email), [], "never sent");
});

/**
 * The fake's send, wrapped while `fn` runs: each call to an address of `stuck` counted and answered
 * by `answer`, every other one sent. The calls per address, which `fn` reads as they come.
 */
async function wrapped(
  stuck: ReadonlySet<string>,
  answer: () => Promise<unknown>,
  fn: (calls: ReadonlyMap<string, number>) => Promise<void>,
) {
  const send = mails.send;
  const calls = new Map<string, number>();
  mails.send = (input) => {
    if (!stuck.has(input.to)) return send(input);
    calls.set(input.to, (calls.get(input.to) ?? 0) + 1);
    return answer();
  };
  try {
    await fn(calls);
  } finally {
    mails.send = send;
  }
  return calls;
}

test("a recipient whose send keeps failing leaves the others one mail across all attempts and checks and is tried once per attempt; another organization's alert goes in the same check; after CREDIT_ALERT_MAX_TRIES checks it never goes", async (t) => {
  const failing = await organization();
  const admin = await tenancy.createUser();
  await tenancy.createMembership({
    userId: admin.id,
    workspaceId: failing.workspaceId,
    role: "Admin",
  });
  await spent(failing.organizationId, failing.workspaceId, "80");
  const fine = await organization();
  await spent(fine.organizationId, fine.workspaceId, "80");
  const refuse = () => Promise.reject(new AppError("mail_unreachable", { details: FAST }));
  const calls = await wrapped(new Set([admin.email]), refuse, async () => {
    const first = await check();
    // The run whose history is workflows/__histories__/credits_alerts.json (history:record): a mail
    // sent and one failed, its tries raised by credits_fail_alert.
    t.diagnostic(`credits_alerts ran as ${first.workflowId}`);
    assert.deepEqual(first.result, { organizations: 2, recorded: 2, mailed: 1, failed: 1 });
    for (let round = 2; round <= MAX_TRIES; round += 1) {
      const { result } = await check();
      assert.deepEqual(result, { organizations: 2, recorded: 0, mailed: 0, failed: 1 }, `${round}`);
    }
    const after = await check();
    assert.deepEqual(after.result, { organizations: 2, recorded: 0, mailed: 0, failed: 0 });
  });
  assert.equal(calls.get(admin.email), MAX_TRIES * ATTEMPTS, "once per attempt");
  assert.equal(mailsTo(failing.owner.email).length, 1, "the other recipient: one mail");
  assert.equal(mailsTo(fine.owner.email).length, 1);
  assert.deepEqual(mailsTo(admin.email), []);
  const [alert] = await alertsOf(failing.organizationId);
  assert.deepEqual([alert?.tries, alert?.notifiedAt], [MAX_TRIES, null]);
});

test("a mail that times out on every attempt, never reaching its own code's end, raises the tries once per check; after CREDIT_ALERT_MAX_TRIES checks it never goes", async () => {
  const hung = await organization();
  await spent(hung.organizationId, hung.workspaceId, "80");
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: env.workflowsPath,
    workflowInterceptorModules: [HOST_INTERCEPTORS, TIMEOUTS],
  });
  const taskQueue = `${env.taskQueue}-timeouts`;
  if (connection === undefined) throw new Error("the worker connects in before()");
  const timed = await Worker.create({
    ...{ connection, namespace: env.namespace, taskQueue, identity: IDENTITY },
    ...{ workflowBundle, activities, sinks: metricSinks() },
  });
  // Each send hangs past its attempt's start-to-close, deaf to the cancellation, so the mail's own
  // code never ends, until the round releases it: then it and the attempts queued behind its lock
  // fail, writing nothing.
  let hanging = Promise.withResolvers<void>();
  const answer = () => hanging.promise.then(() => Promise.reject(new AppError("mail_unreachable")));
  const run = (n: number): Promise<AlertsResult> =>
    env.client.workflow.execute("credits_alerts", {
      args: [{ at: AT }],
      taskQueue,
      workflowId: `credits_alerts-timeouts-${Date.now()}-${n}`,
    });
  const calls = await wrapped(new Set([hung.owner.email]), answer, (counted) =>
    timed.runUntil(async () => {
      for (let round = 1; round <= MAX_TRIES; round += 1) {
        const result = await run(round);
        assert.deepEqual([result.mailed, result.failed], [0, 1], `round ${round}`);
        const [alert] = await alertsOf(hung.organizationId);
        assert.deepEqual([alert?.tries, alert?.notifiedAt], [round, null], `round ${round}`);
        // The attempts end: the hung send and those queued behind its lock fail, one each.
        hanging.resolve();
        while ((counted.get(hung.owner.email) ?? 0) < round * ATTEMPTS) await delay(20);
        hanging = Promise.withResolvers<void>();
      }
      const last = await run(MAX_TRIES + 1);
      assert.deepEqual([last.mailed, last.failed], [0, 0]);
    }),
  );
  assert.equal(calls.get(hung.owner.email), MAX_TRIES * ATTEMPTS);
  assert.deepEqual(mailsTo(hung.owner.email), [], "never sent");
});

test("two checks at once mail each Owner and Admin once", async () => {
  const a = await organization();
  const admin = await tenancy.createUser();
  await tenancy.createMembership({ userId: admin.id, workspaceId: a.workspaceId, role: "Admin" });
  await spent(a.organizationId, a.workspaceId, "80");
  const [one, two] = await Promise.all([check(), check()]);
  assert.equal(one.result.mailed + two.result.mailed, 1, "one of them mailed the alert");
  assert.equal(mailsTo(a.owner.email).length, 1);
  assert.equal(mailsTo(admin.email).length, 1);
  const recorded = await app.creditAlertMail.count();
  assert.equal(recorded, 2);
});

test("the log lines hold ids and counts only, never an address or a name", async () => {
  const a = await organization();
  await spent(a.organizationId, a.workspaceId, "100");
  await check();
  const lines = logs.lines().filter(({ msg }) => String(msg).startsWith("credits: "));
  const allowed = new Set([
    ...["level", "time", "pid", "hostname", "msg", "actor", "trace_id", "span_id"],
    ...["organization_count", "recorded_count", "alert_count"],
    ...["alert_id", "organization_id", "threshold", "recipient_count", "row_count"],
  ]);
  assert.ok(lines.some(({ msg }) => msg === "credits: an alert is mailed"));
  for (const line of lines) {
    for (const key of Object.keys(line)) assert.ok(allowed.has(key), `${line.msg}: ${key}`);
  }
  const text = logs.raw.join("");
  for (const kept of [a.owner.email, a.owner.displayName ?? "", a.name]) {
    assert.ok(!text.includes(kept), `the logs hold no ${kept}`);
  }
});

test("the recorded history of credits_alerts replays", () =>
  replayHistories(env.workflowsPath, [HISTORY]));
