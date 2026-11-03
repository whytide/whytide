// reserve, commit and release end to end (alpha-p3-060), in this file's schema of the worktree's
// database, each call in a tenant run as `app`: the balance they move, a reservation above the
// available balance, a repeated key, another workspace than the run's, ten reserves in parallel on
// ten connections, a run that commits then reserves beside another reserve, and the leases on a
// clock the test moves, swept by a reserve of another workspace of the organization; each outcome
// counted in credits.usage.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createDbClient, type PrismaClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  type CreditsClient,
  type CreditsLease,
  collectLogs,
  createLogger,
  newId,
  recordedMetrics,
  servicePrincipal,
} from "@whytide/platform";
import { ids as tenancyIds } from "@whytide/tenancy";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { createCreditsClient } from "../domain/client.ts";
import { LEASE_MS, leaseExpiresAt } from "../domain/lease.ts";
import { syncPrices } from "../domain/prices.ts";
import { grantAllowance } from "../testing/index.ts";

const db = withTestDb();
useTenancyClient(asRole("app"));
const principal = servicePrincipal("credits_test");
const log = createLogger({ destination: collectLogs().destination });

/** A workspace of an organization granted 100 credits, `test.read` at 2 credits a lead. */
async function wallet() {
  const [a] = await createTwoWorkspaces();
  await grantAllowance([a.organization.id], 100);
  const price = { action: "test.read", credits: "2", unit: "lead" };
  await syncPrices(asRole("billing_writer"), [price], log);
  return a.workspace;
}

const inRun = <T>(
  workspaceId: string,
  fn: () => Promise<T>,
  client: PrismaClient = asRole("app"),
) => withTenant({ workspaceId, principal }, fn, { client });
const reserve = (
  credits: CreditsClient,
  workspaceId: string,
  idempotencyKey: string,
  quantity: number,
  lease: CreditsLease = "sync",
) => {
  const input = { workspaceId, action: "test.read", quantity, idempotencyKey, lease };
  return () => credits.reserve({ ...input, subjectRef: "lead_test" });
};
const numbers = async (credits: CreditsClient, workspaceId: string) => {
  const { available, reserved, committed } = await inRun(workspaceId, () =>
    credits.balance(workspaceId),
  );
  return { available, reserved, committed };
};

test("reserve, commit and release move the balance; above the available balance, insufficient_credits and no row; a repeated key returns the first usage", async () => {
  const { id } = await wallet();
  const credits = createCreditsClient();
  const first = await inRun(id, reserve(credits, id, "first", 10));
  assert.equal(first.credits, "20");
  assert.deepEqual(await inRun(id, reserve(credits, id, "first", 10)), first);
  const second = await inRun(id, reserve(credits, id, "second", 15));
  assert.deepEqual(await numbers(credits, id), { available: "50", reserved: "50", committed: "0" });

  const committed = { usageId: first.usageId, credits: "5" };
  assert.deepEqual(await inRun(id, () => credits.commit(first.usageId, 2.5)), committed);
  assert.deepEqual(await inRun(id, () => credits.commit(first.usageId)), committed);
  await inRun(id, () => credits.release(second.usageId));
  await inRun(id, () => credits.release(second.usageId));
  assert.deepEqual(await numbers(credits, id), { available: "95", reserved: "0", committed: "5" });
  const notOpen = { code: "usage_not_open", status: 409 };
  await assert.rejects(
    inRun(id, () => credits.release(first.usageId)),
    notOpen,
  );
  await assert.rejects(
    inRun(id, () => credits.commit(second.usageId)),
    notOpen,
  );
  await assert.rejects(
    inRun(id, () => credits.commit("usage_unknown")),
    notOpen,
  );

  const rows = await asRole("app").creditUsage.count();
  const refused = { code: "insufficient_credits", status: 402 };
  await assert.rejects(inRun(id, reserve(credits, id, "third", 48)), refused);
  assert.equal(await asRole("app").creditUsage.count(), rows);
  const outcomes = (recordedMetrics().get("credits.usage") ?? []).map((set) => set.outcome);
  for (const outcome of ["reserved", "committed", "released", "insufficient"]) {
    assert.ok(outcomes.includes(outcome), outcome);
  }
});

