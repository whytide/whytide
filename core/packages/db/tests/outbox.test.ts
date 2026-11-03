// The end-to-end test of alpha-p1-050 (docs/rules/coding.md §11): events and the outbox used the way a
// module and the worker host use them, with the Prisma store on a database of this file's own, migrated
// with the real migrations (scratch-database.ts: `node --test` runs the files of tests/ at the same time
// and migrate.test.ts recreates the slice's database). A publish in a transaction that rolls back leaves
// no row; one that commits is delivered once, in a tenant transaction whose app.workspace_id is the
// event's; a throwing subscriber is retried with growing waits, dead-lettered after OUTBOX_MAX_ATTEMPTS
// (3 here, set before the platform loads), never delivered again until replayDeadLetter(); two
// deliverers at once: the second takes the other rows and never the one the first holds locked. The
// test's clock starts an hour ahead of the rows' real created_at and moves only when a step moves it.
// Run with `pnpm -F db test`.
import assert from "node:assert/strict";
import test from "node:test";
import type { EventContext } from "@whytide/platform";
import { z } from "zod";
import type { Prisma } from "../generated/client.ts";

process.env.OUTBOX_MAX_ATTEMPTS = "3";
const {
  AppError,
  checkLogLines,
  collectLogs,
  createLogger,
  defineEvents,
  deliverPending,
  isAppError,
  publish,
  replayDeadLetter,
  subscribe,
} = await import("@whytide/platform");
const { createDbClient, createOutboxStore, outboxWriter } = await import("../index.ts");
const { scratchDatabase } = await import("./scratch-database.ts");

type Tx = Prisma.TransactionClient;
type Received = {
  id: string;
  name: string;
  workspaceId: string;
  attempt: number;
  payload: unknown;
  setting: string | null;
};

const WSP_A = "wsp_outbox_a";
const WSP_B = "wsp_outbox_b";
const NONE = { claimed: 0, delivered: 0, retried: 0, dead: 0, deferred: 0 };

const events = defineEvents({
  "outbox_test.people_imported": z.object({
    import_id: z.string(),
    person_ids: z.array(z.string()),
  }),
  "outbox_test.lead_scored": z.object({ lead_id: z.string() }),
  "outbox_test.counted": z.object({ n: z.number().int() }),
});
const received: Received[] = [];
subscribe(events["outbox_test.people_imported"], async (payload, context: EventContext<Tx>) => {
  const [row] = await context.tx.$queryRaw<{ setting: string | null }[]>`
    SELECT current_setting('app.workspace_id', true) AS setting`;
  const { id, name, workspaceId, attempt } = context;
  received.push({ id, name, workspaceId, attempt, payload, setting: row?.setting ?? null });
});
let failing = true;
let failures = 0;
subscribe(events["outbox_test.lead_scored"], async (payload) => {
  if (!failing) return;
  failures += 1;
  throw new AppError("fixture_handler_failed", { details: { lead_id: payload.lead_id } });
});
const counted: string[] = [];
/** Armed by the two-deliverer test: the first handler to arrive reports its row and waits for release. */
let hold: { armed: boolean; reached: (id: string) => void; released: Promise<void> } | undefined;
subscribe(events["outbox_test.counted"], async (_payload, { id }) => {
  if (hold?.armed) {
    hold.armed = false;
    hold.reached(id);
    await hold.released;
  }
  counted.push(id);
});

/** An hour ahead of real time, so every row published during the test is due; moved by the steps only. */
let clock = Date.now() + 60 * 60_000;
const now = () => new Date(clock);
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const failsWith = (code: string) => (error: unknown) => isAppError(error) && error.code === code;

