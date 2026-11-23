// The person's erasure (core/modules/privacy README "Erasers"), in the caller's tenant run: their
// runs, contact points, lookups and cache entries deleted. source_usage, email_domain_statuses and
// email_domain_patterns hold no person's data and stay.
import { tenantClient } from "@whytide/db";
import { idOf } from "./readers.ts";

/** Deletes the person's rows; enrichment_input_invalid for no id. The rows deleted, by table. */
export async function erasePerson(personId: string): Promise<{
  enrichment_runs: number;
  contact_points: number;
  enrichment_requests: number;
  enrichment_cache_entries: number;
}> {
  const where = { personId: idOf("personId", personId) };
  const runs = await tenantClient.enrichmentRun.deleteMany({ where });
  const points = await tenantClient.contactPoint.deleteMany({ where });
  const requests = await tenantClient.enrichmentRequest.deleteMany({ where });
  const entries = await tenantClient.enrichmentCacheEntry.deleteMany({ where });
  return {
    enrichment_runs: runs.count,
    contact_points: points.count,
    enrichment_requests: requests.count,
    enrichment_cache_entries: entries.count,
  };
}