test("reserve and balance refuse a workspace other than the run's: tenant_mismatch", async () => {
  const { id } = await wallet();
  const credits = createCreditsClient();
  const mismatch = { code: "tenant_mismatch" };
  await assert.rejects(inRun(id, reserve(credits, "wsp_other", "other", 1)), mismatch);
  await assert.rejects(
    inRun(id, () => credits.balance("wsp_other")),
    mismatch,
  );
});

test("ten reservations of sixty percent of the balance each, in parallel on ten connections: exactly one succeeds", async () => {
  const { id } = await wallet();
  const credits = createCreditsClient();
  const clients = Array.from({ length: 10 }, () => createDbClient("app", { schema: db.schema }));
  try {
    const calls = clients.map((client, n) => inRun(id, reserve(credits, id, `p${n}`, 30), client));
    const results = await Promise.allSettled(calls);
    const codes = results.map((r) => (r.status === "fulfilled" ? "ok" : r.reason.code));
    assert.deepEqual(codes.sort(), ["ok", ...Array(9).fill("insufficient_credits")].sort());
    assert.equal(await asRole("app").creditUsage.count(), 1);
    assert.deepEqual(await numbers(credits, id), {
      available: "40",
      reserved: "60",
      committed: "0",
    });
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
});

test("a run that commits then reserves, beside a reserve of its organization on another connection: both succeed", async () => {
  const { id } = await wallet();
  const credits = createCreditsClient();
  const first = await inRun(id, reserve(credits, id, "first", 1));
  const clients = [1, 2].map(() => createDbClient("app", { schema: db.schema }));
  const [one, two] = clients as [PrismaClient, PrismaClient];
  try {
    let committed = () => {};
    const settled = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const settling = inRun(
      id,
      async () => {
        await credits.commit(first.usageId);
        committed();
        await sleep(300);
        return reserve(credits, id, "after", 1)();
      },
      one,
    );
    await settled;
    await Promise.all([settling, inRun(id, reserve(credits, id, "beside", 1), two)]);
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
});

test("a sync reservation is expired and freed by the next reserve of its organization after 15 minutes, an async one after 24 hours; commit on an expired one is usage_not_open", async () => {
  const workspace = await wallet();
  const sibling = newId(tenancyIds.workspace);
  const { organizationId } = workspace;
  await asRole("app").workspace.create({
    data: {
      id: sibling,
      organizationId,
      name: "Sibling",
      slug: `s${sibling.slice(-12).toLowerCase()}`,
    },
  });
  const start = Date.parse("2026-10-22T09:00:00Z");
  let at = start;
  const credits = createCreditsClient(() => new Date(at));
  const sync = await inRun(workspace.id, reserve(credits, workspace.id, "sync", 20));
  const later = await inRun(workspace.id, reserve(credits, workspace.id, "async", 20, "async"));
  const status = async (usageId: string) =>
    (await asRole("app").creditUsage.findUniqueOrThrow({ where: { id: usageId } })).status;
  const sweep = (key: string) => inRun(sibling, reserve(credits, sibling, key, 1));

  at = start + LEASE_MS.sync - 1_000;
  await sweep("before");
  assert.equal(await status(sync.usageId), "reserved");
  at = start + LEASE_MS.sync;
  await sweep("sync-over");
  assert.deepEqual(
    [await status(sync.usageId), await status(later.usageId)],
    ["expired", "reserved"],
  );
  assert.deepEqual(await numbers(credits, sibling), {
    available: "56",
    reserved: "44",
    committed: "0",
  });
  const notOpen = { code: "usage_not_open" };
  await assert.rejects(
    inRun(workspace.id, () => credits.commit(sync.usageId)),
    notOpen,
  );

  at = start + LEASE_MS.async;
  await sweep("async-over");
  assert.equal(await status(later.usageId), "expired");
  const swept = recordedMetrics().get("credits.usage") ?? [];
  assert.ok(swept.some((set) => set.outcome === "expired"));
  assert.deepEqual(await numbers(credits, sibling), {
    available: "98",
    reserved: "2",
    committed: "0",
  });
});

test("the lease rule: a sync reservation holds 15 minutes, an async one 24 hours", () => {
  const at = new Date("2026-10-22T09:00:00Z");
  assert.equal(leaseExpiresAt("sync", at).toISOString(), "2026-10-22T09:15:00.000Z");
  assert.equal(leaseExpiresAt("async", at).toISOString(), "2026-10-23T09:00:00.000Z");
});
