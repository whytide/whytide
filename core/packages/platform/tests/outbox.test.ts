// Unit tests of the delivery runtime (alpha-p1-050) on an in-memory store, without a database: an
// explicit undefined option keeps its default (a NULL limit would be unbounded), a pass stops starting
// rows at its time budget and leaves the rest of the batch pending, a deterministic failure (an event
// this worker does not know) waits on the slow schedule while a plain throw waits on the fast one, and
// a row with no subscriber is marked delivered with a debug line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { defineEvents, subscribe } from "../events/index.ts";
import { createLogger } from "../logging/index.ts";
import {
  deliverPending,
  type OutboxMarks,
  type OutboxRow,
  type OutboxStore,
} from "../outbox/index.ts";
import { collectLogs } from "../testing/index.ts";

const events = defineEvents({
  "runtime.ticked": z.object({ tick_id: z.string() }),
  "runtime.failed": z.object({ job_id: z.string() }),
  "runtime.ignored": z.object({ x_id: z.string() }),
});
let clock = 1_700_000_000_000;
const now = () => new Date(clock);
const runInTenant = <T>(_workspaceId: string, fn: (tx: null) => Promise<T>) => fn(null);
const NONE = { claimed: 0, delivered: 0, retried: 0, dead: 0, deferred: 0 };

const ticks: string[] = [];
subscribe(events["runtime.ticked"], (payload) => {
  ticks.push(payload.tick_id);
  clock += 20_000;
});
subscribe(events["runtime.failed"], () => {
  throw new Error("boom");
});

function fakeStore(rows: OutboxRow[]) {
  const claims: { limit: number; now: Date }[] = [];
  const marked: string[] = [];
  const patch = (row: OutboxRow, changes: Partial<OutboxRow>) => {
    rows[rows.indexOf(row)] = { ...row, ...changes };
  };
  const marks: OutboxMarks = {
    async delivered(row, at) {
      marked.push(`delivered ${row.id}`);
      patch(row, at);
    },
    async failed(row, next) {
      marked.push(`failed ${row.id}`);
      patch(row, next);
    },
    async dead(row, at) {
      marked.push(`dead ${row.id}`);
      patch(row, at);
    },
  };
  const store: OutboxStore = {
    claimTimeoutMs: 60_000,
    async claim(limit, at, fn) {
      claims.push({ limit, now: at });
      const due = rows.filter((r) => !r.deliveredAt && !r.deadAt && r.nextAttemptAt <= at);
      await fn(due.slice(0, limit), marks);
    },
    replay: async () => false,
    stats: async () => ({ dead: rows.filter((r) => r.deadAt).length, oldestDueAt: null }),
  };
  return { store, claims, marked, rows };
}

const row = (id: string, eventName: string, payload: Record<string, unknown>): OutboxRow => ({
  id,
  workspaceId: "wsp_runtime",
  eventName,
  payload,
  createdAt: now(),
  deliveredAt: null,
  attempts: 0,
  nextAttemptAt: now(),
  deadAt: null,
  lastError: null,
});

test("an explicit undefined option keeps its default: the limit is 100, the clock and the logger exist", async () => {
  const { store, claims } = fakeStore([]);
  const report = await deliverPending({
    store,
    runInTenant,
    limit: undefined,
    maxAttempts: undefined,
    now: undefined,
    backoff: undefined,
    log: undefined,
    budgetMs: undefined,
  });
  assert.deepEqual(report, NONE);
  assert.equal(claims[0]?.limit, 100);
  assert.ok(claims[0]?.now instanceof Date);
});

test("a pass starts no row past half the claim timeout: the rest of the batch stays pending", async () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination });
  const { store, marked, rows } = fakeStore(
    ["t1", "t2", "t3"].map((id) => row(id, "runtime.ticked", { tick_id: id })),
  );
  const first = await deliverPending({ store, runInTenant, now, log });
  assert.deepEqual(first, { ...NONE, claimed: 3, delivered: 2, deferred: 1 });
  assert.deepEqual(ticks, ["t1", "t2"]);
  assert.deepEqual(marked, ["delivered t1", "delivered t2"]);
  assert.equal(rows[2]?.deliveredAt, null, "the deferred row is untouched");
  const line = logs
    .lines()
    .find((l) => l.msg === "outbox: the pass ran out of time, rows left pending");
  assert.ok(line);
  assert.equal(line.deferred_count, 1);
  assert.equal(line.budget_ms, 30_000);
  const second = await deliverPending({ store, runInTenant, now, log });
  assert.deepEqual(second, { ...NONE, claimed: 1, delivered: 1 });
  assert.deepEqual(ticks, ["t1", "t2", "t3"]);
});

test("an event this worker does not know waits on the slow schedule; a plain throw on the fast one", async () => {
  const log = createLogger({ destination: collectLogs().destination });
  const { store, rows } = fakeStore([
    row("u1", "nobody.knows", { x_id: "x" }),
    row("f1", "runtime.failed", { job_id: "job_1" }),
  ]);
  const before = clock;
  assert.deepEqual(await deliverPending({ store, runInTenant, now, log }), {
    ...NONE,
    claimed: 2,
    retried: 2,
  });
  const [unknown, failed] = rows;
  assert.equal(unknown?.lastError, "unknown_event");
  assert.equal(unknown?.attempts, 1);
  const slowWait = (unknown?.nextAttemptAt.getTime() ?? 0) - before;
  assert.ok(slowWait >= 30_000 && slowWait < 60_000, `${slowWait} ms: half a minute to one`);
  assert.equal(failed?.lastError, "Error");
  const fastWait = (failed?.nextAttemptAt.getTime() ?? 0) - before;
  assert.ok(fastWait >= 500 && fastWait < 1_000, `${fastWait} ms: half a second to one`);
});

test("a row with no subscriber is marked delivered, with a debug line", async () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination, level: "debug" });
  const { store, marked } = fakeStore([row("i1", "runtime.ignored", { x_id: "x" })]);
  assert.deepEqual(await deliverPending({ store, runInTenant, now, log }), {
    ...NONE,
    claimed: 1,
    delivered: 1,
  });
  assert.deepEqual(marked, ["delivered i1"]);
  const line = logs.lines().find((l) => l.msg === "outbox: no subscriber, marked delivered");
  assert.ok(line);
  assert.equal(line.event, "runtime.ignored");
  assert.equal(line.event_id, "i1");
  assert.equal(line.workspace_id, "wsp_runtime");
});
