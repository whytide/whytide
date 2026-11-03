// The suppression write (docs/flows.md "The leads an entry blocks"): an entry added sets
// `suppressed` on every lead it affects, through recordLeadStatus, in the entry's own transaction. A
// person's entry affects the lead of the person with that profile; a company's, the leads of the
// persons whose company it matches by the hashes the check reads (matching.ts companyHashes), so
// that a domain entry holds for its subdomains as the check does.
import { tenantClient } from "@whytide/db";
import { SUPPRESSED_REASONS } from "../outreach/constants.ts";
import type { StatusActor } from "../outreach/rules.ts";
import { recordLeadStatus } from "../outreach/status.ts";
import type { SuppressionKind, SuppressionLayer } from "./constants.ts";
import { companyHashes, type EntryTarget } from "./matching.ts";

/**
 * Sets `suppressed` on each lead the entry affects that is not already, in person-id order so that
 * two writes at once lock their leads in the same order; the reason is the check's for the entry,
 * the actor the user who added it, or the system. Answers how many leads it moved.
 */
export async function suppressAffectedLeads(input: {
  kind: SuppressionKind;
  layer: SuppressionLayer;
  target: EntryTarget;
  createdBy: string | null;
}): Promise<number> {
  const { kind, layer, target, createdBy } = input;
  const personIds = kind === "person" ? await personsOf(target) : await employeesOf(target);
  if (personIds.length === 0) return 0;
  const leads = await tenantClient.lead.findMany({
    where: { personId: { in: personIds }, outreachStatus: { not: "suppressed" } },
    select: { personId: true },
    orderBy: { personId: "asc" },
  });
  const reason = layer === "opt_out" ? SUPPRESSED_REASONS.optOut : SUPPRESSED_REASONS[kind];
  const actor: StatusActor =
    createdBy === null ? { type: "system" } : { type: "user", id: createdBy };
  for (const { personId } of leads) {
    await recordLeadStatus(personId, "suppressed", { reason, actor });
  }
  return leads.length;
}

/** The person with the entry's profile, if the workspace has one. */
async function personsOf(target: EntryTarget): Promise<string[]> {
  if (target.linkedinUrl === null) return [];
  const persons = await tenantClient.person.findMany({
    where: { linkedinUrl: target.linkedinUrl },
    select: { id: true },
  });
  return persons.map(({ id }) => id);
}

/**
 * The persons whose company the entry matches: the companies with the domain or a subdomain of it,
 * or with the page, kept when one of their hashes is the entry's.
 */
async function employeesOf(target: EntryTarget): Promise<string[]> {
  const where =
    target.matchType === "domain"
      ? { OR: [{ domain: target.domain }, { domain: { endsWith: `.${target.domain}` } }] }
      : { linkedinUrl: target.linkedinUrl };
  const candidates = await tenantClient.workspaceCompany.findMany({
    where,
    select: { id: true, domain: true, linkedinUrl: true },
  });
  const companyIds = candidates
    .filter((company) => companyHashes(company).includes(target.hash))
    .map(({ id }) => id);
  if (companyIds.length === 0) return [];
  const persons = await tenantClient.person.findMany({
    where: { companyId: { in: companyIds } },
    select: { id: true },
  });
  return persons.map(({ id }) => id);
}
