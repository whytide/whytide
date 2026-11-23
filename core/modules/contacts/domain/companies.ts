// contacts' company commands (README.md "Public interface"), inside the caller's tenant run like the
// others (persons.ts). A company is one per workspace by its LinkedIn page or its domain. Since
// gamma-rf-010 the row holds the name and the keys, and its facts live in the two layers above it
// (domain/companies/): the shared company, which every organization reads, and the sharing group's
// row; a row with no link yet, or of a workspace tenancy lacks, reads and writes its own columns.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { COMPANY_FACTS, COMPANY_KEYS, PROVIDER_REFS } from "./companies/constants.ts";
import { type Placed, readLayers, readsOnePerson } from "./companies/layers.ts";
import { copyDown, linkRow, place } from "./companies/link.ts";
import { runGroup, type SharingGroup } from "./companies/sharing.ts";
import { readGroupRow, readShared, type WorkspaceRow } from "./companies/store.ts";
import { countryCode } from "./countries.ts";
import { normalizeCompanyLinkedinUrl, normalizeDomain } from "./linkedin-url.ts";
import type { Person } from "./persons.ts";
import { getPerson } from "./persons.ts";
import { mergeFields, type Provenance, type ProvenanceMap, type Source } from "./provenance.ts";
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
  /** The headcount a source gave (gamma-en-040), at least 1. */
  readonly employeeCount: number | null;
  /** The company's own description, 2,000 characters at most. */
  readonly description: string | null;
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
  /** The headcount; without a sizeRange, it is the size too, as its text (`1234`). */
  employeeCount?: number;
  description?: string;
  providerId?: string;
  fetchedAt?: Date;
};

/** The fields of the row a linked company reads from itself: its name and its keys. */
const OWN = ["name", ...COMPANY_KEYS] as const;

/**
 * The workspace's company with the page or the domain, created or merged field by field as a person
 * is (provenance.ts). A count given without a size range writes the range as the count's text, which
 * qualification's size filter reads (`1234` falls in 1001-5000). The name and the keys find the
 * company: one equal to the stored value keeps its provenance, unless the source and provider that
 * stamped it bring it again (enrichment writes a company's facts with its stored name and keys,
 * gamma-en-050). The name and the keys go to the row; the row is linked to its shared company; the
 * facts, a key the row gains and the vendor's id go to the shared company or the group's row
 * (domain/companies/link.ts). Answered as getCompany reads it. linkedin_url_invalid for a page off
 * linkedin.com/company/<slug>; contacts_input_invalid for a domain that is none, or for neither a
 * page nor a domain.
 */
export async function upsertCompany(input: {
  source: Source;
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
    null) as WorkspaceRow | null;

  const { name, industry, employeeCount, description, providerId } = company;
  const counted = employeeCount === undefined ? undefined : String(employeeCount);
  const sizeRange = company.sizeRange || counted;
  const country = company.country ? countryCode(company.country) : undefined;
  const stamp = { source, provider, at: (company.fetchedAt ?? new Date()).toISOString() };
  const located = (field: (typeof OWN)[number], value: string | undefined) => {
    const was = stored?.fieldProvenance[field];
    const same = was === undefined || (was.source === source && was.provider === provider);
    return stored !== null && stored[field] === value && !same ? undefined : value;
  };
  const own = {
    name: located("name", name),
    domain: located("domain", domain),
    linkedinUrl: located("linkedinUrl", linkedinUrl),
  };
  const facts = { industry, sizeRange, country, employeeCount, description };
  const group = await runGroup();
  if (group === null) {
    const providerRefs =
      provider && providerId ? { ...stored?.providerRefs, [provider]: providerId } : undefined;
    const merged = mergeFields(
      stored?.fieldProvenance ?? {},
      { ...own, ...facts, providerRefs },
      stamp,
    );
    const row = await writeRow(stored, name, {
      ...merged.values,
      fieldProvenance: merged.provenance,
    });
    return { company: answer(row), created: stored === null };
  }
  const merged = mergeFields(stored?.fieldProvenance ?? {}, own, stamp);
  const row = await writeRow(stored, name, {
    ...merged.values,
    fieldProvenance: merged.provenance,
  });
  const linked = await linkRow(row.id, group);
  if (linked?.companyId != null) {
    // A row linked now placed its keys at the link already.
    const gained = linked.linkedNow ? [] : COMPANY_KEYS.filter((key) => key in merged.values);
    const values: Placed[] = [
      ...COMPANY_FACTS.flatMap((field) => {
        const value = facts[field];
        return value === undefined || value === null || value === ""
          ? []
          : [{ field, value, stamp }];
      }),
      ...gained.map((field) => ({ field, value: merged.values[field] as string, stamp })),
      ...(provider && providerId
        ? [{ field: PROVIDER_REFS, value: { [provider]: providerId }, stamp }]
        : []),
    ];
    await place({ group, companyId: linked.companyId, values, onePerson: readsOnePerson(facts) });
  }
  return { company: await read(row.id, group), created: stored === null };
}

