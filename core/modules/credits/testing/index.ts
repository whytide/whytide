// credits' test helpers (README "Testing"), `@whytide/credits/testing`, for tests only, on asRole of
// @whytide/db/testing, so the test file calls withTestDb() first: the fixed plan with an allowance,
// then each organization's subscription and grant for the current period, as the seeder writes them;
// useCreditsClient(asRole("app")) points the module's own `app` client at the test's schema.
import { asRole } from "@whytide/db/testing";
import { seedOrganization, seedPlan } from "../domain/seed.ts";

export { createCreditsClient } from "../domain/client.ts";
export { useClient as useCreditsClient } from "../domain/store.ts";

export async function grantAllowance(
  organizationIds: readonly string[],
  allowance: number,
): Promise<void> {
  const config = { CREDITS_MONTHLY_ALLOWANCE: allowance, CREDITS_PLAN_CODE: "self_hosted" };
  await seedPlan(asRole("billing_writer"), config);
  for (const id of organizationIds) await seedOrganization(asRole("app"), id);
}
