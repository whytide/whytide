// Which pages the site reader reads after the home page (README "The site reader"): the home page's
// links on the same host, each once, in the caller's preference (the first link whose path has one of
// a group's words, group by group), then the navigation links in page order, then the other links in
// page order.
import type { PageLink } from "./html.ts";

/** The caller's preference: groups of path words, in their order; a link of the first group first. */
export type PreferredPages = readonly (readonly string[])[];
/** A link to a file, which is not a page. */
const FILE = /\.(?:pdf|png|jpe?g|gif|svg|webp|ico|zip|gz|mp3|mp4|xml|json|txt|css|js)$/i;
/** Longer links are left out: a stored page's address stays under the index's bound. */
export const MAX_URL = 2048;
/** The `mailto:` addresses a page gives at most (gamma-en-085), and one's characters at most. */
export const MAX_MAILTO = 50;
const MAILTO_CHARS = 254;
const MAILTO = /^mailto:/i;

const host = (url: URL) => url.hostname.replace(/^www\./, "");
/** One key per page: no fragment, no trailing slash but the root's. */
const keyOf = (url: URL) => `${url.origin}${url.pathname.replace(/(.)\/+$/, "$1")}${url.search}`;

/** `href` resolved against `home` when it is a page of the same host and port, else undefined. */
export function sameSitePage(home: URL, href: string): URL | undefined {
  if (href.length > MAX_URL) return undefined;
  const url = URL.parse(href, home);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  if (url.username !== "" || url.password !== "" || FILE.test(url.pathname)) return undefined;
  if (host(url) !== host(home) || url.port !== home.port) return undefined;
  url.hash = "";
  return url;
}

/**
 * The pages to read after `home`, at most `max`, in the preference order; `allowed` says whether
 * robots.txt lets a URL be read. The home page itself is never one of them.
 */
export function selectPages(
  home: URL,
  links: readonly PageLink[],
  max: number,
  allowed: (url: URL) => boolean,
  preferred: PreferredPages,
): URL[] {
  const seen = new Set([keyOf(home)]);
  const candidates: { url: URL; nav: boolean; words: readonly string[] }[] = [];
  for (const link of links) {
    const url = sameSitePage(home, link.href);
    if (url === undefined || seen.has(keyOf(url)) || !allowed(url)) continue;
    seen.add(keyOf(url));
    const words = url.pathname.toLowerCase().split("/").filter(Boolean);
    candidates.push({ url, nav: link.nav, words });
  }
  const picked = new Set<(typeof candidates)[number]>();
  const firsts = preferred.map((names) =>
    candidates.find((candidate) => candidate.words.some((word) => names.includes(word))),
  );
  const order = [...firsts, ...candidates.filter((c) => c.nav), ...candidates];
  for (const candidate of order) {
    if (picked.size >= max) break;
    if (candidate !== undefined) picked.add(candidate);
  }
  return [...picked].map((candidate) => candidate.url);
}

/**
 * The addresses of a page's `mailto:` links (gamma-en-085), in page order, each once: the part before
 * `?`, percent-decoded, split at commas, trimmed, lower case; at most MAX_MAILTO, none longer than an
 * address may be. Whether one is an address is the caller's to check.
 */
export function mailtoOf(links: readonly PageLink[]): string[] {
  const found = new Set<string>();
  for (const { href } of links) {
    if (!MAILTO.test(href)) continue;
    const [to = ""] = href.slice("mailto:".length).split("?");
    let decoded: string;
    try {
      decoded = decodeURIComponent(to);
    } catch {
      continue;
    }
    for (const part of decoded.split(",")) {
      const address = part.trim().toLowerCase();
      if (address === "" || address.length > MAILTO_CHARS) continue;
      found.add(address);
      if (found.size >= MAX_MAILTO) return [...found];
    }
  }
  return [...found];
}
