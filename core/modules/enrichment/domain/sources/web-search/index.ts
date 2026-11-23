// The source `web-search` (README "Sources", docs/concepts.md "A company known only by name"): a
// company known only by its name gets its LinkedIn page and its website from a web search, so that
// the sources that need a page or a domain run on them. A name that is no company makes no search.
// At most two searches, each only for a field still wanted: the name quoted on linkedin.com, then
// the name quoted with "official website", 5 results each; a query holds the name and those fixed
// words, never anything of the person. Each search is the counted search (../../web-search.ts, the
// public searchWeb): the first adapter of PROVIDER_WEB_SEARCH with room in its allowance, counted
// under `web-search/<adapter>`, one spent or failing passing it on. With none left the source ends:
// `allowance_spent` when every adapter was spent, else the last failure. pick.ts keeps a result in code, never a guess;
// only the chosen page and domain leave, stamped with the adapter that answered.
import type { WebResult, WebSearch } from "@whytide/providers";
import { type Field, NOT_FOUND } from "../../constants.ts";
import { searchWeb, type WebSearched } from "../../web-search.ts";
import { defineSource, type SourceAnswer, type SourceFacts, type SourceInput } from "../define.ts";
import {
  ALLOWANCE_SPENT,
  AMBIGUOUS,
  LINKEDIN_SITE,
  NO_ADAPTER,
  NOT_A_COMPANY,
  RESULTS,
  WEB_SEARCH,
  WEB_SEARCH_TIMEOUT_SECONDS,
  WEBSITE_WORDS,
} from "./constants.ts";
import { isNotACompany } from "./names.ts";
import { type Picked, pickLinkedinPage, pickWebsite } from "./pick.ts";

type Search = {
  readonly field: "linkedinUrl" | "domain";
  readonly request: WebSearch;
  readonly pick: (name: string, results: readonly WebResult[]) => Picked;
};

/** The searches for the fields still wanted, the page's first: the name quoted, fixed words. */
function searchesFor(name: string, wanted: readonly Field[]): Search[] {
  const quoted = `"${name.trim().replaceAll('"', "")}"`;
  const page: Search = {
    field: "linkedinUrl",
    request: { query: quoted, site: LINKEDIN_SITE, count: RESULTS },
    pick: pickLinkedinPage,
  };
  const website: Search = {
    field: "domain",
    request: { query: `${quoted} ${WEBSITE_WORDS}`, count: RESULTS },
    pick: pickWebsite,
  };
  return [page, website].filter(({ field }) => wanted.includes(field));
}

/**
 * The page and the website still wanted. Found when one search kept one, stamped with the adapter
 * that answered the first; else the end of a search with no adapter left (no second search
 * follows it), else `ambiguous` over `not_found`.
 */
async function run({ company = {}, wanted }: SourceInput): Promise<SourceAnswer> {
  const name = company.name ?? "";
  if (isNotACompany(name)) return { found: false, outcome: NOT_A_COMPANY };
  const facts: { -readonly [F in keyof SourceFacts]: SourceFacts[F] } = {};
  const picks: string[] = [];
  let provider: string | undefined;
  let ended: Exclude<WebSearched, { status: "answered" }> | undefined;
  for (const { field, request, pick } of searchesFor(name, wanted)) {
    const searched = await searchWeb(request);
    if (searched.status === "no_adapter") return { found: false, outcome: NO_ADAPTER };
    if (searched.status !== "answered") {
      ended = searched;
      break;
    }
    const picked = pick(name, searched.results);
    if (picked.found === null) picks.push(picked.outcome);
    else {
      facts[field] = picked.found;
      provider ??= searched.adapter;
    }
  }
  if (provider !== undefined) return { found: true, facts, provider };
  if (ended?.status === "spent") return { found: false, outcome: ALLOWANCE_SPENT };
  if (ended?.status === "failed") throw ended.error;
  return { found: false, outcome: picks.includes(AMBIGUOUS) ? AMBIGUOUS : NOT_FOUND };
}

export const webSearchSource = defineSource({
  name: WEB_SEARCH,
  kind: "company",
  fills: ["linkedinUrl", "domain"],
  needs: ["name"],
  activityKind: "provider",
  timeoutSeconds: WEB_SEARCH_TIMEOUT_SECONDS,
  provenance: { source: "web_search", provider: WEB_SEARCH },
  run,
});
