// privacy's 30-day rule end to end (gamma-p7-010; core/modules/privacy/README.md "The 30-day rule"),
// on the slice's Temporal and a schema of its database: privacy loaded from its build by the worker's
// own loader; contacts, signals, tenancy and privacy's test hooks from their builds by path, the
// files the loader's modules import (no package depends on privacy). The runs and the sweep are the
// loaded activities' own code, given fixed cutoffs; the workflow runs on a worker of the test's, its
// activities through the host's wrapper, and takes its cutoff from its start, so the persons it
// deletes were found on 1 January 2026: no test reads the clock. The schedule; two workspaces and
// each criterion's case; the guard and the recheck, a touch still open among them; a re-import
// before day 30; the person added again by a new signal after the deletion; the cap per run; one
// person failing; a late write swept; one workspace failing; the lines, the answers and the history
// hold ids and counts only. The replay of the recorded history is `pnpm -F worker test:replay`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { ActivityDefinition } from "@whytide/platform";

// No step calls a model; the providers' config reads the LLM port as it loads, below.
process.env.PROVIDER_LLM = "fake";

const { Client, Connection } = await import("@temporalio/client");
const { historyToJSON } = await import("@temporalio/common/lib/proto-utils.js");
const { NativeConnection, Worker } = await import("@temporalio/worker");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { IDENTITY, metricSinks, workflowBundle } = await import("../src/temporal.ts");
const { withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type Contacts = typeof import("../../../modules/contacts/dist/index.js");
type ContactsTesting = typeof import("../../../modules/contacts/dist/testing/index.js");
type PrivacyTesting = typeof import("../../../modules/privacy/dist/testing/index.js");
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const contacts: Contacts = await built("contacts/dist/index.js");
const { useHashSalt }: ContactsTesting = await built("contacts/dist/testing/index.js");
const { usePrivacyClient, useRetentionCap }: PrivacyTesting = await built(
  "privacy/dist/testing/index.js",
);
const { createSignalEvent }: SignalsTesting = await built("signals/dist/testing/index.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
type Activity = (input: never) => Promise<unknown>;
type Run = { candidates: number; deleted: number; skipped: number; failed: number };
type RunAnswer = Run & { deletedIds: string[] };
type Swept = { rows: Record<string, number>; failed: number };

withTestDb();
const env = withTestWorkflowEnvironment();
const app = () => asRole("app");
const owner = () => asRole("owner");
useHashSalt("test-salt-".repeat(4));
usePrivacyClient(app());
tenancy.useTenancyClient(app());
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const privacy = moduleLoaders.filter(({ name }) => name === "privacy");
const loaded = await loadModules(privacy);
await startModules(loaded, log);
const hosted: Record<string, Activity> = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app(), log })];
  }),
);
const definitionOf = (name: string) => loaded.activities.get(name) as ActivityDefinition;
/** The loaded activity's own code, its input parsed, as the host's wrapper runs a global one. */
async function activity<T>(name: string, input: object): Promise<T> {
  const definition = definitionOf(name);
  const run = definition.run as (input: unknown, context: { attempt: number }) => Promise<unknown>;
  return (await run(definition.input.parse(input), { attempt: 1 })) as T;
}

const DAY = 86_400_000;
/** The run's instant; its cutoff is 30 days before, 2026-10-02T03:15Z. */
const RUN = new Date("2026-11-01T03:15:00.000Z");
const cutoffAt = (run: Date) => new Date(run.getTime() - 30 * DAY).toISOString();
const daysBefore = (days: number) => new Date(RUN.getTime() - days * DAY);
const runIn = (workspace: string, run = RUN) =>
  activity<RunAnswer>("privacy_retention_run", { workspace, cutoff: cutoffAt(run) });
