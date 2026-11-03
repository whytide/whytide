// The end-to-end test of alpha-p1-055, cost events (docs/rules/coding.md §11): recordCost used the way
// the model-call wrapper (alpha-p1-140) will use it, with the Prisma store on the `app` connection,
// against a database of this file's own migrated with the real migrations (scratch-database.ts).
// Run with `pnpm -F db test`.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type CostEventInput, isAppError, type PriceTable, recordCost } from "@whytide/platform";
import { costStore, createDbClient, type PrismaClient } from "../index.ts";
import { type ScratchDatabase, scratchDatabase } from "./scratch-database.ts";

const prices: PriceTable = {
  version: "2026-10-21",
  prices: {
    "example-llm": { "example-model": { input_tokens: 0.000003, output_tokens: 0.000015 } },
    "example-pages": { "*": { pages: 0.002 } },
  },
};
const row: CostEventInput = {
  workspace_id: "wsp_a",
  feature: "qualification",
  task: "qualify_lead",
  vendor: "example-llm",
  model: "example-model",
  units: { input_tokens: 1000, output_tokens: 200 },
  credits: 2,
  subject_ref: "per_1",
};

let db: ScratchDatabase;
let app: PrismaClient;
before(async () => {
  db = await scratchDatabase("cost");
  app = createDbClient("app", { url: db.url("app") });
});
after(async () => {
  await app.$disconnect();
  await db.drop();
});

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (error: unknown) => isAppError(error) && error.code === code,
    `expected AppError ${code}`,
  );

test("recordCost rejects a row without workspace_id, feature, vendor or units; nothing is written", async () => {
  const store = costStore(app);
  for (const field of ["workspace_id", "feature", "vendor", "units"]) {
    const without = Object.fromEntries(Object.entries(row).filter(([name]) => name !== field));
    await rejects(recordCost(store, without as CostEventInput, { prices }), "invalid_cost_event");
  }
  await rejects(recordCost(store, { ...row, units: {} }, { prices }), "invalid_cost_event");
  await rejects(
    recordCost(store, { ...row, units: { pages: -1 } }, { prices }),
    "invalid_cost_event",
  );
  await rejects(recordCost(store, { ...row, workspace_id: "" }, { prices }), "invalid_cost_event");
  assert.equal(await app.costEvent.count(), 0);
});

test("recordCost fills unit_cost and price_list_version from the price table and writes the row", async () => {
  const written = await app.$transaction((tx) => recordCost(costStore(tx), row, { prices }));
  assert.match(written.id, /^cost_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(written.unit_cost, "0.006");
  assert.equal(written.price_list_version, "2026-10-21");
  const stored = await app.costEvent.findUniqueOrThrow({ where: { id: written.id } });
  assert.equal(stored.workspaceId, "wsp_a");
  assert.equal(stored.feature, "qualification");
  assert.equal(stored.task, "qualify_lead");
  assert.equal(stored.vendor, "example-llm");
  assert.equal(stored.model, "example-model");
  assert.deepEqual(stored.units, { input_tokens: 1000, output_tokens: 200 });
  assert.equal(stored.unitCost.toString(), "0.006");
  assert.equal(stored.credits?.toString(), "2");
  assert.equal(stored.priceListVersion, "2026-10-21");
  assert.equal(stored.subjectRef, "per_1");
  assert.equal(stored.createdAt.getTime(), written.created_at.getTime());
});

test("a call without a model is priced under the vendor's * entry; an unpriced call is refused", async () => {
  const pages = await recordCost(
    costStore(app),
    { workspace_id: "wsp_a", feature: "signals", vendor: "example-pages", units: { pages: 3 } },
    { prices },
  );
  assert.equal(pages.unit_cost, "0.006");
  assert.equal(pages.model, null);
  assert.equal(pages.task, null);
  assert.equal(pages.credits, null);
  const before = await app.costEvent.count();
  await rejects(
    recordCost(costStore(app), { ...row, vendor: "nobody" }, { prices }),
    "cost_price_missing",
  );
  await rejects(
    recordCost(costStore(app), { ...row, model: "other" }, { prices }),
    "cost_price_missing",
  );
  await rejects(
    recordCost(costStore(app), { ...row, units: { images: 1 } }, { prices }),
    "cost_price_missing",
  );
  assert.equal(await app.costEvent.count(), before);
});

test("a cost event written in a transaction that rolls back is not kept", async () => {
  const before = await app.costEvent.count();
  await assert.rejects(
    app.$transaction(async (tx) => {
      await recordCost(costStore(tx), row, { prices });
      throw new Error("rolled back");
    }),
    /rolled back/,
  );
  assert.equal(await app.costEvent.count(), before);
});
