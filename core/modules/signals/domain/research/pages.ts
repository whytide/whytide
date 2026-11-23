// The pages a research run reads (README.md "Web research"; gamma-wr-045), in code and pure: which
// address may be fetched at all, which host an address counts under, and the run's queue of pages, the
// source's start pages first, then the picked results, one search after another by rank, a few pages
// of one host at most. The fetch itself is the platform's reader (read-page.ts); this file decides only
// what is asked of it.
import { LINKEDIN_DOMAINS, NEVER_FETCHED_HOSTS } from "../../sources/web_research/constants.ts";
import { PAGES_PER_HOST, PAGES_QUEUE_FACTOR } from "./constants.ts";

/** A page the run lines up: its address, and the source type of the search that found it (none: a start page). */
export type QueuedPage = {
  readonly url: string;
  readonly placeId: string | null;
  /** The query whose results led to it (gamma-wr-051); none for a start page. */
  readonly queryId?: string;
};
/** A search's picked addresses, the likeliest first, with the source type of its query. */
export type PickedUrls = {
  readonly placeId: string;
  readonly urls: readonly string[];
  readonly queryId?: string;
};

const WWW = /^www\./u;
const underDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * Whether the host, lower case, is LinkedIn's or a social network's, or a subdomain of one: a host the
 * run never fetches (NEVER_FETCHED_HOSTS, LINKEDIN_DOMAINS). A trailing dot does not hide it.
 */
export function neverFetched(host: string): boolean {
  const bare = host.toLowerCase().replace(/\.+$/u, "");
  return [...LINKEDIN_DOMAINS, ...NEVER_FETCHED_HOSTS].some((domain) => underDomain(bare, domain));
}

/**
 * The address as the run keeps it: http or https, no user or password, its fragment dropped, its host
 * lower case; null for any other scheme, a form the parser refuses, or a host never fetched.
 */
export function pageUrlOf(text: string): string | null {
  const url = URL.parse(text.trim());
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (url.username !== "" || url.password !== "" || neverFetched(url.hostname)) return null;
  url.hash = "";
  return url.href;
}

/** The host an address counts under: lower case, without `www.`; one host and its `www.` are one. */
export const hostKeyOf = (url: string): string =>
  (URL.parse(url)?.host ?? "").toLowerCase().replace(WWW, "");

/**
 * The run's queue: `starts` first in their order, then the picks round by round (each search's
 * likeliest, then each one's next) so that the limit goes to the likeliest of every search. An address
 * twice, one that is no page (pageUrlOf), and a host past PAGES_PER_HOST are left out; the queue holds
 * PAGES_QUEUE_FACTOR times `limit` at most, since a page that fails does not use the limit.
 */
export function queueOf(
  starts: readonly string[],
  picks: readonly PickedUrls[],
  limit: number,
): QueuedPage[] {
  const queue: QueuedPage[] = [];
  const seen = new Set<string>();
  const perHost = new Map<string, number>();
  const room = limit * PAGES_QUEUE_FACTOR;
  const add = (text: string, placeId: string | null, queryId?: string) => {
    const url = pageUrlOf(text);
    if (url === null || queue.length >= room || seen.has(url)) return;
    const host = hostKeyOf(url);
    const onHost = perHost.get(host) ?? 0;
    if (onHost >= PAGES_PER_HOST) return;
    seen.add(url);
    perHost.set(host, onHost + 1);
    queue.push({ url, placeId, ...(queryId === undefined ? {} : { queryId }) });
  };
  for (const start of starts) add(start, null);
  const rounds = Math.max(0, ...picks.map(({ urls }) => urls.length));
  for (let round = 0; round < rounds; round += 1) {
    for (const { placeId, urls, queryId } of picks) {
      const url = urls[round];
      if (url !== undefined) add(url, placeId, queryId);
    }
  }
  return queue;
}
