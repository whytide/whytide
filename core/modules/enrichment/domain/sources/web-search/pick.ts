// Which result web-search keeps (docs/concepts.md "A company known only by name"), in code: the
// company's LinkedIn page, a linkedin.com/company/<slug> result whose title, without its
// "| LinkedIn" ending, is the name; its website, a result off NOT_A_HOMEPAGE whose host's first
// label is the name without its spaces or starts with it, or whose title starts with the name. Two
// matches that differ are `ambiguous`, none `not_found`: no guessing, since a wrong company is worse
// than none. Only the chosen page or host leaves; the results' titles and snippets never do. Pure.
import type { WebResult } from "@whytide/providers";
import {
  AMBIGUOUS,
  DOMAIN,
  LINKEDIN_ENDING,
  LINKEDIN_SITE,
  NOT_A_HOMEPAGE,
  NOT_ALPHANUMERIC,
  SLUG,
  WWW,
} from "./constants.ts";
import { cleanName, squeezed } from "./names.ts";

/** A pick: the page or the domain kept, or why none is. */
export type Picked =
  | { readonly found: string }
  | { readonly found: null; readonly outcome: typeof AMBIGUOUS | "not_found" };

const urlOf = (text: string): URL | null => {
  try {
    const url = new URL(text);
    const plain = url.port === "" && url.username === "" && url.password === "";
    return url.protocol === "https:" && plain ? url : null;
  } catch {
    return null;
  }
};

/** One kept value, or the pick's outcome for none or for more than one. */
function onlyOne(values: readonly string[]): Picked {
  const kept = [...new Set(values)];
  if (kept.length === 1) return { found: kept[0] as string };
  return { found: null, outcome: kept.length === 0 ? "not_found" : AMBIGUOUS };
}

/** The result's company page as contacts keeps it, https://linkedin.com/company/<slug>, or null. */
export function companyPageOf(text: string): string | null {
  const url = urlOf(text);
  const host = url?.hostname ?? "";
  if (url === null || (host !== LINKEDIN_SITE && !host.endsWith(`.${LINKEDIN_SITE}`))) return null;
  const [, section, slug, ...rest] = url.pathname.toLowerCase().split("/");
  const trailing = rest.length === 0 || (rest.length === 1 && rest[0] === "");
  const page = section === "company" && slug !== undefined && SLUG.test(slug) && trailing;
  return page ? `https://${LINKEDIN_SITE}/company/${slug}` : null;
}

/** The company's LinkedIn page among the results: its title, without the ending, is the name. */
export function pickLinkedinPage(name: string, results: readonly WebResult[]): Picked {
  const wanted = cleanName(name);
  const pages = results.flatMap(({ url, title }) => {
    const page = companyPageOf(url);
    const named = cleanName(title.replace(LINKEDIN_ENDING, "")) === wanted;
    return page !== null && named ? [page] : [];
  });
  return onlyOne(pages);
}

/** The result's host, lower case, without `www.`, or null for one that is no domain. */
export function domainOf(text: string): string | null {
  const host = urlOf(text)?.hostname.toLowerCase().replace(WWW, "");
  return host !== undefined && DOMAIN.test(host) ? host : null;
}

/** A social network's, a directory's, a news or a job site's host (NOT_A_HOMEPAGE). */
export function isNotAHomepage(host: string): boolean {
  const labels = host.split(".").slice(0, -1);
  return NOT_A_HOMEPAGE.some((entry) =>
    entry.includes(".") ? host === entry || host.endsWith(`.${entry}`) : labels.includes(entry),
  );
}

/**
 * The company's website among the results: a host off NOT_A_HOMEPAGE whose first label is the name
 * without its spaces or starts with it, or whose title starts with the name. A host and its own
 * subdomains are one website, kept as the shortest of them.
 */
export function pickWebsite(name: string, results: readonly WebResult[]): Picked {
  const wanted = cleanName(name);
  const label = squeezed(name);
  const hosts = results.flatMap(({ url, title }) => {
    const host = domainOf(url);
    if (host === null || isNotAHomepage(host)) return [];
    const first = (host.split(".")[0] ?? "").replace(NOT_ALPHANUMERIC, "");
    const byHost = label !== "" && first.startsWith(label);
    const heading = cleanName(title);
    const byTitle = heading === wanted || heading.startsWith(`${wanted} `);
    return byHost || byTitle ? [host] : [];
  });
  const sites = hosts.filter((host) => !hosts.some((other) => host.endsWith(`.${other}`)));
  return onlyOne(sites);
}
