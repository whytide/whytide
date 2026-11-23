// A company page on Unipile (README.md "Covers"; gamma-en-060): getCompany asks Unipile's company
// profile, GET /linkedin/company/{identifier}, by the page link's slug or number, through the user's
// account, and maps the business facts only: the size, its band, the first industry, the website, the
// headquarters' country (a code kept, an English name mapped, company data's countryOf), the
// description cut to COMPANY_DESCRIPTION_MAX_CHARS and the founding year. A fact off its form is left
// out, never a failure; nothing else of the answer (followers, employees, phone, permissions, funding)
// crosses: the port's schema drops it. Errors map as every read's (client.ts).
import { z } from "zod";
import type { PortImplementation } from "../../_pattern/index.ts";
import { countOf, countryOf, cutText } from "../../company-data/normalize.ts";
import {
  AUTHOR_PATHS,
  COMPANY_DESCRIPTION_MAX_CHARS,
  COMPANY_INDUSTRY_MAX_CHARS,
  COMPANY_NAME_MAX_CHARS,
  COUNTRY_CODE,
} from "../constants.ts";
import { type LinkedinCompany, linkedinCompany, type linkedinPort } from "../port.ts";
import { type Client, notFound, offShape, segment } from "./client.ts";
import { FOUNDATION_YEAR, HAS_SCHEME, WEB_SCHEME } from "./constants.ts";

type GetCompany = PortImplementation<typeof linkedinPort>["getCompany"];

/** A company profile as Unipile answers it: the fields the port maps, and nothing else of it. */
const vendorCompany = z.object({
  name: z.string(),
  description: z.string().nullish(),
  industry: z.array(z.unknown()).nullish(),
  employee_count: z.unknown().optional(),
  employee_count_range: z.object({ from: z.unknown(), to: z.unknown() }).partial().nullish(),
  website: z.string().nullish(),
  foundation_date: z.string().nullish(),
  locations: z
    .array(z.object({ is_headquarter: z.boolean().nullish(), country: z.string().nullish() }))
    .nullish(),
});

export function getCompany(call: Client, now: () => number): GetCompany {
  return async ({ providerAccountRef, companyUrl }) => {
    const method = "getCompany";
    const id = slugOf(companyUrl);
    if (id === undefined) throw notFound(method);
    const answer = await call(method, {
      path: `/linkedin/company/${segment(id, method)}`,
      query: { account_id: providerAccountRef },
    });
    const found = vendorCompany.safeParse(answer);
    if (!found.success) throw offShape(method);
    const company = linkedinCompany.safeParse(mapped(companyUrl, found.data, new Date(now())));
    if (!company.success) throw offShape(method);
    return company.data;
  };
}

/** The port's company: each fact in its form, or left out. */
function mapped(
  companyUrl: string,
  vendor: z.infer<typeof vendorCompany>,
  fetchedAt: Date,
): LinkedinCompany {
  const from = countOf(vendor.employee_count_range?.from, 0);
  const to = countOf(vendor.employee_count_range?.to, 1);
  const employeeRange =
    from === undefined ? undefined : to === undefined || to < from ? { from } : { from, to };
  const headquarters = vendor.locations?.find((location) => location.is_headquarter === true);
  const year = FOUNDATION_YEAR.exec(vendor.foundation_date ?? "")?.[1];
  const facts = {
    website: websiteOf(vendor.website),
    industry: cutText(vendor.industry?.[0], COMPANY_INDUSTRY_MAX_CHARS),
    employeeCount: countOf(vendor.employee_count, 1),
    employeeRange,
    headquartersCountry: countryCodeOf(headquarters?.country),
    description: cutText(vendor.description, COMPANY_DESCRIPTION_MAX_CHARS),
    foundedYear: year === undefined ? undefined : Number(year),
  };
  const known = Object.entries(facts).filter(([, value]) => value !== undefined);
  return {
    companyUrl,
    name: cutText(vendor.name, COMPANY_NAME_MAX_CHARS) ?? "",
    ...Object.fromEntries(known),
    fetchedAt,
  };
}

/** The page's slug or number, decoded; undefined for a link of another form. */
function slugOf(companyUrl: string): string | undefined {
  const handle = AUTHOR_PATHS.company.exec(URL.parse(companyUrl)?.pathname ?? "")?.[1];
  try {
    return handle === undefined ? undefined : decodeURIComponent(handle);
  } catch {
    return undefined;
  }
}

/** A website as a link of the web, read as https when Unipile gives a bare host. */
function websiteOf(website: string | null | undefined): string | undefined {
  const text = website?.trim();
  if (!text) return undefined;
  const url = URL.parse(HAS_SCHEME.test(text) ? text : `${WEB_SCHEME}${text}`);
  return linkedinCompany.shape.website.safeParse(url?.href).data;
}

/** A code kept, upper-cased; an English name mapped; anything else left out. */
function countryCodeOf(country: string | null | undefined): string | undefined {
  const text = country?.trim() ?? "";
  const code = text.toUpperCase();
  if (COUNTRY_CODE.test(code)) return code;
  return countryOf(text);
}