const NAME = "Marisol";
const principal = platform.servicePrincipal("test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app() });
const workspace = async () => (await tenancy.createOrganizationWithWorkspace()).workspace.id;
let made = 0;

/**
 * A person of the workspace from an import, found at `found`, with a lead and a signal event, an
 * opt-out and a touch when asked; its id.
 */
async function personIn(
  workspaceId: string,
  options: { found: Date; slug?: string; locationText?: string; touched?: Date; optOut?: boolean },
): Promise<string> {
  made += 1;
  const slug = options.slug ?? `marisol-retention-${made}`;
  const id = await inRun(workspaceId, async () => {
    const linkedinUrl = `https://linkedin.com/in/${slug}`;
    const profile = { linkedinUrl, firstName: NAME, locationText: options.locationText };
    const { person } = await contacts.upsertPersonFromSource({
      ...{ source: "import", provider: "csv" },
      profile,
    });
    const source = { kind: "imported", ref: "imp_1" } as const;
    await contacts.createLeadForPerson({ personId: person.id, source });
    if (options.optOut)
      await contacts.addOptOut(person.id, { source: "manual", createdBy: "usr_1" });
    if (options.touched) await contacts.recordTouch(person.id, options.touched);
    return person.id;
  });
  await createSignalEvent({ workspaceId, personId: id, commentText: `${NAME} on pipelines` });
  await owner().$executeRaw`UPDATE persons SET created_at = ${options.found} WHERE id = ${id}`;
  return id;
}

/** The person's row, its leads and its signal events. */
const rowsOf = (personId: string) =>
  Promise.all([
    owner().person.count({ where: { id: personId } }),
    owner().lead.count({ where: { personId } }),
    owner().signalEvent.count({ where: { personId } }),
  ]);

/** The tables of the test's schema with a row that holds `needle`. */
async function tablesHolding(needle: string): Promise<string[]> {
  const tables = await owner().$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const holding: string[] = [];
  for (const { name } of tables) {
    const [row] = await owner().$queryRawUnsafe<{ found: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM "${name}" t WHERE strpos(to_jsonb(t)::text, $1) > 0) AS found`,
      needle,
    );
    if (row?.found) holding.push(name);
  }
  return holding;
}

/** The lines logged since `mark`, parsed. */
const linesSince = (mark: number) =>
  logs.raw
    .slice(mark)
    .flatMap((chunk) => chunk.split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** A trigger of the test's schema, created as owner for the test and dropped after it. */
async function withTrigger<T>(
  name: string,
  sql: { fn: string; when: string; table: string },
  run: () => Promise<T>,
) {
  const fn = `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${sql.fn} END $$`;
  await owner().$executeRawUnsafe(fn);
  const on = `${sql.when} ON ${sql.table} FOR EACH ROW`;
  await owner().$executeRawUnsafe(`CREATE TRIGGER ${name} ${on} EXECUTE FUNCTION ${name}()`);
  try {
    return await run();
  } finally {
    await owner().$executeRawUnsafe(`DROP TRIGGER ${name} ON ${sql.table}`);
    await owner().$executeRawUnsafe(`DROP FUNCTION ${name}()`);
  }
}

let connection: import("@temporalio/worker").NativeConnection | undefined;
before(async () => {
  connection = await NativeConnection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
});
after(async () => {
  await connection?.close();
});

/** `fn` with a worker of a queue of its own running the workflows on `activities`. */
async function onWorker<T>(
  activities: Record<string, Activity>,
  fn: (taskQueue: string) => Promise<T>,
): Promise<T> {
  const taskQueue = `test-${randomUUID()}`;
  const worker = await Worker.create({
    connection: connection as import("@temporalio/worker").NativeConnection,
    namespace: env.namespace,
    taskQueue,
    identity: IDENTITY,
    workflowBundle: await workflowBundle(env.workflowsPath),
    activities,
    sinks: metricSinks(log),
  });
  return worker.runUntil(fn(taskQueue));
}

/** `read`'s first answer that is not undefined, polled every 50 ms, 30 seconds at most. */
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let tries = 0; tries < 600; tries += 1) {
    const found = await read();
    if (found !== undefined) return found;
    await sleep(50);
  }
  throw new Error("until: nothing came");
}

/** A history as JSON with every payload decoded beside it: the text a scan for data reads. */
function historyText(history: Parameters<typeof historyToJSON>[0]): string {
  const json = historyToJSON(history);
  const payloads = [...json.matchAll(/"data":\s*"([A-Za-z0-9+/=]+)"/g)];
  return [json, ...payloads.map(([, data]) => Buffer.from(data ?? "", "base64").toString())].join(
    "\n",
  );
}
const millisOf = (at: { seconds?: unknown; nanos?: number | null } | null | undefined) =>
  Number(String(at?.seconds ?? 0)) * 1000 + Math.floor((at?.nanos ?? 0) / 1e6);

test("the schedule privacy.retention starts privacy_retention daily at 03:15 UTC, skips a run while one runs, and stays paused while WORKER_SCHEDULES is off", async () => {
  const temporal = await Connection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  const client = new Client({ connection: temporal, namespace: workerConfig.TEMPORAL_NAMESPACE });
  const schedule = client.schedule.getHandle("privacy.retention");
  await schedule.delete().catch(() => undefined);
  const taskQueue = `test-${randomUUID()}`;
  const host = await start({
    ...{ modules: privacy, taskQueue, healthPort: 0, client: app(), log },
    schedules: "off",
  });
  try {
    const described = await schedule.describe();
    const [daily] = described.spec.calendars ?? [];
    const at = (range = [{ start: -1 }]) => range.map(({ start }) => start);
    assert.deepEqual(
      [described.action.workflowType, at(daily?.hour), at(daily?.minute), described.spec.timezone],
      ["privacy_retention", [3], [15], "UTC"],
    );
    assert.deepEqual([described.policies.overlap, described.state.paused], ["SKIP", true]);
  } finally {
    await host.close();
    await schedule.delete().catch(() => undefined);
    await temporal.close();
  }
});

test("a run deletes through every eraser the persons never touched, found by the cutoff, in the EU, the UK or nowhere known, with no hash and a log row each; it keeps the others and the other workspace's", async () => {
  const [a, b] = [await workspace(), await workspace()];
  const found = daysBefore(31);
  const gb = await personIn(a, { slug: "marisol-gb", locationText: "London, England", found });
  const fr = await personIn(a, { locationText: "Lyon, France", found });
  const nowhere = await personIn(a, { found });
  const named = await personIn(a, { locationText: "Cork, Ireland", found });
  // A country that is no two-letter code, as no source of contacts writes one: unknown, so in.
  await owner().$executeRaw`UPDATE persons SET location_country = 'Ireland' WHERE id = ${named}`;
  const kept = [
    await personIn(a, { locationText: "Leeds, United Kingdom", found: daysBefore(29) }),
    await personIn(a, { locationText: "Austin, Texas, United States", found: daysBefore(60) }),
    // Invited, or emailed: a touch is a touch.
    await personIn(a, {
      ...{ locationText: "Bristol, United Kingdom", found: daysBefore(60) },
      touched: daysBefore(40),
    }),
  ];
  const sameUrlInB = await personIn(b, { slug: "marisol-gb", locationText: "London", found });

  const run = await runIn(a);
  const gone = [gb, fr, nowhere, named];
  assert.deepEqual(
    { ...run, deletedIds: [...run.deletedIds].sort() },
    { candidates: 4, deleted: 4, skipped: 0, failed: 0, deletedIds: [...gone].sort() },
  );
  for (const id of gone) assert.deepEqual(await tablesHolding(id), [], "every eraser's rows");
  const left = await owner().person.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  assert.deepEqual(
    left.map(({ id }) => id),
    [...kept, sameUrlInB].sort(),
  );
  for (const id of kept) assert.deepEqual(await rowsOf(id), [1, 1, 1]);
  assert.equal(await owner().personHash.count({ where: { kind: "erased" } }), 0, "no hash");
  const rows = await owner().erasureLog.findMany();
  assert.deepEqual(
    rows.map((row) => [row.workspaceId, row.reason, row.personHash, row.performedBy]),
    gone.map(() => [a, "retention_never_contacted", null, "retention"]),
  );

  // B's own run deletes B's person.
  const inB = await runIn(b);
  assert.deepEqual(inB, {
    candidates: 1,
    deleted: 1,
    skipped: 0,
    failed: 0,
    deletedIds: [sameUrlInB],
  });
});

test("the guard and the recheck: a candidate touched, or moved off the list, between the read and its deletion is skipped and kept whole, with no log row", async () => {
  const a = await workspace();
  const first = await personIn(a, { locationText: "Paris, France", found: daysBefore(34) });
  const touched = await personIn(a, { locationText: "Nice, France", found: daysBefore(33) });
  const moved = await personIn(a, { locationText: "Lyon, France", found: daysBefore(32) });
  // The first deletion's log row, in its transaction, touches the second (a send that settles after
  // the read and before the second's run) and moves the third to the US (a re-import meanwhile),
  // which the guard does not read and the recheck does.
  const touch = `UPDATE persons SET last_touch_at = '2026-10-31T10:00:00Z' WHERE id = '${touched}';`;
  const move = `UPDATE persons SET location_country = 'US' WHERE id = '${moved}';`;
  const on = { when: "AFTER INSERT", table: "erasure_log" };
  const fn = `${touch} ${move} RETURN NEW;`;
  const run = await withTrigger("retention_change", { fn, ...on }, () => runIn(a));
  assert.deepEqual(run, { candidates: 3, deleted: 1, skipped: 2, failed: 0, deletedIds: [first] });
  assert.deepEqual(await rowsOf(touched), [1, 1, 1]);
  assert.deepEqual(await rowsOf(moved), [1, 1, 1]);
  assert.equal(await owner().erasureLog.count(), 1, "the first deletion's row alone");
});

test("the recheck: a touch still being written when the deletion runs is waited for under the person's lock, and the person is kept, with no log row", async () => {
  const a = await workspace();
  const id = await personIn(a, { locationText: "Porto, Portugal", found: daysBefore(31) });
  // A send's settle in a run of its own: the touch written and not committed while the deletion
  // runs, so the guard's first look reads none; the settle holds no lead lock.
  const opened = Promise.withResolvers<number>();
  const held = Promise.withResolvers<void>();
  const settle = withTenant(
    { workspaceId: a, principal },
    async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await contacts.recordTouch(id, new Date("2026-10-31T10:00:00.000Z"));
      opened.resolve(backend?.pid ?? 0);
      await held.promise;
    },
    { client: app(), timeout: 60_000 },
  );
  const pid = await opened.promise;
  const run = runIn(a);
  try {
    // The deletion waits on the person's row, which the settle holds; then the settle commits.
    await until(async () => {
      const [waiting] = await owner().$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE ${pid}::int = ANY (pg_blocking_pids(pid))`;
      return (waiting?.n ?? 0) > 0 ? true : undefined;
    });
  } finally {
    held.resolve();
    await settle;
  }
  assert.deepEqual(await run, { candidates: 1, deleted: 0, skipped: 1, failed: 0, deletedIds: [] });
  assert.deepEqual(await rowsOf(id), [1, 1, 1]);
  assert.equal(await owner().erasureLog.count(), 0, "no log row");
});

