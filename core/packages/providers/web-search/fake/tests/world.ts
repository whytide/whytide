// The fake as the contract's offline world (../../contract.ts): synthetic results seeded under a
// query inside each case, after the suite's reset; the same results searched on one site; a query
// nothing was seeded under; failNext with the contract's seconds and status; the calls recorded.
import {
  type FurtherSearch,
  type OfflineWorld,
  PROVIDER_ERROR_STATUS,
  RETRY_AFTER_SEC,
  type WorldSearch,
} from "../../contract.ts";
import type { WebResult } from "../../port.ts";
import type { WebSearchFake } from "../index.ts";

export const QUERY = "Copper Harbor Labs official website";
export const SITE = "linkedin.com";
const PAGE = "https://www.linkedin.com/company/copper-harbor-labs";
/** Three synthetic results, one of them on SITE. */
export const RESULTS: readonly WebResult[] = [
  {
    url: "https://copper-harbor.example/",
    title: "Copper Harbor Labs",
    snippet: "A synthetic company of the contract suite.",
  },
  { url: PAGE, title: "Copper Harbor Labs | LinkedIn", snippet: "Software Development, 11-50" },
  { url: "https://news.copper-harbor.example/about", title: "About us", snippet: "" },
];

export const fakeWorld = (fake: WebSearchFake): OfflineWorld => ({
  live: false,
  search: (): WorldSearch => {
    fake.seedResults(QUERY, RESULTS);
    return { search: { query: QUERY, count: 5 }, results: RESULTS };
  },
  onSite: (): WorldSearch => {
    fake.seedResults(QUERY, RESULTS);
    const results = RESULTS.filter(({ url }) => url === PAGE);
    return { search: { query: QUERY, site: SITE, count: 5 }, results };
  },
  further: (): FurtherSearch => {
    fake.seedResults(QUERY, RESULTS);
    const search = { query: QUERY, count: 2, country: "GB", language: "en", page: 2 };
    return { search, results: RESULTS.slice(2), first: RESULTS.slice(0, 2) };
  },
  nothing: () => ({ query: "Nobody Seeded Holdings", count: 3 }),
  failNext: (code) => {
    if (code === "web_search_rate_limited") {
      fake.failNext(code, { retryAfterSec: RETRY_AFTER_SEC });
    } else if (code === "web_search_provider_error") {
      fake.failNext(code, { status: PROVIDER_ERROR_STATUS });
    } else {
      fake.failNext(code);
    }
  },
  calls: () => fake.recordedCalls.length,
});
