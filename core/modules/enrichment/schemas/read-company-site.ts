// The site reader's data, version 1 (agents/read-company-site/README.md): the input, the company's
// name, the fields wanted and its own pages; the output, per field, a value with the page it comes
// from and a quote of that page, or null. Limits beyond the types are the gates' (domain/sources/
// website/gates.ts), so that every provider's structured output takes the schema. A key the output
// schema does not declare is dropped when parsed (security §6).
import { z } from "zod";

/** The task's name in the agent registry. */
export const READ_COMPANY_SITE = "enrichment.read-company-site";

/** The facts the reader may be asked for: the size is a headcount or a range. */
export const SITE_FIELDS = ["industry", "size", "country", "description"] as const;
export type SiteField = (typeof SITE_FIELDS)[number];

/** The company's name, the fields still wanted, and its pages in the order read, cut in all. */
export const readCompanySiteInput = z.object({
  company: z.string(),
  wanted: z.array(z.enum(SITE_FIELDS)).min(1),
  pages: z.array(z.object({ url: z.string(), title: z.string(), text: z.string() })).min(1),
});
export type ReadCompanySiteInput = z.output<typeof readCompanySiteInput>;

/** A value, the `url` of the page it comes from, and words copied from that page's text. */
const cited = <T extends z.ZodType>(value: T) =>
  z.object({ value, url: z.string(), quote: z.string() }).nullable();

/** Every fact, null when not wanted or when no page states it. */
export const readCompanySiteOutput = z.object({
  industry: cited(z.string()),
  employeeCount: cited(z.int()),
  employeeRange: cited(z.object({ from: z.int(), to: z.int().nullable() })),
  country: cited(z.string()),
  description: cited(z.string()),
});
export type ReadCompanySiteOutput = z.output<typeof readCompanySiteOutput>;
/** The output's facts by name. */
export type SiteFact = keyof ReadCompanySiteOutput;
