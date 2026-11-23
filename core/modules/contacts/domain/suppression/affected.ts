// The suppression write (docs/flows.md "The leads an entry blocks"): an entry added on every channel
// sets `suppressed` on every lead it affects, through recordLeadStatus, in the entry's own
// transaction. A person's entry affects the lead of the person with that profile, or who holds that
// email address (person_email_hashes, gamma-rf-040); a company's, a
// customer's or a competitor's, the leads of the persons whose company it matches by the hashes the
// check reads (matching.ts companyHashes), so that a domain entry holds for its subdomains as the
// check does. An entry on one channel moves no lead: the other channel stays open (gamma-p2-040). An
// exclusion list's chunk of domain entries (gamma-p2-045) moves its leads in one pass of three reads.
import { tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";
import { hashOf } from "../hash.ts";
import { SUPPRESSED_REASONS } from "../outreach/constants.ts";
import type { StatusActor } from "../outreach/rules.ts";
import { recordLeadStatus } from "../outreach/status.ts";
import {
  EVERY_CHANNEL,
  type SuppressionChannel,
  type SuppressionKind,
  type SuppressionLayer,
} from "./constants.ts";
import { type CompanyKeys, companyHashes, type EntryTarget } from "./matching.ts";

/**
 * Sets `suppressed` on each lead an entry on every channel affects that is not already, in person-id
 * order so that two writes at once lock their leads in the same order; the reason is the check's for
 * the entry, the actor the user who added it, or the system. Answers how many leads it moved: none
 * for an entry on one channel.
 */
export async function suppressAffectedLeads(input: {
  kind: SuppressionKind;
  layer: SuppressionLayer;
  channel: SuppressionChannel;
  target: EntryTarget;
  createdBy: string | null;
}): Promise<number> {
  const { kind, layer, channel, target, createdBy } = input;
  if (channel !== EVERY_CHANNEL) return 0;
  const personIds = kind === "person" ? await personsOf(target) : await employeesOf(target);
  const reason = layer === "opt_out" ? SUPPRESSED_REASONS.optOut : SUPPRESSED_REASONS[kind];
  const actor: StatusActor =
    createdBy === null ? { type: "system" } : { type: "user", id: createdBy };
  return suppressLeadsOf(personIds, reason, actor);
}

/**
 * suppressAffectedLeads for a chunk of company entries on every channel, an exclusion list's
 * (gamma-p2-045): the leads of the persons whose company is at one of the domains or a subdomain of
 * one, by the hashes the check reads, moved by the user who imported the list. One read of the
 * companies, one of their persons and one of their leads, whatever the chunk's size.
 */
export async function suppressLeadsAtDomains(
  domains: readonly string[],
  createdBy: string,
): Promise<number> {
  if (domains.length === 0) return 0;
  const hashes = new Set(domains.map((domain) => hashOf("domain", domain)));
  const companyIds = (await companiesAt(domains))
    .filter((company) => companyHashes(company).some((hash) => hashes.has(hash)))
    .map(({ id }) => id);
  const personIds = await employeesOfCompanies(companyIds);
  const actor: StatusActor = { type: "user", id: createdBy };
  return suppressLeadsOf(personIds, SUPPRESSED_REASONS.company, actor);
}

/**
 * Moves each lead of the persons not yet `suppressed` to it, in person-id order, so that two writes
 * at once lock their leads in the same order; answers how many it moved.
 */
async function suppressLeadsOf(
  personIds: readonly string[],
  reason: string,
  actor: StatusActor,
): Promise<number> {
  if (personIds.length === 0) return 0;
  const leads = await tenantClient.lead.findMany({
    where: { personId: { in: [...personIds] }, outreachStatus: { not: "suppressed" } },
    select: { personId: true },
    orderBy: { personId: "asc" },
  });
  for (const { personId } of leads) {
    await recordLeadStatus(personId, "suppressed", { reason, actor });
  }
  return leads.length;
}

/** The person with the entry's profile, or who holds its address, if the workspace has one. */
async function personsOf(target: EntryTarget): Promise<string[]> {
  if (target.matchType === "email") {
    const holders = await tenantClient.personEmailHash.findMany({
      where: { hash: target.hash },
      select: { personId: true },
    });
    return holders.map(({ personId }) => personId);
  }
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
  return employeesOfCompanies(companyIds);
}

/** The persons of the companies. */
async function employeesOfCompanies(companyIds: readonly string[]): Promise<string[]> {
  if (companyIds.length === 0) return [];
  const persons = await tenantClient.person.findMany({
    where: { companyId: { in: [...companyIds] } },
    select: { id: true },
  });
  return persons.map(({ id }) => id);
}

/**
 * The companies whose domain is one of `domains` or a subdomain of one, in one statement: each of a
 * company's domain and its parents looked up among the domains, a bound array the planner hashes,
 * rather than a LIKE per domain. The caller keeps those whose hashes hold one of the domains', as
 * the check matches.
 */
function companiesAt(domains: readonly string[]) {
  const { workspaceId } = currentTenant();
  return tenantClient.$queryRaw<(CompanyKeys & { id: string })[]>`
    SELECT company.id, company.domain, company.linkedin_url AS "linkedinUrl"
    FROM workspace_companies AS company
    WHERE company.workspace_id = ${workspaceId} AND company.domain IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM generate_series(1, cardinality(string_to_array(company.domain, '.'))) AS label(n)
        WHERE array_to_string((string_to_array(company.domain, '.'))[label.n:], '.')
          = ANY(${[...domains]}::text[]))`;
}