test("a re-import before day 30 keeps the clock and the person goes on day 30; a new signal adds the URL again as a new person whom the opt-out still suppresses", async () => {
  const a = await workspace();
  const found = new Date("2026-09-01T09:00:00.000Z");
  const day = (n: number) => new Date(found.getTime() + n * DAY);
  const linkedinUrl = "https://linkedin.com/in/marisol-reimported";
  const where = { slug: "marisol-reimported", locationText: "Utrecht, Netherlands" };
  const id = await personIn(a, { ...where, found, optOut: true });
  // Day 29: a re-import and a refresh of the profile, through contacts' batch upsert.
  const refreshed = { linkedinUrl, title: "Head of Sales", fetchedAt: day(29) };
  await inRun(a, () =>
    contacts.upsertPersonsFromSource([{ source: "import", provider: "csv", profile: refreshed }]),
  );
  const person = await owner().person.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([person.title, person.createdAt], ["Head of Sales", found]);
  const none = { candidates: 0, deleted: 0, skipped: 0, failed: 0, deletedIds: [] };
  assert.deepEqual(await runIn(a, day(29)), none, "day 29 keeps the person");
  assert.deepEqual((await runIn(a, day(30))).deletedIds, [id], "day 30 deletes them");

  // A new signal finds them again: a new person, a new clock; the opt-out, kept, suppresses them.
  const signal = { source: "linkedin", provider: "unipile", profile: { linkedinUrl } } as const;
  const [again] = await inRun(a, () => contacts.upsertPersonsFromSource([signal]));
  assert.ok(again !== undefined && "person" in again);
  assert.equal(again.created, true);
  assert.notEqual(again.person.id, id);
  assert.ok(again.person.createdAt.getTime() > found.getTime());
  const check = await inRun(a, () =>
    contacts.suppressionOf(again.person.id, { newEnrollment: true }),
  );
  assert.deepEqual(check, { suppressed: true, reason: "opted_out" });
});

