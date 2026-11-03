// `pnpm credits:seed` (README "The seeder"): what the api runs at its start, by hand: the fixed plan
// from CREDITS_MONTHLY_ALLOWANCE and CREDITS_PLAN_CODE, then the current period of every organization,
// as billing_writer (DATABASE_URL_BILLING_WRITER). It loads no other module, so it writes no price:
// the api does at its start. Exits 1 when it fails.
import { createLogger } from "@whytide/platform";
import { onStart } from "../domain/seed.ts";

const log = createLogger();
try {
  await onStart({ log });
} catch (error) {
  log.fatal({ err: error }, "credits: the seeder failed");
  process.exitCode = 1;
}
