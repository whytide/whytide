// The google-kg adapter of the company-data port (README.md): Google's Knowledge Graph Search API, a
// company's official website and its description. It searches by the name only: an input without one
// is not_found with no call. Of the organizations Google answers, it keeps the one whose name is the
// input's once both are normalized (../normalize.ts); none or two are not_found, never a guess. Its
// facts show as a data vendor's: openData stays false (README.md "Licence").
import { z } from "zod";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { missingVariable, shaped } from "../answer.ts";
import { DESCRIPTION_MAX } from "../constants.ts";
import { cutText, domainOf, knownFacts, normalizeCompanyName } from "../normalize.ts";
import { type CompanyLookupResult, companyDataPort } from "../port.ts";
import { googleKgClient } from "./client.ts";
import { googleKgConfig } from "./config.ts";
import { MAX_RESULTS, SEARCH_URL } from "./constants.ts";

export type GoogleKgOptions = {
  /** GOOGLE_KG_API_KEY. */
  readonly apiKey: string;
  /** The search's address; a test passes its loopback server's. */
  readonly searchUrl?: string;
  readonly now?: () => number;
};

/** The search's answer: each organization's name, website and description, nothing else of it. */
const searchAnswer = z.object({
  itemListElement: z
    .array(
      z.object({
        result: z
          .object({
            name: z.string().optional(),
            url: z.string().optional(),
            detailedDescription: z.object({ articleBody: z.string().optional() }).optional(),
          })
          .optional(),
      }),
    )
    .max(MAX_RESULTS)
    .optional(),
});

const NOT_FOUND: CompanyLookupResult = { result: "not_found" };

export function googleKgCompanyData({
  apiKey,
  searchUrl = SEARCH_URL,
  now = Date.now,
}: GoogleKgOptions): PortImplementation<typeof companyDataPort> {
  const search = googleKgClient(searchUrl, apiKey, now);
  return {
    lookupCompany: async ({ name }) => {
      if (name === undefined) return NOT_FOUND;
      const wanted = normalizeCompanyName(name);
      const { itemListElement = [] } = shaped(searchAnswer, await search(name));
      const matches = itemListElement.flatMap(({ result }) =>
        result?.name !== undefined && normalizeCompanyName(result.name) === wanted ? [result] : [],
      );
      const [match] = matches;
      if (matches.length !== 1 || match === undefined) return NOT_FOUND;
      const facts = knownFacts({
        domain: match.url === undefined ? undefined : domainOf(match.url),
        description: cutText(match.detailedDescription?.articleBody ?? "", DESCRIPTION_MAX),
      });
      return facts === undefined ? NOT_FOUND : { result: "found", company: facts };
    },
  };
}

export const googleKgAdapter = defineAdapter(companyDataPort, {
  name: "google-kg",
  requires: ["GOOGLE_KG_API_KEY"],
  allowance: googleKgConfig.GOOGLE_KG_ALLOWANCE,
  create: () => {
    const apiKey = googleKgConfig.GOOGLE_KG_API_KEY;
    if (!apiKey) throw missingVariable("GOOGLE_KG_API_KEY", "google-kg");
    return googleKgCompanyData({ apiKey });
  },
});