test("the cap: a run deletes RETENTION_MAX_PER_RUN at most, the oldest first; the rest wait for the next day", async () => {
  const a = await workspace();
  const ids: string[] = [];
  for (const days of [33, 32, 31]) {
    ids.push(await personIn(a, { locationText: "Dublin, Ireland", found: daysBefore(days) }));
  }
  useRetentionCap(2);
  try {
    const first = await runIn(a);
    const two = { candidates: 3, deleted: 2, skipped: 0, failed: 0, deletedIds: ids.slice(0, 2) };
    assert.deepEqual(first, two);
    const next = await runIn(a, new Date(RUN.getTime() + DAY));
    assert.deepEqual(next, {
      candidates: 1,
      deleted: 1,
      skipped: 0,
      failed: 0,
      deletedIds: ids.slice(2),
    });
  } finally {
    useRetentionCap(undefined);
  }
});

test("one person failing to delete leaves the others deleted, counts as failed and keeps every row; its line holds the workspace and a code", async () => {
  const a = await workspace();
  const one = await personIn(a, { found: daysBefore(33) });
  const failing = await personIn(a, { found: daysBefore(32) });
  const other = await personIn(a, { found: daysBefore(31) });
  const refuse = `IF OLD.id = '${failing}' THEN RAISE EXCEPTION 'refused by the test'; END IF; RETURN OLD;`;
  const on = { when: "BEFORE DELETE", table: "persons" };
  const mark = logs.raw.length;
  const run = await withTrigger("retention_refuse", { fn: refuse, ...on }, () => runIn(a));
  assert.deepEqual(run, {
    candidates: 3,
    deleted: 2,
    skipped: 0,
    failed: 1,
    deletedIds: [one, other],
  });
  assert.deepEqual(await rowsOf(failing), [1, 1, 1]);
  const failed = linesSince(mark).filter(
    ({ msg }) => msg === "privacy: a retention deletion failed",
  );
  assert.deepEqual(
    failed.map((line) => [line.workspace_id, typeof line.code]),
    [[a, "string"]],
  );
  const ran = linesSince(mark).filter(({ msg }) => msg === "privacy: retention ran");
  assert.deepEqual(
    ran.map(({ level, time, pid, hostname, ...fields }) => fields),
    [
      {
        msg: "privacy: retention ran",
        workspace_id: a,
        ...{ candidate_count: 3, deleted_count: 2, skipped_count: 0, failed_count: 1 },
      },
    ],
  );
});

