// Which pages the website fetch reads after the home page (README "The website fetch"): the home
// page's links on the same host, each once, in a fixed preference: about, product, pricing, customers
// or case studies (the first link whose path has one of their words), then the navigation links in
// page order, then the other links in page order.
import type { PageLink } from "./html.ts";

/** The words of a path segment that make a link one of the preferred pages, in their order. */
export const PREFERRED: readonly (readonly string[])[] = [
  ["about", "about-us", "company", "who-we-are"],
  ["product", "products", "platform", "features", "solutions"],
  ["pricing", "plans", "price"],
  ["customers", "customer-stories", "case-studies", "case-study", "stories", "testimonials"],
];
/** A link to a file, which is not a page. */
const FILE = /\.(?:pdf|png|jpe?g|gif|svg|webp|ico|zip|gz|mp3|mp4|xml|json|txt|css|js)$/i;
/** Longer links are left out: a stored page's address stays under the index's bound. */
export const MAX_URL = 2048;

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
  const preferred = PREFERRED.map((names) =>
    candidates.find((candidate) => candidate.words.some((word) => names.includes(word))),
  );
  const order = [...preferred, ...candidates.filter((c) => c.nav), ...candidates];
  for (const candidate of order) {
    if (picked.size >= max) break;
    if (candidate !== undefined) picked.add(candidate);
  }
  return [...picked].map((candidate) => candidate.url);
}
