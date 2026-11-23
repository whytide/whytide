// The company pages' share of an account's daily reads (README.md "Read quota"; gamma-en-060):
// LINKEDIN_COMPANY_READS_PER_DAY reads of kind `read_company` at most in a quota day, inside the
// day's reads, never beside them. What is used is the day's `read_company` reservations, from the
// action log's `reserved` rows since the quota day began in its zone: a reservation released
// without a call still counts, the safe side, as enrichment's allowances count a failed call.
// reserveReads reads it under the day's lock, so two reservations at once cannot both pass.
import { tenantClient } from "@whytide/db";
import { instantAt } from "@whytide/platform";
import { linkedinConfig } from "../../config.ts";
import { QUOTA_DAY_START } from "../quota/constants.ts";
import type { Day } from "../quota/days.ts";

let share: number | undefined;

/** For tests (testing/): the share in place of LINKEDIN_COMPANY_READS_PER_DAY; undefined restores it. */
export function useCompanyReadShare(next: number | undefined): void {
  share = next;
}

/** The company reads the account may still reserve in the quota day of `day`. */
export async function companyReadsLeft(accountId: string, day: Day): Promise<number> {
  const since = instantAt(day.quotaDay, QUOTA_DAY_START, day.timeZone);
  const used = await tenantClient.senderActionLog.aggregate({
    _sum: { count: true },
    where: {
      senderAccountId: accountId,
      kind: "read_company",
      outcome: "reserved",
      at: { gte: since },
    },
  });
  const limit = share ?? linkedinConfig.LINKEDIN_COMPANY_READS_PER_DAY;
  return Math.max(limit - (used._sum.count ?? 0), 0);
}
