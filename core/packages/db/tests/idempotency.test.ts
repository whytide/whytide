// The end-to-end test of alpha-p1-055, idempotency records (docs/rules/coding.md §11): withIdempotency
// used the way the request decorator (alpha-p2-030) will use it, inside `app` transactions with the
// Prisma store, against a database of this file's own (scratch-database.ts). Run with `pnpm -F db test`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import {
  IDEMPOTENCY_TTL_MS,
  type IdempotentRequest,
  type IdempotentResponse,
  isAppError,
  withIdempotency,
} from "@whytide/platform";
import { createDbClient, idempotencyStore, type PrismaClient } from "../index.ts";
import { type ScratchDatabase, scratchDatabase } from "./scratch-database.ts";

const hash = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
const importLeads: IdempotentRequest = {
  workspaceId: "wsp_a",
  key: "7d5e1c0a-import-1",
  requestHash: hash({ file: "leads.csv" }),
};
const otherBody = hash({ file: "other.csv" });

let db: ScratchDatabase;
let app: PrismaClient;
before(async () => {
  db = await scratchDatabase("idem");
  app = createDbClient("app", { url: db.url("app") });
});
after(async () => {
  await app.$disconnect();
  await db.drop();
});

/** One request, the way the api runs it: inside its own transaction on the `app` connection. */
const once = (request: IdempotentRequest, fn: () => Promise<IdempotentResponse>) =>
  app.$transaction((tx) => withIdempotency(idempotencyStore(tx), request, fn));
const rejects = (promise: Promise<unknown>, code: string, status: number) =>
  assert.rejects(
    promise,
    (error: unknown) => isAppError(error) && error.code === code && error.status === status,
    `expected AppError ${code} (${status})`,
  );
const stored = (workspaceId: string, key: string) =>
  app.idempotencyRecord.findMany({ where: { workspaceId, key } });

test("a repeated key with the same hash gets the first response, and fn runs once", async () => {
  let runs = 0;
  const fn = async () => ({ status: 201, body: { import_id: `imp_${++runs}` } });
  assert.deepEqual(await once(importLeads, fn), {
    status: 201,
    body: { import_id: "imp_1" },
    replayed: false,
  });
  assert.deepEqual(await once(importLeads, fn), {
    status: 201,
    body: { import_id: "imp_1" },
    replayed: true,
  });
  assert.equal(runs, 1);
  const [record, ...more] = await stored("wsp_a", importLeads.key);
  assert.ok(record && more.length === 0, "one record per key and workspace");
  assert.match(record.id, /^idem_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(record.requestHash, importLeads.requestHash);
  assert.equal(record.responseStatus, 201);
  assert.equal(record.expiresAt.getTime() - record.createdAt.getTime(), IDEMPOTENCY_TTL_MS);
});

test("the same key with another body is idempotency_key_reused, 422, and fn does not run", async () => {
  let runs = 0;
  const fn = async () => ({ status: 201, body: { import_id: `imp_${++runs}` } });
  await rejects(
    once({ ...importLeads, requestHash: otherBody }, fn),
    "idempotency_key_reused",
    422,
  );
  assert.equal(runs, 0);
});

test("the same key in another workspace is a new request: nothing crosses workspaces", async () => {
  const result = await once({ ...importLeads, workspaceId: "wsp_b" }, async () => ({
    status: 200,
    body: [1, 2],
  }));
  assert.deepEqual(result, { status: 200, body: [1, 2], replayed: false });
  assert.equal((await stored("wsp_b", importLeads.key)).length, 1);
  assert.equal((await stored("wsp_a", importLeads.key)).length, 1);
});

test("after 24 hours the key is forgotten: the record is swept and the request runs again", async () => {
  await app.idempotencyRecord.updateMany({
    where: { workspaceId: "wsp_a", key: importLeads.key },
    data: {
      createdAt: new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1000),
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  const fresh = await once({ ...importLeads, requestHash: otherBody }, async () => ({
    status: 201,
    body: { import_id: "imp_9" },
  }));
  assert.deepEqual(fresh, { status: 201, body: { import_id: "imp_9" }, replayed: false });
  const records = await stored("wsp_a", importLeads.key);
  assert.equal(records.length, 1, "the expired record is gone");
  assert.equal(records[0]?.requestHash, otherBody);
  assert.equal(
    (await stored("wsp_b", importLeads.key)).length,
    1,
    "the sweep stays in its workspace",
  );
});

test("a key is validated, fn that throws stores nothing, and a null body is kept as JSON null", async () => {
  const fn = async () => ({ status: 204, body: null });
  await rejects(once({ ...importLeads, key: "" }, fn), "invalid_idempotency_key", 400);
  await rejects(once({ ...importLeads, key: "k".repeat(256) }, fn), "invalid_idempotency_key", 400);
  await rejects(once({ ...importLeads, requestHash: "" }, fn), "invalid_idempotency_key", 400);
  const failing = { ...importLeads, key: "k-fails" };
  await assert.rejects(
    once(failing, async () => {
      throw new Error("provider down");
    }),
    /provider down/,
  );
  assert.equal((await stored("wsp_a", "k-fails")).length, 0);
  assert.deepEqual(await once(failing, fn), { status: 204, body: null, replayed: false });
  assert.deepEqual(await once(failing, fn), { status: 204, body: null, replayed: true });
});

test("two requests with one key at once: the first to store wins, the other is idempotency_key_conflict", async () => {
  const race = { ...importLeads, key: "k-race" };
  let reached!: () => void;
  let release!: () => void;
  const reachedFn = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const other = createDbClient("app", { url: db.url("app") });
  try {
    const slow = other.$transaction((tx) =>
      withIdempotency(idempotencyStore(tx), race, async () => {
        reached();
        await released;
        return { status: 201, body: "slow" };
      }),
    );
    await reachedFn;
    const fast = await once(race, async () => ({ status: 201, body: "fast" }));
    release();
    await rejects(slow, "idempotency_key_conflict", 409);
    assert.deepEqual(fast, { status: 201, body: "fast", replayed: false });
    assert.deepEqual(await once(race, async () => ({ status: 500, body: "never" })), {
      status: 201,
      body: "fast",
      replayed: true,
    });
  } finally {
    await other.$disconnect();
  }
});
