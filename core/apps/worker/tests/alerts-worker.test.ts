// The alerts on the worker (README "Alerts"; gamma-p7-040), end to end on the slice's Temporal and a
// schema of its database, the alerts fake as the team channel: test activities through the host's
// wrapper and workflows through its interceptor and sink, with `retry` unset as every module leaves
// it; the host's outbox loop; linkedin's alert events, loaded from its build as the worker loads it.
// An activity that fails its 3 attempts sends one alert, a NOT_RETRIED code one at its first failure,
// a retried attempt none; activity_attempts_exhausted, activity_input_invalid and a failure with
// details and a cause reach Temporal as their codes alone, and each sends an alert; a failed run sends
// one, a completed run none; a pass with dead letters one with their count; linkedin.invites_paused
// and linkedin.account_paused one each, with the account's and the health event's ids alone; a
// channel that answers 500 three times drops its alert with alerts_unreachable, while the activity
// and the delivery end as they would; a module whose `alerts` names an unknown event, or another
// module's, stops the start. Email's provider pause waits for the email phase (gamma-p1-060).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Context } from "@temporalio/activity";
import { outboxWriter, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  type ActivityDefinition,
  AppError,
  bindWorkflowStarter,
  collectLogs,
  createLogger,
  defineActivity,
  defineEvents,
  outboxConfig,
  publish,
  servicePrincipal,
  subscribe,
  workflowInput,
} from "@whytide/platform";
import { type AlertsFake, alertsPort, getAdapter } from "@whytide/providers";
import { z } from "zod";
import { hostActivity } from "../src/activities.ts";
import {
  type Alert,
  type AlertQueue,
  bindAlerts,
  createAlertQueue,
  subscribeAlerts,
} from "../src/alerts.ts";
import { moduleLoaders } from "../src/modules.generated.ts";
import { loadModules } from "../src/modules.ts";
import { startOutboxLoop } from "../src/outbox.ts";
import { runWorkflow, withTestWorkflowEnvironment } from "../testing/index.ts";

withTestDb();
withTestWorkflowEnvironment({
  workflowsPath: join(import.meta.dirname, "fixtures", "alerts-workflows.ts"),
});
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const channel = await getAdapter(alertsPort, "fake");
const fake = channel as unknown as AlertsFake;
const linkedin = await loadModules(moduleLoaders.filter(({ name }) => name === "linkedin"));
subscribeAlerts(linkedin.alerts); // as start() does
const WORKSPACE_ID = "ws_alerts";
const NAME = "alerts_activity";
/** The start-to-close of an attempt that ends at once. */
const CALL_MS = 60_000;
/** The start-to-close of an attempt that hangs: short, as Temporal's backoff comes between attempts. */
const HANG_MS = 500;
/** How long a hanging attempt sleeps: past its start-to-close, until the worker cancels it. */
const HANG_FOR_MS = 30_000;
const ids = () => {
  const ulid = randomUUID().replaceAll("-", "").slice(0, 25).toUpperCase(); // hex: Crockford's
  return { sender: `sa_0${ulid}`, health: `lhe_0${ulid}` };
};

const events = defineEvents({ "alerts_test.broken": z.strictObject({ thing_id: z.string() }) });
subscribe(events["alerts_test.broken"], async () => {
  throw new AppError("fixture_broken");
});

// Every alert the host raises is kept, then queued on the test's queue, made anew for each test.
const raised: Alert[] = [];
const waits: number[] = [];
let hold: (() => Promise<void>) | undefined;
let queue: AlertQueue;
bindAlerts({
  raise(alert) {
    raised.push(alert);
    queue.raise(alert);
  },
});
beforeEach(() => {
  fake.reset();
  raised.length = 0;
  waits.length = 0;
  const send = (input: { text: string }) => channel.send(input);
  const wait = async (ms: number) => {
    waits.push(ms);
    await hold?.();
  };
  queue = createAlertQueue({ send, log, sleep: wait });
});

/** `definition` as activity NAME, through the host's wrapper, in alerts_probe: its final failure. */
function probe(definition: ActivityDefinition, input: object = {}, startToCloseMs = CALL_MS) {
  const activities = { [NAME]: hostActivity(NAME, definition, { log }) };
  const request = {
    activity: NAME,
    input: { workspaceId: WORKSPACE_ID, ...input },
    startToCloseMs,
  };
  type Failure = { type: string; message: string; details: number; cause: boolean } | null;
  return runWorkflow<{ failure: Failure }>("alerts_probe", request, { activities, log });
}
/** What reaches Temporal of a failure that carries its code alone. */
const only = (code: string) => ({ type: code, message: code, details: 0, cause: false });

/** An activity of `kind` failing every attempt with `error`; `seen` gets the attempts. */
function failing(seen: number[], kind: "db" | "ai" | "provider", error: () => Error, attempts?: 1) {
  return defineActivity({
    kind,
    ...(attempts && { attempts }),
    input: workflowInput,
    run: async (_input, { attempt }) => {
      seen.push(attempt);
      throw error();
    },
  });
}