/** The row with the data: the one found, updated, or a new one of the run's workspace. */
async function writeRow(
  stored: WorkspaceRow | null,
  name: string,
  data: Record<string, unknown> & { fieldProvenance: Record<string, Provenance> },
): Promise<WorkspaceRow> {
  if (stored !== null) {
    const row = await tenantClient.workspaceCompany.update({ where: { id: stored.id }, data });
    return row as WorkspaceRow;
  }
  const { workspaceId } = currentTenant();
  const row = await tenantClient.workspaceCompany.create({
    data: { ...data, id: newId(ids.workspace_company), workspaceId, name },
  });
  return row as WorkspaceRow;
}

/**
 * The company of the workspace; company_not_found otherwise (qualification's read, alpha-p6-020).
 * A linked row answers its own id, name and keys, and each fact from the shared company or the
 * group's row, the one whose stamp won, with that stamp (domain/companies/layers.ts); a row not
 * linked answers its own columns.
 */
export async function getCompany(companyId: string): Promise<WorkspaceCompany> {
  const id = requireId("companyId", companyId);
  const row = (await tenantClient.workspaceCompany.findFirst({
    where: { id },
  })) as WorkspaceRow | null;
  if (row === null) throw new AppError(errors.company_not_found);
  if (row.companyId === null) return answer(row);
  return layered(row, row.companyId, await runGroup());
}

/**
 * The company of the workspace, refreshed before a read (enrichment's two prepare steps): linked
 * when it has no link (domain/companies/link.ts), then given each key it lacks from the group's row,
 * else from the shared company when the key carries a stamp there, with that layer's stamp, unless
 * another company of the workspace holds the value. Answered as getCompany; company_not_found
 * otherwise.
 */
export async function refreshCompany(companyId: string): Promise<WorkspaceCompany> {
  const id = requireId("companyId", companyId);
  const group = await runGroup();
  if (group === null) return getCompany(id);
  const linked = await linkRow(id, group);
  if (linked === null) throw new AppError(errors.company_not_found);
  await copyDown(linked, group);
  return read(id, group);
}

/** The row as getCompany answers it, read again in the run. */
async function read(id: string, group: SharingGroup): Promise<WorkspaceCompany> {
  const row = (await tenantClient.workspaceCompany.findFirst({
    where: { id },
  })) as WorkspaceRow | null;
  if (row === null) throw new AppError(errors.company_not_found);
  return row.companyId === null ? answer(row) : layered(row, row.companyId, group);
}

/** A linked row with its layers' facts: the row's id, name, keys and times, the layers' facts. */
async function layered(
  row: WorkspaceRow,
  companyId: string,
  group: SharingGroup | null,
): Promise<WorkspaceCompany> {
  const shared = await readShared(companyId);
  const groupRow = group === null ? null : await readGroupRow(group, companyId);
  const facts = readLayers(shared, groupRow);
  const own: Record<string, Provenance> = {};
  for (const field of OWN) {
    const stamp = row.fieldProvenance[field];
    if (stamp !== undefined) own[field] = stamp;
  }
  return answer({ ...row, ...facts.values, fieldProvenance: { ...own, ...facts.provenance } });
}

/** The answer's fields only: a row's link is the index's, never a caller's. */
function answer(row: WorkspaceRow): WorkspaceCompany {
  const { id, workspaceId, name, domain, linkedinUrl, industry, sizeRange, country } = row;
  const { employeeCount, description, providerRefs, fieldProvenance, createdAt, updatedAt } = row;
  return {
    id,
    workspaceId,
    name,
    domain,
    linkedinUrl,
    industry,
    sizeRange,
    country,
    employeeCount,
    description,
    providerRefs,
    fieldProvenance,
    createdAt,
    updatedAt,
  };
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
