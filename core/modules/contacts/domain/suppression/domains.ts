// The never-contact list read by company domains (README.md "Public interface"; gamma-wr-046): which
// of a list of domains the workspace never contacts, for a caller that has a company and no person yet,
// as a research run's candidates, which suppressionOf (a person's check) cannot ask. A domain is held
// by an entry on it or on one of its parents (matching.ts domainAndParents), as a company's is by the
// check; every channel counts, the strictest read, and a removed entry none. Inside the caller's
// tenant run, no cache.
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { hashOf } from "../hash.ts";
import { normalizeDomain } from "../linkedin-url.ts";
import { SUPPRESSION_BATCH_SIZE, type SuppressionRelationship } from "./constants.ts";
import { domainAndParents } from "./matching.ts";

/** Why a domain is held: the workspace's block, or a customer or a competitor it excluded. */
export type DomainStop = "never_contact" | SuppressionRelationship;

/** The order a domain's reason is told in when entries of two kinds hold it: the block first. */
const STOP_ORDER: readonly DomainStop[] = ["never_contact", "customer", "competitor"];

/**
 * The domains of the list that the workspace never contacts, each with its reason: a `Map` from the
 * domain as given to `never_contact` (a blocklist entry), `customer` or `competitor` (a relationship
 * entry); a domain nothing holds, or that is no domain, is absent. One read of the entries whatever
 * the number of domains, SUPPRESSION_BATCH_SIZE at most (`contacts_input_invalid` naming `domains`).
 */
export async function suppressedDomains(
  domains: readonly string[],
): Promise<Map<string, DomainStop>> {
  if (!Array.isArray(domains) || domains.length > SUPPRESSION_BATCH_SIZE) {
    throw new AppError(errors.contacts_input_invalid, { details: { fields: ["domains"] } });
  }
  const hashesOf = new Map<string, string[]>();
  for (const given of domains) {
    const domain = typeof given === "string" ? normalizeDomain(given) : null;
    if (domain !== null)
      hashesOf.set(
        given,
        domainAndParents(domain).map((d) => hashOf("domain", d)),
      );
  }
  const hashes = [...new Set([...hashesOf.values()].flat())];
  if (hashes.length === 0) return new Map();
  const entries = await tenantClient.suppressionEntry.findMany({
    where: { hash: { in: hashes }, removedAt: null, matchType: "domain" },
    select: { hash: true, layer: true, relationship: true },
  });
  const stopOf = new Map<string, DomainStop[]>();
  for (const { hash, layer, relationship } of entries) {
    const stop: DomainStop | null =
      relationship ?? (layer === "blocklist" ? "never_contact" : null);
    if (stop !== null) stopOf.set(hash, [...(stopOf.get(hash) ?? []), stop]);
  }
  const answer = new Map<string, DomainStop>();
  for (const [given, own] of hashesOf) {
    const held = own.flatMap((hash) => stopOf.get(hash) ?? []);
    const first = STOP_ORDER.find((stop) => held.includes(stop));
    if (first !== undefined) answer.set(given, first);
  }
  return answer;
}