/** The first truthy answer of `probe`, asked every 20 ms for 15 seconds at most. */
async function until<T>(ask: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const answer = await ask();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 15 seconds");
    await sleep(20);
  }
}

/** Publishes each event in one tenant run of a new workspace: the outbox rows' ids. */
async function published(rows: readonly (readonly [string, Record<string, unknown>])[]) {
  const workspaceId = `ws_${randomUUID()}`;
  const tenant = { workspaceId, principal: servicePrincipal("test") };
  const client = asRole("app");
  return withTenant(
    tenant,
    async (tx) => {
      const out: string[] = [];
      for (const [name, payload] of rows)
        out.push(await publish(outboxWriter(tx, workspaceId), name, payload));
      return out;
    },
    { client },
  );
}

test("a db activity that fails its 3 attempts sends one alert naming the activity and the code; the attempts retried send none", async () => {
  const seen: number[] = [];
  const { failure } = await probe(failing(seen, "db", () => new AppError("mail_unreachable")));
  assert.deepEqual(failure, only("mail_unreachable"));
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(raised, [{ kind: "activity", name: NAME, code: "mail_unreachable" }]);
  await queue.drain();
  assert.deepEqual(fake.sent(), [`[test] activity ${NAME} mail_unreachable`]);
});

test("a code on NOT_RETRIED sends one alert at its first failure", async () => {
  const seen: number[] = [];
  const { failure } = await probe(failing(seen, "ai", () => new AppError("llm_invalid_key")));
  assert.deepEqual(failure, only("llm_invalid_key"));
  assert.deepEqual(seen, [1]);
  assert.deepEqual(raised, [{ kind: "activity", name: NAME, code: "llm_invalid_key" }]);
  await queue.drain();
  assert.deepEqual(fake.sent(), [`[test] activity ${NAME} llm_invalid_key`]);
});

test("activity_attempts_exhausted, activity_input_invalid and a failure with details and a cause reach Temporal as their codes alone, and each sends an alert; so does a thrown Error, as activity_failed", async () => {
  const seen: number[] = [];
  const hangs = defineActivity({
    kind: "db",
    attempts: 1,
    input: workflowInput,
    run: async (_input, { attempt }) => {
      seen.push(attempt);
      await Context.current().sleep(HANG_FOR_MS);
    },
  });
  const exhausted = await probe(hangs, {}, HANG_MS);
  assert.deepEqual(exhausted.failure, only("activity_attempts_exhausted"));
  assert.deepEqual(seen, [1], "the attempt past the bound is refused before it runs");

  const counted = defineActivity({
    kind: "db",
    input: workflowInput.extend({ count: z.number() }),
    run: async () => null,
  });
  const invalid = await probe(counted, { count: "Ada Lovelace" });
  assert.deepEqual(invalid.failure, only("activity_input_invalid"));

  const cause = new Error("Ada Lovelace <ada@example.com> https://www.linkedin.com/in/ada");
  const detailed = () =>
    new AppError("mail_rejected", { details: { email: "ada@example.com" }, cause });
  const rejected = await probe(failing([], "provider", detailed, 1));
  assert.deepEqual(rejected.failure, only("mail_rejected"));
  const thrown = await probe(failing([], "provider", () => new Error(cause.message), 1));
  assert.deepEqual(thrown.failure, only("activity_failed"));

  const codes = ["activity_attempts_exhausted", "activity_input_invalid"];
  codes.push("mail_rejected", "activity_failed");
  assert.deepEqual(
    raised,
    codes.map((code) => ({ kind: "activity", name: NAME, code })),
  );
  await queue.drain();
  assert.deepEqual(
    fake.sent(),
    codes.map((code) => `[test] activity ${NAME} ${code}`),
  );
});

test("a failed workflow run sends one alert with its type and its failure's code, never its message; a completed run sends none", async () => {
  assert.equal(await runWorkflow("alerts_done", {}, { log }), "done");
  await assert.rejects(runWorkflow("alerts_fail", {}, { log }));
  await until(() => raised.length > 0);
  await sleep(100); // time for a second alert, if there were one
  assert.deepEqual(raised, [{ kind: "workflow", name: "alerts_fail", code: "fixture_failed" }]);
  await queue.drain();
  assert.deepEqual(fake.sent(), ["[test] workflow alerts_fail fixture_failed"]);
});

