// Enrichment's hold (README.md "Enrichment's hold", gamma-en-040), inside the caller's tenant run like
// every command of contacts (persons.ts): a new lead waits CONTACTS_ENRICHMENT_HOLD_MINUTES before
// qualification's batch selects it for its first judgement, so that enrichment can fill its company
// and its country first. Enrichment reads the held leads and releases each once it is done; a lead
// nobody releases is judged once its hold ends. The hold belongs to contacts, not to enrichment: with
// enrichment absent or off, a lead waits the setting at most. 0 is no hold.
import { Prisma, tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";
import { holdSettings } from "../settings.ts";
import { MINUTE_MS } from "./constants.ts";
import { heldInput, parseInput, releaseInput } from "./rules.ts";

let fixed: number | undefined;

/** The hold's minutes in place of the setting's, for tests; undefined goes back to the setting. */
export function useHoldMinutes(minutes: number | undefined): void {
  fixed = minutes;
}

/** When a lead created at `now` stops waiting; null when the setting is 0, no hold. */
export function holdUntil(now: Date): Date | null {
  const minutes = fixed ?? holdSettings.CONTACTS_ENRICHMENT_HOLD_MINUTES;
  return minutes === 0 ? null : new Date(now.getTime() + minutes * MINUTE_MS);
}

/** As SQL on leads: the lead is not held past `now`, so qualification's selection may take it. */
export function notHeld(now: Date): Prisma.Sql {
  return Prisma.sql`(enrichment_hold_until IS NULL OR enrichment_hold_until <= ${now})`;
}

/**
 * The person ids of the run's workspace's leads held past now, oldest first, at most `limit` (1 to
 * HELD_LEADS_MAX): what enrichment reads. contacts_input_invalid for a limit off the rule.
 */
export async function leadsHeldForEnrichment(input: { limit: number }): Promise<string[]> {
  const { limit } = parseInput(heldInput, input);
  const rows = await tenantClient.lead.findMany({
    where: { enrichmentHoldUntil: { gt: new Date() } },
    select: { personId: true },
    orderBy: [{ createdAt: "asc" }, { personId: "asc" }],
    take: limit,
  });
  return rows.map(({ personId }) => personId);
}

/**
 * Ends the hold of the run's workspace's leads `personIds` (HELD_LEADS_MAX at most), so that the batch
 * may select them at once: the number of leads it released. A lead without a hold, another
 * workspace's or an unknown one is left as it is, so a second release is a no-op. Raw, so that
 * updated_at, the time of qualification the list shows, stays. contacts_input_invalid for a list off
 * the rule.
 */
export async function releaseEnrichmentHold(personIds: readonly string[]): Promise<number> {
  const ids = parseInput(releaseInput, personIds);
  if (ids.length === 0) return 0;
  const { workspaceId } = currentTenant();
  return tenantClient.$executeRaw`
    UPDATE leads SET enrichment_hold_until = NULL
    WHERE workspace_id = ${workspaceId} AND person_id = ANY(${ids}::text[])
      AND enrichment_hold_until IS NOT NULL`;
}
