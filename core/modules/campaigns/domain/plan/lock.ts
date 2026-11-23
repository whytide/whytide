// A sender's plan lock (gamma-p6-040; README.md "Worker"): a transaction-scoped advisory lock keyed
// by the run's workspace and the sender (constants.ts PLAN_LOCK), tried, never waited for, in the
// caller's tenant run. Postgres frees it at the run's commit or rollback, so a plan attempt past
// PLAN_TIMEOUT that Temporal has given up on holds it until its own run ends, and the next attempt
// on the same sender skips it meanwhile rather than placing its steps a second time.
import { tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";
import { PLAN_LOCK } from "./constants.ts";

/** Whether this run now holds the sender's plan lock: false while another run holds it. */
export async function lockPlan(senderId: string): Promise<boolean> {
  const key = `${PLAN_LOCK}:${currentTenant().workspaceId}:${senderId}`;
  const [row] = await tenantClient.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`;
  return row?.locked === true;
}
