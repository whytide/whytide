// company-data's sources (README "Sources"): one per adapter of PROVIDER_COMPANY_DATA, in its order,
// named `company-data/<adapter>`, each on the adapter its own getAdapters call loaded (index.ts). A
// lookup takes the company's LinkedIn page, domain and name and its country, each in the port's form
// or left out, and nothing of the person. The facts come back in contacts' words: a size band as a
// range's text (`51-200`, `10001+`), which qualification's sizeRangesOf reads, the headcount beside
// it. Their class is open_data for an adapter that declares open data, else data_vendor; their
// provider is the adapter's name.
import {
  type BoundAdapter,
  type CompanyFacts,
  type CompanyLookup,
  companyDataPort,
  companyLookup,
} from "@whytide/providers";
import { COMPANY_DATA, COMPANY_FIELDS } from "../constants.ts";
import type { SourceAnswer, SourceDefinition, SourceFacts, SourceInput } from "./define.ts";

type CompanyDataAdapter = BoundAdapter<typeof companyDataPort>;
/** contacts keeps a page as https://linkedin.com/company/<slug>; the port takes it with `www.`. */
const STORED_PAGE = /^https:\/\/linkedin\.com\//;
const PORT_PAGE = "https://www.linkedin.com/";

export function companyDataSource(name: string, adapter: CompanyDataAdapter): SourceDefinition {
  const source: SourceDefinition = {
    name: `${COMPANY_DATA}/${name}`,
    kind: "company",
    fills: COMPANY_FIELDS,
    needs: ["linkedinUrl", "domain", "name"],
    activityKind: "provider",
    provenance: { source: adapter.openData ? "open_data" : "data_vendor", provider: name },
    allowance: () => adapter.allowance,
    run: async ({ company = {} }: SourceInput): Promise<SourceAnswer> => {
      const lookup = lookupOf(company);
      if (lookup === null) return { found: false };
      const answer = await adapter.lookupCompany(lookup);
      return answer.result === "found"
        ? { found: true, facts: factsOf(answer.company) }
        : { found: false };
    },
  };
  return Object.freeze(source);
}

/** The company's keys in the port's forms, each checked on its own; null when none is left. */
export function lookupOf(company: NonNullable<SourceInput["company"]>): CompanyLookup | null {
  const fits = (key: Partial<CompanyLookup>) =>
    companyLookup.safeParse({ name: "-", ...key }).success;
  const linkedinUrl = company.linkedinUrl?.replace(STORED_PAGE, PORT_PAGE);
  const { domain, name, country: countryHint } = company;
  const lookup: Partial<CompanyLookup> = {
    ...(linkedinUrl !== undefined && fits({ linkedinUrl }) && { linkedinUrl }),
    ...(domain !== undefined && fits({ domain }) && { domain }),
    ...(name !== undefined && fits({ name }) && { name }),
    ...(countryHint !== undefined && fits({ countryHint }) && { countryHint }),
  };
  const keyed = [lookup.linkedinUrl, lookup.domain, lookup.name].some((key) => key !== undefined);
  return keyed ? (lookup as CompanyLookup) : null;
}

/** The port's facts as the run's fields; the name and the founding year are not wanted. */
export function factsOf(facts: CompanyFacts): SourceFacts {
  const { domain, linkedinUrl, industry, employeeCount, employeeRange, country, description } =
    facts;
  const sizeRange =
    employeeRange &&
    (employeeRange.to === undefined
      ? `${employeeRange.from}+`
      : `${employeeRange.from}-${employeeRange.to}`);
  const all = { domain, linkedinUrl, industry, sizeRange, country, description, employeeCount };
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined));
}
