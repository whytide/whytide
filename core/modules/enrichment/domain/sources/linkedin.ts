// The source `linkedin` (README "Sources"; gamma-en-060): the company's LinkedIn page, read through
// one of the workspace's LinkedIn accounts by the linkedin module's readCompany, inside that account's
// daily reads and its share for company pages. It needs the page and fills the website's host as the
// domain, the industry, the size band as a range's text with the headcount beside it, the
// headquarters' country and the description, only those the run still wants. It has no allowance of
// its own: the linkedin quota is its limit, and no account able to read now is a skip
// (`no_account`, `no_reads_left`), never a failure. Its facts' class is `linkedin`; their provider
// the LinkedIn adapter that read them (`unipile` on a real instance).
import { type CompanyRead, readCompany } from "@whytide/linkedin";
import { linkedinConfig } from "@whytide/providers";
import { WWW } from "../constants.ts";
import { factsOf } from "./company-data.ts";
import { defineSource, type SourceAnswer, type SourceFacts } from "./define.ts";

type Company = Extract<CompanyRead, { status: "read" }>["company"];

export const linkedinSource = defineSource({
  name: "linkedin",
  kind: "company",
  fills: ["domain", "industry", "sizeRange", "country", "description"],
  needs: ["linkedinUrl"],
  activityKind: "provider",
  provenance: { source: "linkedin", provider: "unipile" },
  run: async ({ workspaceId, company, wanted }, { tenant }): Promise<SourceAnswer> => {
    const companyUrl = company?.linkedinUrl;
    if (companyUrl === undefined) return { found: false };
    const answer = await readCompany({ companyUrl }, { workspaceId, tenant });
    if (answer.status === "not_found") return { found: false };
    if (answer.status !== "read") return { found: false, outcome: answer.status };
    const facts = wantedOf(factsOfPage(answer.company), wanted);
    const provider = linkedinConfig.PROVIDER_LINKEDIN;
    return { found: true, facts, ...(provider !== undefined && { provider }) };
  },
});

/** The page's facts in the run's words: the website's host as the domain, the band as text. */
function factsOfPage(page: Company): SourceFacts {
  const { website, industry, employeeCount, employeeRange, headquartersCountry, description } =
    page;
  return factsOf({
    domain: website === undefined ? undefined : hostOf(website),
    industry,
    employeeCount,
    employeeRange,
    country: headquartersCountry,
    description,
  });
}

/** A website's host, lower case, without `www.`: no scheme, port or path. */
function hostOf(website: string): string | undefined {
  const host = URL.parse(website)?.hostname.toLowerCase();
  if (!host) return undefined;
  return host.startsWith(WWW) ? host.slice(WWW.length) : host;
}

/** Only the fields the run wants; the headcount goes with the size band. */
function wantedOf(facts: SourceFacts, wanted: readonly string[]): SourceFacts {
  const kept = Object.entries(facts).filter(([field]) =>
    wanted.includes(field === "employeeCount" ? "sizeRange" : field),
  );
  return Object.fromEntries(kept);
}