test("the sweep removes a row written for a deleted person's id after the deletion, and logs the totals with the rows by table", async () => {
  const a = await workspace();
  const id = await personIn(a, { locationText: "Madrid, Spain", found: daysBefore(31) });
  assert.deepEqual((await runIn(a)).deletedIds, [id]);
  // A batch in flight writes for the id after the deletion.
  await createSignalEvent({ workspaceId: a, personId: id, commentText: "a late comment" });
  assert.ok((await tablesHolding(id)).includes("signal_events"));
  const mark = logs.raw.length;
  const totals = { workspaces: 1, candidates: 1, deleted: 1, skipped: 0, failed: 0 };
  const input = {
    deleted: [{ workspace: a, personIds: [id] }],
    totals: { ...totals, workspacesFailed: 0 },
  };
  const swept = await activity<Swept>("privacy_retention_sweep", input);
  assert.equal(swept.failed, 0);
  assert.equal(swept.rows["signals.signal_events"], 1);
  assert.equal(swept.rows["contacts.persons"], undefined, "contacts' eraser is not swept");
  assert.deepEqual(await tablesHolding(id), []);
  const [line, ...more] = linesSince(mark).filter(({ msg }) => msg === "privacy: retention ran");
  assert.deepEqual(more, []);
  const sweptRows = Object.values(swept.rows).reduce((sum, n) => sum + n, 0);
  assert.deepEqual(
    [line?.workspace_count, line?.candidate_count, line?.deleted_count, line?.skipped_count],
    [1, 1, 1, 0],
  );
  assert.deepEqual(
    [line?.failed_count, line?.workspace_failed_count, line?.sweep_failed_count, line?.swept_count],
    [0, 0, 0, sweptRows],
  );
  assert.equal(line?.swept_signals_signal_events_count, 1);
  assert.equal(line?.workspace_id, undefined, "the totals' line names no workspace");
});

