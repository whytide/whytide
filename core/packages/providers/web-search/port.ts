// The web-search port (docs/architecture.md §9, docs/rules/coding.md §6; brief RB-7.3.1, the port's
// part): a few web results for a query, in our words (README.md). One method, searchWeb(). The input
// is a strict object, the query, the site the results stay on, their count, and optionally a
// country, a language and a page, and nothing else; the output is the results, each an https link with its title and snippet, strict and checked in every
// environment, production included. What a query holds, a company's name and never a person's (one caller
// excepted, README.md, gamma-wr-070), is the caller's rule (gamma-en-070): the port cannot tell the two apart. Each adapter declares its
// free allowance; the caller counts the calls (../README.md "Many adapters per port").
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";
import {
  COUNT_MAX,
  COUNT_MIN,
  COUNTRY,
  HTTPS,
  LANGUAGE,
  NOT_BLANK,
  PAGE_MAX,
  PAGE_MIN,
  QUERY_MAX,
  SITE,
  SITE_MAX,
  TEXT_MAX,
  URL_MAX,
} from "./constants.ts";

export { webSearchConfig } from "./config.ts";
export { PAGE_MAX } from "./constants.ts";
export type { WebSearchFake } from "./fake/index.ts";

/**
 * What a search takes: the query, the host the results stay on, how many results at most, and,
 * all optional, the country and the language to search in (by form only) and the page: the results
 * after the first `count × (page − 1)`, page 1 when absent.
 */
export const webSearch = z.strictObject({
  query: z.string().min(1).max(QUERY_MAX).regex(NOT_BLANK, "not blank"),
  site: z
    .string()
    .max(SITE_MAX)
    .regex(SITE, "a host name, lower case, without a scheme or a path")
    .optional(),
  count: z.int().min(COUNT_MIN).max(COUNT_MAX),
  country: z.string().regex(COUNTRY, "an ISO 3166-1 alpha-2 code, upper case").optional(),
  language: z.string().regex(LANGUAGE, "an ISO 639-1 code, two letters, lower case").optional(),
  page: z.int().min(PAGE_MIN).max(PAGE_MAX).optional(),
});

/** One result: an https link, its title and its snippet, plain text. */
export const webResult = z.strictObject({
  url: z.url({ protocol: HTTPS }).max(URL_MAX),
  title: z.string().max(TEXT_MAX),
  snippet: z.string().max(TEXT_MAX),
});

export const webResults = z.strictObject({ results: z.array(webResult).max(COUNT_MAX) });

export type WebSearch = z.infer<typeof webSearch>;
export type WebResult = z.infer<typeof webResult>;
export type WebResults = z.infer<typeof webResults>;

export const webSearchPort = definePort({
  name: "web_search",
  errorPrefix: "web_search",
  alwaysCheckOutputs: true,
  methods: {
    searchWeb: { input: webSearch, output: webResults },
  },
  errors: {
    /** The vendor's rate limit: `details.retryAfterSec`, the seconds it asks to wait. */
    web_search_rate_limited: { status: 429 },
    /** The vendor's free calls or credits are gone (its 402, or its own quota error): never retried. */
    web_search_allowance_spent: { status: 402 },
    /** The vendor refused the key. */
    web_search_unauthorized: { status: 401 },
    /** Anything else the vendor answered, or no answer: `details.status` or `reason`, never its body. */
    web_search_provider_error: { status: 502 },
  },
});
