// contacts' company commands (README.md "Public interface"), inside the caller's tenant run like the
// others (persons.ts). A company is one per workspace by its LinkedIn page or its domain.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { countryCode } from "./countries.ts";
import { normalizeCompanyLinkedinUrl, normalizeDomain } from "./linkedin-url.ts";
import type { Person } from "./persons.ts";
import { getPerson } from "./persons.ts";
import { mergeFields, type Provenance, type ProvenanceMap } from "./provenance.ts";
import { linkInput, parseInput, requireId, upsertCompanyInput } from "./rules.ts";

export type WorkspaceCompany = {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly domain: string | null;
  readonly linkedinUrl: string | null;
  readonly industry: string | null;
  readonly sizeRange: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly country: string | null;
  readonly providerRefs: Readonly<Record<string, string>> | null;
  readonly fieldProvenance: ProvenanceMap;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};
/** What a source brings of a company: a name and its LinkedIn page or its domain, at least one. */
export type CompanyProfile = {
  name: string;
  domain?: string;
  linkedinUrl?: string;
  industry?: string;
  sizeRange?: string;
  /** A code (`DE`) or a name (`Germany`); kept as the code, dropped when it is neither. */
  country?: string;
  providerId?: string;
  fetchedAt?: Date;
};

/**
 * The workspace's company with the page or the domain, created or merged field by field as a person
 * is (provenance.ts). linkedin_url_invalid for a page off linkedin.com/company/<slug>;
 * contacts_input_invalid for a domain that is none, or for neither a page nor a domain.
 */
export async function upsertCompany(input: {
  source: Provenance["source"];
  provider: Provenance["provider"];
  company: CompanyProfile;
}): Promise<{ company: WorkspaceCompany; created: boolean }> {
  const { source, provider, company } = parseInput(upsertCompanyInput, input);
  const linkedinUrl = company.linkedinUrl && normalizeCompanyLinkedinUrl(company.linkedinUrl);
  if (linkedinUrl === null) throw new AppError(errors.linkedin_url_invalid);
  const domain = company.domain ? normalizeDomain(company.domain) : undefined;
  if (domain === null || (!linkedinUrl && !domain)) {
    const fields = domain === null ? ["company.domain"] : ["company.linkedinUrl", "company.domain"];
    throw new AppError(errors.contacts_input_invalid, { details: { fields } });
  }
  const keys = [...(linkedinUrl ? [{ linkedinUrl }] : []), ...(domain ? [{ domain }] : [])];
  const found = await tenantClient.workspaceCompany.findMany({ where: { OR: keys }, take: 2 });
  const stored = (found.find((row) => linkedinUrl && row.linkedinUrl === linkedinUrl) ??
    found[0] ??
    null) as WorkspaceCompany | null;

  const { name, industry, sizeRange, providerId } = company;
  const country = company.country ? countryCode(company.country) : undefined;
  const providerRefs =
    provider && providerId ? { ...stored?.providerRefs, [provider]: providerId } : undefined;
  const stamp = { source, provider, at: (company.fetchedAt ?? new Date()).toISOString() };
  const incoming = { name, domain, linkedinUrl, industry, sizeRange, country, providerRefs };
  const { values, provenance } = mergeFields(stored?.fieldProvenance ?? {}, incoming, stamp);
  const data = { ...values, fieldProvenance: provenance };
  if (stored !== null) {
    const row = await tenantClient.workspaceCompany.update({ where: { id: stored.id }, data });
    return { company: row as WorkspaceCompany, created: false };
  }
  const { workspaceId } = currentTenant();
  const row = await tenantClient.workspaceCompany.create({
    data: { ...data, id: newId(ids.workspace_company), workspaceId, name },
  });
  return { company: row as WorkspaceCompany, created: true };
}

/** The company of the workspace; company_not_found otherwise (qualification's read, alpha-p6-020). */
export async function getCompany(companyId: string): Promise<WorkspaceCompany> {
  const id = requireId("companyId", companyId);
  const company = await tenantClient.workspaceCompany.findFirst({ where: { id } });
  if (company === null) throw new AppError(errors.company_not_found);
  return company as WorkspaceCompany;
}

/**
 * Links the person to the company, both of the workspace: loaded through the tenant client first,
 * for a clean code, though the key on (workspace_id, company_id) refuses another workspace's
 * company anyway. person_not_found, company_not_found.
 */
export async function linkPersonToCompany(input: {
  personId: string;
  companyId: string;
}): Promise<Person> {
  const { personId, companyId } = parseInput(linkInput, input);
  const person = await getPerson(personId);
  const company = await tenantClient.workspaceCompany.findFirst({ where: { id: companyId } });
  if (company === null) throw new AppError(errors.company_not_found);
  const updated = await tenantClient.person.update({
    where: { id: person.id },
    data: { companyId: company.id },
  });
  return updated as Person;
}