test("the workflow runs every workspace as of its start less 30 days and waits RETENTION_SWEEP_DELAY_MINUTES after deletions; its history holds ids and counts only", async () => {
  const [a, b] = [await workspace(), await workspace()];
  const found = new Date("2026-01-01T00:00:00.000Z");
  const slug = "marisol-workflow";
  const gone = await personIn(a, { slug, locationText: "Vienna, Austria", found });
  const kept = await personIn(b, { locationText: "Toronto, Canada", found });
  const workflowId = `privacy_retention-${randomUUID()}`;
  const text = await onWorker(hosted, async (taskQueue) => {
    const handle = await env.client.workflow.start("privacy_retention", {
      ...{ args: [{}], taskQueue, workflowId },
      workflowExecutionTimeout: "30 minutes",
    });
    try {
      const timer = await until(async () => {
        const { events } = await handle.fetchHistory();
        const started = (events ?? []).find((event) => event.timerStartedEventAttributes);
        return started?.timerStartedEventAttributes ?? undefined;
      });
      assert.equal(Number(String(timer.startToFireTimeout?.seconds)), 15 * 60);
      const history = await handle.fetchHistory();
      const events = history.events ?? [];
      const runs = events.flatMap((event) => {
        const scheduled = event.activityTaskScheduledEventAttributes;
        if (scheduled?.activityType?.name !== "privacy_retention_run") return [];
        const [payload] = scheduled.input?.payloads ?? [];
        return [JSON.parse(Buffer.from(payload?.data ?? []).toString()) as { cutoff: string }];
      });
      // Both runs as of one cutoff: the start, read from the history, less 30 days.
      assert.deepEqual(
        runs.map(({ cutoff, ...rest }) => rest),
        [a, b].sort().map((workspace) => ({ workspace })),
      );
      const cutoffs = [...new Set(runs.map((input) => Date.parse(input.cutoff)))];
      assert.equal(cutoffs.length, 1, "one cutoff for every workspace");
      const [cutoff = 0] = cutoffs;
      const started = millisOf(events[0]?.eventTime) - 30 * DAY;
      const firstTask = millisOf(events[3]?.eventTime) - 30 * DAY;
      assert.ok(cutoff >= started && cutoff <= firstTask, "the start's, less 30 days");
      return historyText(history);
    } finally {
      await handle.terminate("the test ends at the timer").catch(() => undefined);
    }
  });
  const left = await owner().person.findMany({ select: { id: true } });
  assert.deepEqual(left, [{ id: kept }]);
  assert.ok(text.includes(gone), "the deleted id goes to the sweep");
  for (const needle of [NAME, slug, "linkedin.com", "Vienna", "Austria", "Toronto", "pipelines"]) {
    assert.ok(!text.includes(needle), `the history holds no ${needle}`);
  }
  assert.doesNotMatch(text, /"(AT|CA)"/, "no country");
});

