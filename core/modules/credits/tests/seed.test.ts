// The seeder and the first grant end to end (alpha-p3-050), in this file's schema of the worktree's
// database: the plan written from the settings as billing_writer, updated by a second run and refused
// to app; then tenancy's bootstrapOrganization and its event, delivered in process the way the worker
// host will (deliverPending on db's outbox store, each handler in a tenant run as app), and the
// organization's one subscription, one grant for the current period and balance.
import assert from "node:assert/strict";
import test from "node:test";
import { createOutboxStore, withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import {
  collectLogs,
  createLogger,
  deliverPending,
  newId,
  parseId,
  servicePrincipal,
} from "@whytide/platform";
import { bootstrapOrganization, upsertUser } from "@whytide/tenancy";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { periodFor } from "../domain/period.ts";
import { renewPeriods, seed, seedOrganization, seedPlan } from "../domain/seed.ts";
import "../events.ts";
import { ids } from "../ids.ts";

withTestDb();
useTenancyClient(asRole("app"));
const log = createLogger({ destination: collectLogs().destination });
const settings = (allowance: number) => ({
  CREDITS_MONTHLY_ALLOWANCE: allowance,
  CREDITS_PLAN_CODE: "self_hosted",
});

test("the seeder writes plan self_hosted with the allowance as billing_writer; a second run with another value updates it; app is refused", async () => {
  const billing = asRole("billing_writer");
  await seed(billing, log, settings(10_000_000));
  const [plan] = await billing.plan.findMany();
  const { code, monthlyAllowance, isFixed } = plan ?? {};
  assert.deepEqual(
    [code, monthlyAllowance?.toString(), isFixed],
    ["self_hosted", "10000000", true],
  );
  parseId(plan?.id ?? "", "plan");

  await seed(billing, log, settings(250));
  const plans = await billing.plan.findMany();
  const changed = plans.map((p) => [p.id, p.monthlyAllowance.toString(), p.isFixed]);
  assert.deepEqual(changed, [[plan?.id, "250", true]]);

  assert.equal(await sqlstate(seedPlan(asRole("app"), settings(1))), "42501");
  assert.equal((await billing.plan.findFirstOrThrow()).monthlyAllowance.toString(), "250");
});

test("after bootstrapOrganization, one subscription and one grant for the current period, the balance granted is the allowance; seeding again changes nothing", async () => {
  await seed(asRole("billing_writer"), log, settings(1_500));
  const owner = await upsertUser({ email: "owner@example.com" });
  const made = await bootstrapOrganization({
    name: "Acme",
    workspaceSlug: "acme",
    ownerUserId: owner.id,
  });
  const organizationId = made.organization.id;
  const app = asRole("app");
  const principal = servicePrincipal("worker");
  const report = await deliverPending({
    store: createOutboxStore(app),
    runInTenant: (workspaceId, fn) => withTenant({ workspaceId, principal }, fn, { client: app }),
    log,
  });
  assert.deepEqual(report, { claimed: 1, delivered: 1, retried: 0, dead: 0, deferred: 0 });

  const state = async () => ({
    subscriptions: await app.subscription.findMany(),
    grants: await app.creditGrant.findMany(),
    balances: await app.creditBalance.findMany(),
  });
  const after = await state();
  const [subscription] = after.subscriptions;
  const [grant] = after.grants;
  assert.equal(after.subscriptions.length, 1);
  assert.equal(subscription?.organizationId, organizationId);
  parseId(subscription?.id ?? "", "sub");
  assert.equal(after.grants.length, 1);
  const period = periodFor(grant?.createdAt ?? new Date(Number.NaN));
  assert.deepEqual(
    [grant?.organizationId, grant?.subscriptionId, grant?.reason, grant?.amount.toString()],
    [organizationId, subscription?.id, "allowance", "1500"],
  );
  assert.deepEqual([grant?.periodStart, grant?.periodEnd], [period.start, period.end]);
  assert.deepEqual(
    [subscription?.periodStart, subscription?.periodEnd],
    [period.start, period.end],
  );
  const balance = after.balances.map((b) => [b.organizationId, `${b.granted}`, `${b.reserved}`]);
  assert.deepEqual(balance, [[organizationId, "1500", "0"]]);

  assert.equal(await seedOrganization(app, organizationId), false);
  await seed(asRole("billing_writer"), log, settings(1_500));
  assert.deepEqual(await state(), after);
});

test("a subscription that is not active, cancelled, gets no grant from the seeder or the event", async () => {
  const billing = asRole("billing_writer");
  const plan = await seedPlan(billing, settings(1_500));
  const { start, end } = periodFor(new Date());
  const organizationId = "org_cancelled";
  await billing.subscription.create({
    data: {
      id: newId(ids.subscription),
      organizationId,
      planId: plan.id,
      status: "cancelled",
      periodStart: start,
      periodEnd: end,
    },
  });
  assert.equal(await seedOrganization(asRole("app"), organizationId), false);
  assert.equal(await renewPeriods(billing), 0);
  assert.equal(await billing.creditGrant.count(), 0);
});
