// The web-search port's contract (README.md "The contract suite"): what every adapter does, run by
// each adapter's tests in its world. A live world, the vendor's API with the owner's key, gets exactly
// one search, of the query it names, and every other case skips: a free plan's searches are few. The
// live suite refuses to start under APP_ENV=production. An offline world, the fake or an adapter's
// answers served on 127.0.0.1, gets every case: the results of a search, the first `count` of them,
// a further page for a country and a language, those on a site, none for a query nothing matches,
// the inputs refused before any call, and each of the port's codes from the vendor's answer, for
// the next call only.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { isAppError, platformConfig } from "@whytide/platform";
import type { PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import { COUNT_MAX, PAGE_MAX, QUERY_MAX, SITE_MAX } from "./constants.ts";
import type { WebResult, WebSearch, webSearchPort } from "./port.ts";
import { onSite } from "./site.ts";

type WebSearchPort = PortInstance<typeof webSearchPort>;

/** The port's codes a vendor's answer maps to. */
export type WebSearchFailure =
  | "web_search_rate_limited"
  | "web_search_allowance_spent"
  | "web_search_unauthorized"
  | "web_search_provider_error";

/** The seconds the contract's rate limit asks to wait, and the status of its provider error. */
export const RETRY_AFTER_SEC = 30;
export const PROVIDER_ERROR_STATUS = 503;

/** A search an offline world's adapter answers, and the results it answers, in the port's words. */
export type WorldSearch = { readonly search: WebSearch; readonly results: readonly WebResult[] };
/** A search of page 2 with a country and a language, and the results of its page 1, in the port's words. */
export type FurtherSearch = {
  readonly search: WebSearch;
  readonly results: readonly WebResult[];
  readonly first: readonly WebResult[];
};
/** The vendor's API with the owner's key: the one search the owner may run. */
export type LiveWorld = {
  readonly live: true;
  readonly search: () => WebSearch | Promise<WebSearch>;
};
/** The fake, or an adapter's answers served locally. Each hook runs inside its case, after a fake's reset. */
export type OfflineWorld = {
  readonly live: false;
  /** A search answered with two results or more, all within its count. */
  readonly search: () => WorldSearch | Promise<WorldSearch>;
  /** A search with a site, answered with the results on that site only. */
  readonly onSite: () => WorldSearch | Promise<WorldSearch>;
  /**
   * A search with a country, a language and page 2, answered with results that are not page 1's;
   * `first` is the same search without the three keys, answered with page 1's.
   */
  readonly further: () => FurtherSearch | Promise<FurtherSearch>;
  /** A search nothing matches. */
  readonly nothing: () => WebSearch | Promise<WebSearch>;
  /**
   * The vendor's next answer is one the port reads as `code`: the rate limit asks RETRY_AFTER_SEC,
   * the provider error answers PROVIDER_ERROR_STATUS.
   */
  readonly failNext: (code: WebSearchFailure) => void;
  /** How many calls reached the vendor so far. */
  readonly calls: () => number;
};
export type WebSearchWorld = LiveWorld | OfflineWorld;

const QUERY = "Copper Harbor Labs official website";
type Inputs = readonly (readonly [label: string, input: unknown])[];
/** A search off the port's form. */
const OFF_FORM: Inputs = [
  ["no query", { count: 3 }],
  ["an empty query", { query: "", count: 3 }],
  ["a blank query", { query: "   ", count: 3 }],
  ["a query too long", { query: "x".repeat(QUERY_MAX + 1), count: 3 }],
  ["no count", { query: QUERY }],
  ["a count of 0", { query: QUERY, count: 0 }],
  ["a count over the most", { query: QUERY, count: COUNT_MAX + 1 }],
  ["part of a count", { query: QUERY, count: 2.5 }],
  ["a count in text", { query: QUERY, count: "3" }],
  ["an empty site", { query: QUERY, count: 3, site: "" }],
  ["a site with a scheme", { query: QUERY, count: 3, site: "https://linkedin.com" }],
  ["a site with a path", { query: QUERY, count: 3, site: "linkedin.com/company" }],
  ["a site in capitals", { query: QUERY, count: 3, site: "LINKEDIN.COM" }],
  ["a site of one label", { query: QUERY, count: 3, site: "localhost" }],
  ["a site too long", { query: QUERY, count: 3, site: `${"a".repeat(SITE_MAX)}.com` }],
  ["a country of three letters", { query: QUERY, count: 3, country: "GBR" }],
  ["a country of one letter", { query: QUERY, count: 3, country: "G" }],
  ["a country in lower case", { query: QUERY, count: 3, country: "gb" }],
  ["a country with a digit", { query: QUERY, count: 3, country: "G1" }],
  ["an empty country", { query: QUERY, count: 3, country: "" }],
  ["a country in a list", { query: QUERY, count: 3, country: ["GB"] }],
  ["a language of three letters", { query: QUERY, count: 3, language: "eng" }],
  ["a language in capitals", { query: QUERY, count: 3, language: "EN" }],
  ["a language with a region", { query: QUERY, count: 3, language: "en-gb" }],
  ["an empty language", { query: QUERY, count: 3, language: "" }],
  ["a page of 0", { query: QUERY, count: 3, page: 0 }],
  ["a page past the most", { query: QUERY, count: 3, page: PAGE_MAX + 1 }],
  ["part of a page", { query: QUERY, count: 3, page: 1.5 }],
  ["a page in text", { query: QUERY, count: 3, page: "2" }],
];
/** Any key but the query, the site, the count, the country, the language and the page: a person's included. */
const OTHER_KEYS: Inputs = [
  ["a first name", { query: QUERY, count: 3, firstName: "Ada" }],
  ["an email", { query: QUERY, count: 3, email: "ada@copper-harbor.example" }],
  ["an offset", { query: QUERY, count: 3, offset: 10 }],
];

/** The error is the port's `code`; `check` reads its details. */
const failsWith =
  (code: string, check?: (details: Record<string, unknown>) => void) => (error: unknown) => {
    assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
    check?.(error.details ?? {});
    return true;
  };

export function webSearchCases(world: WebSearchWorld): ContractCases<typeof webSearchPort> {
  if (world.live && platformConfig.APP_ENV === "production") {
    throw new Error("the web-search live suite is refused under APP_ENV=production");
  }
  /** A case of the offline world only: a live run makes its one search and nothing else. */
  const offline =
    (run: (port: WebSearchPort, offlineWorld: OfflineWorld) => Promise<void>) =>
    async (port: WebSearchPort, t: TestContext) => {
      if (world.live) return t.skip("offline only: a live run makes one search");
      await run(port, world);
    };
  /** Each input refused at the boundary, so that nothing reaches the vendor. */
  const refused = (inputs: Inputs) =>
    offline(async (port, offlineWorld) => {
      const before = offlineWorld.calls();
      for (const [label, input] of inputs) {
        const search = port.searchWeb(input as WebSearch);
        await assert.rejects(search, failsWith("web_search_input_invalid"), label);
      }
      assert.equal(offlineWorld.calls(), before, "nothing reached the vendor");
    });
  /** The vendor's next answer fails with `code`; the call after it answers the search again. */
  const failsOnce = (code: WebSearchFailure, check?: (details: Record<string, unknown>) => void) =>
    offline(async (port, offlineWorld) => {
      const { search, results } = await offlineWorld.search();
      offlineWorld.failNext(code);
      await assert.rejects(port.searchWeb(search), failsWith(code, check));
      assert.deepEqual(await port.searchWeb(search), { results }, "the next call's only");
    });

  return {
    "answers the results of the search the world names, in the port's words": async (port) => {
      if (world.live) {
        const search = await world.search();
        const { results } = await port.searchWeb(search);
        assert.ok(results.length <= search.count, "no more than the count");
        return;
      }
      const { search, results } = await world.search();
      assert.deepEqual(await port.searchWeb(search), { results });
    },
    "answers the first `count` results, no more": offline(async (port, offlineWorld) => {
      const { search, results } = await offlineWorld.search();
      assert.ok(results.length >= 2, "the world's search answers two results or more");
      assert.deepEqual(await port.searchWeb({ ...search, count: 1 }), {
        results: results.slice(0, 1),
      });
    }),
    "keeps the results on the site it is given": offline(async (port, offlineWorld) => {
      const { search, results } = await offlineWorld.onSite();
      const { site } = search;
      assert.ok(site !== undefined && results.length > 0, "the world's search names a site");
      const answer = await port.searchWeb(search);
      assert.deepEqual(answer, { results });
      assert.ok(answer.results.every(({ url }) => onSite(url, site)));
    }),
    "answers a further page, for a country and a language, with the results after the first page's":
      offline(async (port, offlineWorld) => {
        const { search, results, first } = await offlineWorld.further();
        assert.equal(search.page, 2);
        assert.ok(search.country !== undefined && search.language !== undefined);
        assert.ok(results.length > 0 && first.length > 0, "both pages hold results");
        const { page: _page, ...firstPage } = search;
        assert.deepEqual(await port.searchWeb(firstPage), { results: first });
        const answer = await port.searchWeb(search);
        assert.deepEqual(answer, { results });
        assert.ok(
          answer.results.every(({ url }) => !first.some((result) => result.url === url)),
          "page 2's results are not page 1's",
        );
      }),
    "answers no results for a search nothing matches": offline(async (port, offlineWorld) => {
      assert.deepEqual(await port.searchWeb(await offlineWorld.nothing()), { results: [] });
    }),
    "refuses a search off its form, before any call: web_search_input_invalid": refused(OFF_FORM),
    "refuses any key but the query, the site, the count, the country, the language and the page, before any call: web_search_input_invalid":
      refused(OTHER_KEYS),
    "a rate limit is web_search_rate_limited, with the seconds it asks to wait": failsOnce(
      "web_search_rate_limited",
      (details) => assert.equal(details.retryAfterSec, RETRY_AFTER_SEC),
    ),
    "the vendor's free searches or credits gone are web_search_allowance_spent": failsOnce(
      "web_search_allowance_spent",
    ),
    "a refused key is web_search_unauthorized": failsOnce("web_search_unauthorized"),
    "any other failure is web_search_provider_error, with its status": failsOnce(
      "web_search_provider_error",
      (details) => assert.equal(details.status, PROVIDER_ERROR_STATUS),
    ),
  };
}