test("the workflow: a workspace that fails past its attempts leaves the others; the sweep runs with the totals, then the workflow fails with its code", async () => {
  const tried: string[] = [];
  const swept: unknown[] = [];
  const stub = (name: string, run: (input: never) => Promise<unknown>) => {
    const definition = { ...definitionOf(name), run } as ActivityDefinition;
    return hostActivity(name, definition, { client: app(), log });
  };
  const answer = { candidates: 2, deleted: 0, skipped: 1, failed: 1, deletedIds: [] };
  const activities = {
    privacy_retention_workspaces: stub("privacy_retention_workspaces", async () => ({
      workspaceIds: ["wsp_a", "wsp_b", "wsp_c"],
    })),
    privacy_retention_run: stub("privacy_retention_run", async (input: { workspace: string }) => {
      tried.push(input.workspace);
      if (input.workspace === "wsp_b") throw new Error("the run failed");
      return answer;
    }),
    privacy_retention_sweep: stub("privacy_retention_sweep", async (input: unknown) => {
      swept.push(input);
      return { rows: {}, failed: 0 };
    }),
  };
  const failure = await onWorker(activities, (taskQueue) =>
    env.client.workflow
      .execute("privacy_retention", {
        ...{ args: [{}], taskQueue, workflowId: `privacy_retention-${randomUUID()}` },
        workflowExecutionTimeout: "1 minute",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      ),
  );
  const code = (failure as { cause?: { cause?: { type?: string } } } | undefined)?.cause?.cause
    ?.type;
  assert.equal(code, "activity_failed");
  // The host's wrapper ends a db activity after its three attempts, and the run goes on to wsp_c.
  assert.deepEqual(tried, ["wsp_a", "wsp_b", "wsp_b", "wsp_b", "wsp_c"]);
  const totals = { workspaces: 3, candidates: 4, deleted: 0, skipped: 2, failed: 2 };
  assert.deepEqual(swept, [{ deleted: [], totals: { ...totals, workspacesFailed: 1 } }]);
});

test("every line privacy logged holds ids and counts only: no name, URL, location or country", () => {
  const lines = logs.raw.flatMap((chunk) => chunk.split("\n")).filter(Boolean);
  const own = lines.filter((line) => line.includes('"msg":"privacy:'));
  assert.ok(own.length > 0);
  assert.deepEqual(platform.checkLogLines(own), []);
  for (const line of own) {
    const { level, time, pid, hostname, msg, workspace_id, actor, code, ...counts } = JSON.parse(
      line,
    ) as Record<string, unknown>;
    assert.ok(typeof workspace_id === "string" || workspace_id === undefined, line);
    assert.ok(typeof code === "string" || code === undefined, line);
    for (const [key, value] of Object.entries(counts)) {
      assert.ok(key.endsWith("_count") && typeof value === "number", `${key} in ${line}`);
    }
  }
  for (const needle of [NAME, "linkedin.com/in", "London", "Vienna", "France", "pipelines"]) {
    assert.ok(!lines.some((line) => line.includes(needle)), `no line holds ${needle}`);
  }
});
