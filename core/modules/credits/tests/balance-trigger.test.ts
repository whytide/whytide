// The balance triggers' property (alpha-p3-050, architecture §10): after one thousand random grants,
// grant changes, reservations, commits, releases and expiries over three organizations, ten at a time,
// credit_balances equals the sums over credit_grants and credit_usage. Grants are written as
// billing_writer and usage rows as app, the roles that write them; the seed is fixed, so a failure
// repeats.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, synthetic } from "@whytide/platform";
import { ids } from "../ids.ts";

withTestDb();
const ORGANIZATIONS = ["org_trigger_a", "org_trigger_b", "org_trigger_c"];
const OPERATIONS = 1000;
const AT_ONCE = 10;

test("credit_balances equals the sums over the rows after 1000 random operations", async () => {
  const billing = asRole("billing_writer");
  const app = asRole("app");
  const random = synthetic("credits-balance-trigger");
  /** Quarters of a credit, exact in binary and in numeric: 0.25 to 100. */
  const credits = (most = 100) => (1 + random.int(most * 4)) / 4;
  const pickOut = <T>(list: T[]): T => list.splice(random.int(list.length), 1)[0] as T;
  const plan = { id: newId(ids.plan), code: "trigger_test", name: "trigger_test" };
  await billing.plan.create({ data: { ...plan, monthlyAllowance: 0 } });
  const subscriptionOf = new Map<string, string>();
  for (const organizationId of ORGANIZATIONS) {
    const id = newId(ids.subscription);
    const period = { periodStart: new Date(), periodEnd: new Date() };
    await billing.subscription.create({ data: { id, organizationId, planId: plan.id, ...period } });
    subscriptionOf.set(organizationId, id);
  }
  const grants: string[] = [];
  const open: { id: string; credits: number }[] = [];
  let step = 0;

  /** One operation; what it adds is listed after its batch, in call order, so a run repeats. */
  const operation = async (): Promise<{ grant?: string; reservation?: (typeof open)[number] }> => {
    const organizationId = random.pick(ORGANIZATIONS);
    const roll = random.int(100);
    step += 1;
    if (roll < 15) {
      const id = newId(ids.credit_grant);
      const subscriptionId = subscriptionOf.get(organizationId) ?? "";
      const at = new Date(Date.UTC(2026, 0, 1) + step);
      await billing.$executeRaw`
        INSERT INTO credit_grants
          (id, organization_id, subscription_id, amount, reason, period_start, period_end)
        VALUES (${id}, ${organizationId}, ${subscriptionId}, ${credits(1000)}, 'test', ${at}, ${at})`;
      return { grant: id };
    }
    if (roll < 20 && grants.length > 0) {
      const id = random.pick(grants);
      await billing.$executeRaw`UPDATE credit_grants SET amount = ${credits(1000)} WHERE id = ${id}`;
      return {};
    }
    if (roll < 60 || open.length === 0) {
      const id = newId(ids.credit_usage);
      const workspaceId = `wsp_of_${organizationId}`;
      const reserved = credits();
      await app.$executeRaw`
        INSERT INTO credit_usage (id, organization_id, workspace_id, action, quantity, credits,
          idempotency_key, lease_expires_at, subject_ref)
        VALUES (${id}, ${organizationId}, ${workspaceId}, 'test', 1, ${reserved},
          ${id}, now() + interval '1 minute', 'lead_test')`;
      return { reservation: { id, credits: reserved } };
    }
    const { id, credits: reserved } = pickOut(open);
    if (roll < 80) {
      await app.$executeRaw`
        UPDATE credit_usage SET status = 'committed', credits = ${credits(reserved)}, settled_at = now()
        WHERE id = ${id}`;
    } else {
      const status = roll < 95 ? "released" : "expired";
      await app.$executeRaw`
        UPDATE credit_usage SET status = ${status}::credit_usage_status, settled_at = now() WHERE id = ${id}`;
    }
    return {};
  };
  for (let done = 0; done < OPERATIONS; done += AT_ONCE) {
    const added = await Promise.all(Array.from({ length: AT_ONCE }, operation));
    for (const { grant, reservation } of added) {
      if (grant) grants.push(grant);
      if (reservation) open.push(reservation);
    }
  }
  assert.equal(step, OPERATIONS);

  const sums = await app.$queryRaw<unknown[]>`
    SELECT o.organization_id,
      trim_scale(COALESCE((SELECT sum(amount) FROM credit_grants g
        WHERE g.organization_id = o.organization_id), 0))::text AS granted,
      trim_scale(COALESCE((SELECT sum(credits) FROM credit_usage u
        WHERE u.organization_id = o.organization_id AND u.status = 'reserved'), 0))::text AS reserved,
      trim_scale(COALESCE((SELECT sum(credits) FROM credit_usage u
        WHERE u.organization_id = o.organization_id AND u.status = 'committed'), 0))::text AS committed
    FROM (SELECT organization_id FROM credit_grants UNION SELECT organization_id FROM credit_usage) o
    ORDER BY o.organization_id`;
  const balances = await app.$queryRaw<unknown[]>`
    SELECT organization_id, trim_scale(granted)::text AS granted,
      trim_scale(reserved)::text AS reserved, trim_scale(committed)::text AS committed
    FROM credit_balances ORDER BY organization_id`;
  assert.equal(balances.length, ORGANIZATIONS.length);
  assert.deepEqual(balances, sums);
});
