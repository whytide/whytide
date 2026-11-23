// The company's site, read (README "The website source"): the platform's reader on
// `https://<domain>/`, at most ENRICHMENT_SITE_MAX_PAGES pages in the source's preference, robots.txt
// first; then each page whose text is under BROWSER_MIN_TEXT characters asked again of the browser
// port, when one is set. Every page the reader answers is one robots.txt allows, so the browser
// renders no other. Any answer of the browser but a rendered page with more text (browser_unavailable,
// a timeout, a block, an error status) keeps the plain page.
import { type PreferredPages, readSite, type SitePage, type SiteRead } from "@whytide/platform";
import {
  type BoundAdapter,
  browserConfig,
  browserPort,
  getAdapter,
  type RenderedPage,
} from "@whytide/providers";
import { settings } from "../../../settings.ts";
import { BROWSER_MIN_TEXT, SITE_PREFERRED, SITE_TOTAL_MS } from "./constants.ts";

type Browser = BoundAdapter<typeof browserPort>;

const https = (domain: string) => new URL(`https://${domain}/`);
let homeOf: (domain: string) => URL = https;
let browser: Promise<Browser | null> | undefined;

/** For tests (testing/): the home page of a domain, a local site's; undefined restores https. */
export function useSiteHome(next: ((domain: string) => URL) | undefined): void {
  homeOf = next ?? https;
}

/** A host (lower case) a read never requests. */
type RefuseHost = (host: string) => boolean;

/** The caller's own bounds of a site read (gamma-wr-050): the pages at most, and a host never requested. */
export type SiteReadOptions = {
  /** The pages at most, the home page included; ENRICHMENT_SITE_MAX_PAGES when absent. */
  readonly maxPages?: number;
  /** A host the read never requests, a redirect hop's too; the browser is never asked for a page it ends on. */
  readonly refuseHost?: RefuseHost;
};

/**
 * The site of `domain`, read, its short pages rendered; `beat` before each page. `preferred`, the
 * pages read first: the company source's by default, the email source's its own (gamma-en-085).
 * `options`, the caller's page limit (gamma-wr-050, a research run's) and a host it never reaches.
 */
export async function readCompanySite(
  domain: string,
  beat: () => void,
  preferred: PreferredPages = SITE_PREFERRED,
  options: SiteReadOptions = {},
): Promise<SiteRead> {
  const { maxPages = settings.ENRICHMENT_SITE_MAX_PAGES, refuseHost } = options;
  const read = await readSite(homeOf(domain), {
    ...{ maxPages, preferred, totalMs: SITE_TOTAL_MS, beat },
    ...(refuseHost === undefined ? {} : { refuseHost }),
  });
  if (!read.ok) return read;
  const pages: SitePage[] = [];
  for (const page of read.pages) {
    if (page.text.length >= BROWSER_MIN_TEXT) pages.push(page);
    else {
      beat();
      pages.push(await rendered(page, refuseHost));
    }
  }
  return { ok: true, pages };
}

/** The page as the browser renders it, when it gives more text; else the plain page. */
async function rendered(page: SitePage, refuseHost?: RefuseHost): Promise<SitePage> {
  const adapter = await browserOf();
  if (adapter === null) return page;
  let shown: RenderedPage;
  try {
    shown = await adapter.renderPage({ url: page.url });
  } catch {
    // browser_unavailable or any other code: the plain page stays.
    return page;
  }
  const { status, text } = shown;
  if (status < 200 || status >= 300 || text.length <= page.text.length) return page;
  // The rendered page moved to a host the caller never reaches: its plain page stays.
  const ended = URL.parse(shown.finalUrl)?.hostname.toLowerCase();
  if (refuseHost !== undefined && ended !== undefined && refuseHost(ended)) return page;
  const links = shown.links.map(({ href }) => ({ href, nav: false }));
  return { ...page, text, links: [...page.links, ...links] };
}

/** PROVIDER_BROWSER's adapter, loaded once; none when unset or when it cannot load. */
function browserOf(): Promise<Browser | null> {
  const selector = browserConfig.PROVIDER_BROWSER;
  if (selector === undefined) return Promise.resolve(null);
  browser ??= getAdapter(browserPort, selector).catch(() => null);
  return browser;
}
