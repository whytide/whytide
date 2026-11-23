// The register's answers for the companies-house mapping tests, synthetic, in the public data API's
// documented shapes: a search whose one active company matches the name, beside a dissolved one of
// the same name and an active one of another; a dissolved company alone; two active matches; none;
// a company the search calls active and its profile no longer does; a SIC code off the table. The
// route answers a search by its name and a profile by its number.
import type { CompanyFacts } from "../../port.ts";
import type { Answer, Received } from "../../tests/fixtures/vendor.ts";

export const NAME = "Copper Harbor Labs";
/** Every row of the README's table: 62012's description, and GB. */
export const FACTS: CompanyFacts = {
  industry: "Business and domestic software development",
  country: "GB",
};

const item = (title: string, company_number: string, company_status: string) => ({
  kind: "searchresults#company",
  title,
  company_number,
  company_status,
  company_type: "ltd",
  date_of_creation: "2018-01-01",
});
const search = (...items: unknown[]): Answer => ({
  body: { kind: "search#companies", items, items_per_page: 20, total_results: items.length },
});
const profile = (company_number: string, company_status: string, sic_codes: string[]): Answer => ({
  body: {
    company_name: "SYNTHETIC LIMITED",
    company_number,
    company_status,
    sic_codes,
    type: "ltd",
  },
});

const SEARCHES: Readonly<Record<string, Answer>> = {
  [NAME]: search(
    item("COPPER HARBOR LABS LIMITED", "01234567", "active"),
    item("COPPER HARBOR LABS LTD", "07654321", "dissolved"),
    item("COPPER HARBOR LOGISTICS LIMITED", "SC123456", "active"),
  ),
  "Dissolved Harbor": search(item("DISSOLVED HARBOR LIMITED", "02222222", "dissolved")),
  "Twin Harbor": search(
    item("TWIN HARBOR LIMITED", "03333331", "active"),
    item("TWIN HARBOR LTD", "03333332", "active"),
  ),
  "Stale Harbor": search(item("STALE HARBOR LIMITED", "04444444", "active")),
  "Odd Harbor": search(item("ODD HARBOR LIMITED", "05555555", "active")),
};
const PROFILES: Readonly<Record<string, Answer>> = {
  "01234567": profile("01234567", "active", ["62012", "70229"]),
  "04444444": profile("04444444", "liquidation", ["62012"]),
  "05555555": profile("05555555", "active", ["00000"]),
};

/** The answers by what a request asks for; anything else is an empty search. */
export function route({ path, query }: Received): Answer {
  const number = path.startsWith("/company/") ? path.slice("/company/".length) : undefined;
  if (number !== undefined) return PROFILES[number] ?? { status: 404, body: { errors: [] } };
  return SEARCHES[query.q ?? ""] ?? search();
}
