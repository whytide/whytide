// The Hot alert's claim (README "The Hot alert"): hot_alerted_at, set in the delivery's run of
// qualification.lead_hot while it is null and the lead is still Hot, before the mail's workflow
// starts. A retried delivery, or a second event while the lead stays Hot, finds it and starts none;
// an intent write that takes the lead out of Hot clears it (intent/store.ts).
import { tenantClient } from "@whytide/db";
import { HOT_TIER } from "../intent/constants.ts";

/** In the caller's tenant run: true when this run claimed the person's alert, now. */
export async function claimHotAlert(personId: string, now: Date): Promise<boolean> {
  const { count } = await tenantClient.intentScore.updateMany({
    where: { personId, tier: HOT_TIER, hotAlertedAt: null },
    data: { hotAlertedAt: now },
  });
  return count > 0;
}
