// The pages a found company's people are read from (README.md "Web research"; gamma-wr-060): the
// company's own site, and the page that named it. A page is read from the run's files when they are
// there (the judge kept the site as `site/<n>.json`, found by the judge queue's place of the company's
// candidate; the pick kept each page as `pages/<n>.json`, found by the queue's address), and read anew,
// through enrichment's site reader and the research page reader, when they are gone (raw/'s 72 hours).
// Every fetch refuses LinkedIn and the social networks, and robots.txt first, as the run's other reads
// do. The pages are cut as the model reads them, and the gates compare against the cut pages. Nothing
// of a page, its address or its text reaches a log, a span, a metric or the workflow's history.
import { readCompanySite } from "@whytide/enrichment";
import { settings } from "../../settings.ts";
import {
  PEOPLE_LINKS_MAX,
  PEOPLE_PAGES_MAX,
  SITE_PAGE_TEXT_CHARS,
  SITE_PAGE_TITLE_CHARS,
  SITE_TEXT_TOTAL_CHARS,
} from "./constants.ts";
import { judgeQueueKey, pageKey, queueKey, readJsonFile, siteKey } from "./files.ts";
import type { SiteFile } from "./judge-site.ts";
import { neverFetched, type QueuedPage } from "./pages.ts";
import type { PeoplePageFacts } from "./people-checks.ts";
import { readResearchPage } from "./read-page.ts";
import { fit } from "./text.ts";

/** A page read, before it is cut: its address, title, text, links and `mailto:` addresses. */
type RawPage = {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly string[];
  readonly mailto: readonly string[];
};

/** What the pages are looked for by: the found company's run, domain, candidate and naming page. */
export type PeopleWhere = {
  readonly workspaceId: string;
  /** The run that judged the company: its files hold the site and the pages. */
  readonly runId: string;
  readonly domain: string;
  readonly candidateId: string | null;
  readonly pageUrl: string;
};

/** A page's address without its query and fragment: a query may hold an id or a person's address. */
export function addressOf(address: string): string {
  const url = URL.parse(address);
  return url === null ? "" : fit(`${url.origin}${url.pathname}`, 600);
}

/**
 * The pages the company's people may be on, numbered from 1, cut: the site's, then the page that named
 * the company when it is not one of them. None for a company whose site and page cannot be read.
 */
export async function peoplePagesOf(where: PeopleWhere): Promise<PeoplePageFacts[]> {
  const site = await siteOf(where);
  const named = await namingPageOf(where);
  const seen = new Set<string>();
  const all = [...site, ...(named === null ? [] : [named])].filter((page) => {
    const key = addressOf(page.url);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return cut(all.slice(0, PEOPLE_PAGES_MAX));
}

/** The pages cut to the model's bounds: each text and title, all texts together, the links. */
function cut(pages: readonly RawPage[]): PeoplePageFacts[] {
  let room = SITE_TEXT_TOTAL_CHARS;
  const cutPages: PeoplePageFacts[] = [];
  for (const page of pages) {
    if (room <= 0) break;
    const text = fit(page.text, Math.min(SITE_PAGE_TEXT_CHARS, room));
    room -= [...text].length;
    cutPages.push({
      n: cutPages.length + 1,
      address: addressOf(page.url),
      title: fit(page.title, SITE_PAGE_TITLE_CHARS),
      text,
      links: page.links.slice(0, PEOPLE_LINKS_MAX),
      mailto: page.mailto.slice(0, PEOPLE_LINKS_MAX),
    });
  }
  return cutPages;
}

/** The site's pages from the judge's file, else read anew; none when the site cannot be read. */
async function siteOf(where: PeopleWhere): Promise<RawPage[]> {
  const { workspaceId, runId, candidateId, domain } = where;
  if (candidateId !== null) {
    const queue = (await readJsonFile(workspaceId, judgeQueueKey(runId))) as {
      candidates: string[];
    } | null;
    const place = queue === null ? -1 : queue.candidates.indexOf(candidateId);
    const filed =
      place < 0
        ? null
        : ((await readJsonFile(workspaceId, siteKey(runId, place + 1))) as SiteFile | null);
    if (filed !== null && filed.candidateId === candidateId) {
      return filed.pages.map((page) => ({ ...page, links: page.links ?? [] }));
    }
  }
  if (neverFetched(domain)) return [];
  const read = await readCompanySite(domain, () => {}, undefined, {
    maxPages: settings.SIGNALS_RESEARCH_SITE_MAX_PAGES,
    refuseHost: neverFetched,
  });
  if (!read.ok) return [];
  return read.pages.map(({ url, title, text, links, mailto }) => ({
    ...{ url, title, text, mailto },
    links: links.map(({ href }) => href),
  }));
}

/** The page that named the company, from the pick's file when the queue holds its address, else read anew. */
async function namingPageOf(where: PeopleWhere): Promise<RawPage | null> {
  const { workspaceId, runId, pageUrl } = where;
  const queue = (await readJsonFile(workspaceId, queueKey(runId))) as {
    pages: QueuedPage[];
  } | null;
  const place = queue === null ? -1 : queue.pages.findIndex((page) => page.url === pageUrl);
  if (place >= 0) {
    const filed = (await readJsonFile(workspaceId, pageKey(runId, place + 1))) as {
      url: string;
      title: string;
      text: string;
      links: { href: string }[];
      mailto: string[];
    } | null;
    if (filed !== null) {
      const { title, text, mailto } = filed;
      return { url: pageUrl, title, text, mailto, links: filed.links.map(({ href }) => href) };
    }
  }
  const answer = await readResearchPage(runId, pageUrl);
  if (answer.status !== "read") return null;
  const { page } = answer;
  const { title, text, mailto } = page;
  return { url: page.url, title, text, mailto, links: page.links.map(({ href }) => href) };
}
