// The website source's names and bounds (README "The website source"; gamma-en-065). Pure.

import type { SiteFact, SiteField } from "../../../schemas/read-company-site.ts";
import type { CompanyField } from "../../constants.ts";

/** The source's name in ENRICHMENT_COMPANY_SOURCES, and its provider in the provenance. */
export const WEBSITE = "website";
/** The outcome when robots.txt lets nothing of the site be read: no page, no AI call. */
export const BLOCKED = "blocked";

/** The pages read first after the home page, group by group: who the company is, then its people. */
export const SITE_PREFERRED: readonly (readonly string[])[] = [
  ["about", "about-us", "who-we-are"],
  ["company"],
  ["team", "our-team", "people"],
  ["contact", "contact-us"],
  ["imprint", "impressum"],
  ["legal"],
  ["careers", "jobs"],
];

/** The whole read's bound: 60 seconds of fetching. */
export const SITE_TOTAL_MS = 60_000;
/** A page whose text is shorter after the plain fetch is asked of the browser. */
export const BROWSER_MIN_TEXT = 200;
/** The activity's start-to-close: the read, the browser's pages and the AI's two attempts. */
export const TIMEOUT_SECONDS = 180;

/** The pages' text the AI gets, in characters, in all. */
export const INPUT_CHARS = 60_000;
/**
 * And in UTF-8 bytes as the blocks write it: the task's budget counts bytes over three, so 81,000
 * bytes stay within its 30,000 input tokens with the prompt, the titles and the addresses.
 */
export const INPUT_BYTES = 81_000;

/** The run's fields the AI reads, and the reader's word for each. */
export const AI_FIELDS: Readonly<Partial<Record<CompanyField, SiteField>>> = {
  industry: "industry",
  sizeRange: "size",
  country: "country",
  description: "description",
};
/** The output's facts each wanted word asks for. */
export const FACTS_OF: Readonly<Record<SiteField, readonly SiteFact[]>> = {
  industry: ["industry"],
  size: ["employeeCount", "employeeRange"],
  country: ["country"],
  description: ["description"],
};
/** Each fact's bounds beyond its type: characters for a text. */
export const FACT_LIMITS = { industry: 200, description: 2_000 } as const;
/** A headquarters' country: an ISO 3166-1 alpha-2 code. */
export const COUNTRY = /^[A-Z]{2}$/;

/** A company's LinkedIn page: on linkedin.com or one of its subdomains, `/company/<slug>`. */
export const LINKEDIN_HOST = /^(?:[a-z]{2,3}\.|www\.)?linkedin\.com$/;
export const LINKEDIN_SLUG = /^[\w%-]{1,200}$/;
export const LINKEDIN_PAGE = "https://www.linkedin.com/company/";