test("an outbox pass that dead-letters events sends one alert with their count", async () => {
  const rows = await published([
    [events["alerts_test.broken"], { thing_id: "t_1" }],
    [events["alerts_test.broken"], { thing_id: "t_2" }],
  ]);
  const client = asRole("app");
  const last = outboxConfig.OUTBOX_MAX_ATTEMPTS - 1;
  await client.outboxEntry.updateMany({ where: { id: { in: rows } }, data: { attempts: last } });
  const outbox = startOutboxLoop(client, log);
  try {
    const dead = { id: { in: rows }, deadAt: { not: null } };
    await until(async () => (await client.outboxEntry.count({ where: dead })) === 2);
    await until(() => raised.length > 0);
  } finally {
    await outbox.stop();
  }
  assert.deepEqual(raised, [{ kind: "outbox", name: "dead", count: 2 }]);
  await queue.drain();
  assert.deepEqual(fake.sent(), ["[test] outbox dead count=2"]);
});

test("linkedin.invites_paused and linkedin.account_paused, delivered through the outbox, each send one alert with the account's id and the health event's id only", async () => {
  assert.deepEqual(linkedin.alerts, ["linkedin.invites_paused", "linkedin.account_paused"]);
  // linkedin's own subscribers start its mails' workflow: started, as far as they know.
  const unbind = bindWorkflowStarter({ start: async () => ({ started: true }) });
  const trip = ids();
  const pause = ids();
  const outbox = startOutboxLoop(asRole("app"), log);
  try {
    await published([
      ["linkedin.invites_paused", { sender_account_id: trip.sender, health_event_id: trip.health }],
      [
        "linkedin.account_paused",
        { sender_account_id: pause.sender, health_event_id: pause.health },
      ],
    ]);
    await until(() => raised.length === 2);
  } finally {
    await outbox.stop();
    unbind();
  }
  await queue.drain();
  assert.deepEqual([...fake.sent()].sort(), [
    `[test] event linkedin.account_paused sender_account_id=${pause.sender} health_event_id=${pause.health}`,
    `[test] event linkedin.invites_paused sender_account_id=${trip.sender} health_event_id=${trip.health}`,
  ]);
});

test("a channel that answers 500 three times: the alert is dropped and logged with alerts_unreachable, while the failing activity and the delivery end as they would, neither waiting on it", async () => {
  for (let i = 0; i < 3; i++) fake.failNext("alerts_unreachable", { status: 500 });
  const released: (() => void)[] = [];
  hold = () => new Promise<void>((resolve) => released.push(resolve));
  const unbind = bindWorkflowStarter({ start: async () => ({ started: true }) });
  const outbox = startOutboxLoop(asRole("app"), log);
  const pause = ids();
  try {
    const seen: number[] = [];
    const first = await probe(failing(seen, "ai", () => new AppError("llm_invalid_key")));
    let drained = false;
    const draining = queue.drain().then(() => {
      drained = true;
    });
    await until(() => released.length === 1); // the first send failed: the drain waits
    // While the drain waits on the channel, the same activity fails the same way, as soon...
    const again = await probe(failing(seen, "ai", () => new AppError("llm_invalid_key")));
    assert.deepEqual(
      [first.failure, again.failure],
      [only("llm_invalid_key"), only("llm_invalid_key")],
    );
    assert.deepEqual(seen, [1, 1]);
    // ...and an event is delivered, at its first attempt.
    const payload = { sender_account_id: pause.sender, health_event_id: pause.health };
    const [row = ""] = await published([["linkedin.account_paused", payload]]);
    const entry = await until(async () => {
      const found = await asRole("app").outboxEntry.findUniqueOrThrow({ where: { id: row } });
      return found.deliveredAt ? found : null;
    });
    assert.deepEqual([entry.attempts, entry.lastError, entry.deadAt], [1, null, null]);
    assert.equal(drained, false, "the drain still waits on the channel");
    while (!drained) {
      released.shift()?.();
      await sleep(10);
    }
    await draining;
  } finally {
    hold = undefined;
    for (const release of released) release();
    await outbox.stop();
    unbind();
  }
  assert.deepEqual(waits, [1_000, 2_000]);
  const dropped = logs.lines().filter(({ msg }) => msg === "worker: an alert was dropped");
  assert.deepEqual(
    dropped.map((line) => [line.code, line.kind, line.attempt]),
    [["alerts_unreachable", "activity", 3]],
  );
  // The second failure fell in the first's window; the event's alert went once the drain went on.
  assert.deepEqual(fake.sent(), [
    `[test] event linkedin.account_paused sender_account_id=${pause.sender} health_event_id=${pause.health}`,
  ]);
});

test("a module whose alerts name an unknown event, or another module's, stops the start with worker_module_invalid and details.field alerts", async () => {
  const declaring = (alerts: unknown) => ({ name: "probe", workflows: async () => ({ alerts }) });
  const invalid = (event?: string) => ({
    code: "worker_module_invalid",
    details: { module: "probe", field: "alerts", ...(event && { event }) },
  });
  await assert.rejects(loadModules([declaring(["probe.missing"])]), invalid("probe.missing"));
  const others = "linkedin.invites_paused";
  await assert.rejects(loadModules([declaring([others])]), invalid(others));
  await assert.rejects(loadModules([declaring("probe.missing")]), invalid());
});
