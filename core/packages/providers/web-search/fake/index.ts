// The web-search fake (README.md "The fake"): results seeded in memory under a query, in any case; a
// search answers copies of the query's results, those on its site only when it names one (the host
// or a subdomain of it), the `count` of the page asked (page 1 when none: the first); an unseeded
// query answers none. The country and the language are recorded in recordedCalls and filter
// nothing. setAllowance() sets the allowance the bound fake exposes, so that the caller's tests
// count against one; reset() clears it with the seeds. failNext()'s rate limit carries retryAfterSec and its provider error a
// status, as an adapter's do, unless the details give them. create() refuses APP_ENV=production: the
// fake never stands in for a vendor on a server.
import { AppError, platformConfig } from "@whytide/platform";
import { type Allowance, createFake, defineAdapter, patternErrors } from "../../_pattern/index.ts";
import { PAGE_MIN } from "../constants.ts";
import { type WebResult, webSearchPort } from "../port.ts";
import { onSite } from "../site.ts";
import { PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "./constants.ts";

const { errors } = webSearchPort;

export const webSearchFake = createFake(webSearchPort, {
  state: () => ({
    results: new Map<string, readonly WebResult[]>(),
    allowance: null as Allowance | null,
  }),
  methods: (fake) => ({
    searchWeb: async ({ query, site, count, page = PAGE_MIN }) => {
      const seeded = fake.state.results.get(query.toLowerCase()) ?? [];
      const kept = site === undefined ? seeded : seeded.filter(({ url }) => onSite(url, site));
      return { results: structuredClone(kept.slice(count * (page - 1), count * page)) };
    },
  }),
  helpers: (fake) => ({
    /** The results a search of `query`, in any case, answers, in this order. */
    seedResults: (query: string, results: readonly WebResult[]): void => {
      fake.state.results.set(query.toLowerCase(), structuredClone(results));
    },
    /** The allowance the bound fake exposes, null for none, until the next reset. */
    setAllowance: (allowance: Allowance | null): void => {
      fake.state.allowance = allowance;
    },
  }),
});

export type WebSearchFake = typeof webSearchFake;

/** The details failNext adds when a test gives none, as an adapter's codes carry them. */
const DETAILS: Readonly<Record<string, Record<string, unknown>>> = {
  [errors.web_search_rate_limited]: { retryAfterSec: RETRY_AFTER_SEC },
  [errors.web_search_provider_error]: { status: PROVIDER_ERROR_STATUS },
};
const failNext = webSearchFake.failNext;
webSearchFake.failNext = (code, details) => {
  const defaults = DETAILS[code];
  failNext(code, defaults ? { ...defaults, ...details } : details);
};

export const webSearchFakeAdapter = defineAdapter(webSearchPort, {
  name: "fake",
  allowance: () => webSearchFake.state.allowance,
  create: () => {
    if (platformConfig.APP_ENV === "production") {
      const details = { port: webSearchPort.name, adapter: "fake", reason: "APP_ENV=production" };
      throw new AppError(patternErrors.adapter_invalid, { details });
    }
    return webSearchFake;
  },
});