test("events and the outbox on a migrated database", async (t) => {
  const db = await scratchDatabase("outbox");
  const app = createDbClient("app", { url: db.url("app") });
  const store = createOutboxStore(app);
  /** A tenant transaction the way alpha-p1-045's withTenant will open one: SET LOCAL, then `fn`. */
  const runInTenant = <T>(workspaceId: string, fn: (tx: Tx) => Promise<T>) =>
    app.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        return fn(tx);
      },
      { timeout: 30_000 },
    );
  const deliver = (limit?: number) => deliverPending({ store, runInTenant, now, log, limit });
  const rowOf = (workspaceId: string, id: string) =>
    app.outboxEntry.findFirstOrThrow({ where: { id, workspaceId } });
  const pending = (workspaceId: string) =>
    app.outboxEntry.count({ where: { workspaceId, deliveredAt: null, deadAt: null } });

  try {
    await t.test("a publish in a transaction that rolls back leaves no row", async () => {
      await assert.rejects(
        app.$transaction(async (tx) => {
          const id = await publish(outboxWriter(tx, WSP_A), events["outbox_test.people_imported"], {
            import_id: "imp_0",
            person_ids: ["per_0"],
          });
          assert.match(id, /^obx_/);
          throw new Error("rolled back on purpose");
        }),
        /rolled back on purpose/,
      );
      assert.equal(await app.outboxEntry.count({ where: { workspaceId: WSP_A } }), 0);
    });

    await t.test(
      "a committed publish is delivered once, in the event's tenant transaction, and marked",
      async () => {
        const payload = { import_id: "imp_1", person_ids: ["per_1", "per_2"] };
        const id = await app.$transaction((tx) =>
          publish(outboxWriter(tx, WSP_A), events["outbox_test.people_imported"], payload),
        );
        const before = await rowOf(WSP_A, id);
        assert.equal(before.deliveredAt, null);
        assert.equal(before.attempts, 0);
        assert.deepEqual(before.payload, payload);
        assert.deepEqual(await deliver(), { ...NONE, claimed: 1, delivered: 1 });
        assert.deepEqual(received, [
          {
            id,
            name: "outbox_test.people_imported",
            workspaceId: WSP_A,
            attempt: 1,
            payload,
            setting: WSP_A,
          },
        ]);
        const after = await rowOf(WSP_A, id);
        assert.ok(after.deliveredAt instanceof Date);
        assert.equal(after.attempts, 1);
        assert.equal(after.lastError, null);
        assert.deepEqual(await deliver(), NONE);
        assert.equal(received.length, 1, "delivered once");
      },
    );

    await t.test(
      "a throwing subscriber is retried with growing waits, dead-lettered after OUTBOX_MAX_ATTEMPTS and replayed on request only",
      async () => {
        const id = await app.$transaction((tx) =>
          publish(outboxWriter(tx, WSP_B), events["outbox_test.lead_scored"], {
            lead_id: "lead_1",
          }),
        );
        assert.deepEqual(await deliver(), { ...NONE, claimed: 1, retried: 1 });
        const first = await rowOf(WSP_B, id);
        assert.equal(first.attempts, 1);
        assert.equal(first.deliveredAt, null);
        assert.equal(first.deadAt, null);
        assert.equal(first.lastError, "fixture_handler_failed");
        const wait1 = first.nextAttemptAt.getTime() - clock;
        assert.ok(
          wait1 >= 500 && wait1 < 1_000,
          `the first wait, ${wait1} ms, is half to one second`,
        );
        assert.deepEqual(await deliver(), NONE, "not due yet");

        clock = first.nextAttemptAt.getTime();
        assert.deepEqual(await deliver(), { ...NONE, claimed: 1, retried: 1 });
        const second = await rowOf(WSP_B, id);
        assert.equal(second.attempts, 2);
        const wait2 = second.nextAttemptAt.getTime() - clock;
        assert.ok(
          wait2 >= 1_000 && wait2 < 2_000 && wait2 > wait1,
          `the second wait, ${wait2} ms, grows`,
        );

        clock = second.nextAttemptAt.getTime();
        assert.deepEqual(await deliver(), { ...NONE, claimed: 1, dead: 1 });
        const dead = await rowOf(WSP_B, id);
        assert.equal(dead.attempts, 3);
        assert.ok(dead.deadAt instanceof Date);
        assert.equal(dead.deliveredAt, null);
        assert.equal(dead.lastError, "fixture_handler_failed");
        assert.equal(failures, 3);
        const line = logs
          .lines()
          .find((l) => l.msg === "outbox: dead-lettered after the last attempt");
        assert.ok(line, "a log line marks the dead letter");
        assert.equal(line.level, "error");
        assert.equal(line.event, "outbox_test.lead_scored");
        assert.equal(line.event_id, id);
        assert.equal(line.workspace_id, WSP_B);
        assert.equal(line.attempt, 3);
        assert.equal((line.err as { code?: string }).code, "fixture_handler_failed");
        // The lines obey the log schema; err.stack is left out, since the email shape of checkLogLines
        // matches pnpm's `name@version` folder names in a stack trace (an Open question of the task).
        const withoutStacks = logs.lines().map(({ err, ...line }) => {
          const { stack: _stack, ...rest } = err as { stack?: string };
          return JSON.stringify({ ...line, err: rest });
        });
        assert.deepEqual(checkLogLines(withoutStacks), []);

        clock += 24 * 60 * 60_000;
        assert.deepEqual(await deliver(), NONE, "a dead row is never claimed again");
        assert.equal(failures, 3);
        await assert.rejects(
          replayDeadLetter(store, { workspaceId: WSP_A, id }, now()),
          failsWith("outbox_entry_not_found"),
        );
        failing = false;
        await replayDeadLetter(store, { workspaceId: WSP_B, id }, now());
        const replayed = await rowOf(WSP_B, id);
        assert.equal(replayed.deadAt, null);
        assert.equal(replayed.attempts, 0);
        assert.equal(replayed.nextAttemptAt.getTime(), clock);
        assert.deepEqual(await deliver(), { ...NONE, claimed: 1, delivered: 1 });
        const done = await rowOf(WSP_B, id);
        assert.ok(done.deliveredAt instanceof Date);
        assert.equal(done.attempts, 1);
        await assert.rejects(
          replayDeadLetter(store, { workspaceId: WSP_B, id }, now()),
          failsWith("outbox_entry_not_found"),
        );
      },
    );

    await t.test(
      "two deliverers at once: the second takes the other rows and never the one the first holds",
      async () => {
        const ids: string[] = [];
        for (let batch = 0; batch < 4; batch++) {
          await app.$transaction(async (tx) => {
            const writer = outboxWriter(tx, batch % 2 ? WSP_A : WSP_B);
            for (let i = 0; i < 5; i++) {
              ids.push(await publish(writer, events["outbox_test.counted"], { n: batch * 5 + i }));
            }
          });
        }
        let release = () => {};
        let reached = (_id: string) => {};
        const arrived = new Promise<string>((resolve) => {
          reached = resolve;
        });
        hold = {
          armed: true,
          reached,
          released: new Promise<void>((resolve) => {
            release = resolve;
          }),
        };
        const first = deliver(1);
        const heldId = await arrived;
        assert.equal(heldId, ids[0], "the first deliverer holds the oldest row");
        let delivered = 0;
        for (;;) {
          const report = await deliver(3);
          delivered += report.delivered;
          if (report.claimed === 0) break;
        }
        assert.equal(delivered, 19, "the second deliverer took every other row");
        assert.equal(counted.length, 19);
        assert.ok(!counted.includes(heldId), "and never the held one");
        assert.equal(
          (await pending(WSP_A)) + (await pending(WSP_B)),
          1,
          "the held row is still pending",
        );
        release();
        assert.deepEqual(await first, { ...NONE, claimed: 1, delivered: 1 });
        assert.deepEqual([...counted].sort(), [...ids].sort(), "every row's handler ran once");
        assert.equal((await pending(WSP_A)) + (await pending(WSP_B)), 0);
      },
    );
  } finally {
    await app.$disconnect();
    await db.drop();
  }
});
