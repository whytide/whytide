// Google's answers for the google-kg mapping tests, synthetic, in the Knowledge Graph Search API's
// documented shapes (an ItemList of EntitySearchResult) and Google's error model: one organization
// whose name matches, beside one that does not; a result whose name does not match; two that match;
// none; a daily quota spent, a per-minute limit, a key refused. The route answers by the name searched.
import type { CompanyDataFailure } from "../../contract.ts";
import { PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "../../contract.ts";
import type { CompanyFacts } from "../../port.ts";
import type { Answer, Received } from "../../tests/fixtures/vendor.ts";

export const NAME = "Copper Harbor Labs";
/** An article longer than the port's 2,000 characters, with no space at the cut. */
export const ARTICLE = "Copper Harbor Labs builds software for harbors".padEnd(2_100, ".");
/** Every row of the README's table, from the one organization that matches. */
export const FACTS: CompanyFacts = {
  domain: "copper-harbor.example",
  description: ARTICLE.slice(0, 2_000),
};

const result = (name: string, more: Record<string, unknown> = {}) => ({
  "@type": "EntitySearchResult",
  result: { "@id": `kg:/m/${name.length}`, name, "@type": ["Organization", "Thing"], ...more },
  resultScore: 100,
});
const list = (...results: unknown[]): Answer => ({
  body: { "@context": {}, "@type": "ItemList", itemListElement: results },
});

/** The organization that matches, Inc. aside, beside one whose name is another. */
export const MATCH = list(
  result("Copper Harbor Labs, Inc.", {
    description: "Software company",
    url: "https://www.copper-harbor.example/",
    detailedDescription: {
      articleBody: ARTICLE,
      url: "https://en.wikipedia.org/wiki/Copper_Harbor_Labs",
      license: "https://en.wikipedia.org/wiki/Wikipedia:Text_of_the_Creative_Commons_License",
    },
  }),
  result("Copper Harbor Logistics", { url: "https://copper-logistics.example/" }),
);
export const TWO = list(
  result("Twin Harbor", { url: "https://twin-harbor.example/" }),
  result("Twin Harbor GmbH", { url: "https://twin-harbor.example.de/" }),
);
/** A match with neither a website nor an article: no fact. */
export const BARE = list(result("Bare Harbor"));
export const NONE = list();

/** Google's error, google.rpc.Status with one ErrorInfo. */
const googleError = (code: number, status: string, reason: string, quota?: string) => ({
  error: {
    code,
    message: "Synthetic error of the google-kg adapter's tests.",
    status,
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason,
        domain: "googleapis.com",
        metadata: { service: "kgsearch.googleapis.com", ...(quota ? { quota_limit: quota } : {}) },
      },
    ],
  },
});
/** Each of the port's codes from Google's own answer. */
export const GOOGLE_FAILURES: Readonly<Record<CompanyDataFailure, Answer>> = {
  company_data_rate_limited: {
    status: 429,
    headers: { "retry-after": String(RETRY_AFTER_SEC) },
    body: googleError(429, "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED", "ReadRequestsPerMinute"),
  },
  company_data_allowance_spent: {
    status: 429,
    body: googleError(429, "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED", "ReadRequestsPerDay"),
  },
  company_data_unauthorized: {
    status: 400,
    body: googleError(400, "INVALID_ARGUMENT", "API_KEY_INVALID"),
  },
  company_data_provider_error: { status: PROVIDER_ERROR_STATUS },
};

/** The answers by the name searched: "Copper Harbor" finds the same two organizations. */
export function route({ query }: Received): Answer {
  if (query.query?.startsWith("Copper Harbor")) return MATCH;
  if (query.query === "Twin Harbor") return TWO;
  if (query.query === "Bare Harbor") return BARE;
  return NONE;
}
